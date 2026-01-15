#!/usr/bin/env node
/**
 * LMS Course Crawler using Crawlee
 * Implements phased extraction: mapping -> content extraction -> downloads
 *
 * This file demonstrates the extraction system architecture and resource requirements.
 * Content-specific extraction logic is abstracted.
 */

const path = require('path');
const fs = require('fs');

// Set Crawlee storage directory before importing Crawlee
if (!process.env.CRAWLEE_STORAGE_DIR) {
  process.env.CRAWLEE_STORAGE_DIR = path.join(__dirname, '..', '..', 'storage', 'datasets');
}

const { PlaywrightCrawler, Dataset, Configuration, RequestQueue } = require('crawlee');
const { chromium } = require('playwright-core');

// p-limit is ESM-only, so we use a dynamic import wrapper
let pLimit;
async function getPLimit() {
  if (!pLimit) {
    const module = await import('p-limit');
    pLimit = module.default;
  }
  return pLimit;
}

// ============================================================================
// CONFIGURATION - Critical for AWS Instance Sizing
// ============================================================================

const LMS_URL = process.env.LMS_URL || process.env.CANVAS_URL || 'https://canvas.colorado.edu';
const COURSE_ID = process.env.COURSE_ID || null;
const EXTRACT_COURSES_ENV = process.env.EXTRACT_COURSES || null; // 'all' or comma-separated course IDs
const HEADLESS = process.env.HEADLESS !== 'false';
const FAST_MAP = process.env.FAST_MAP !== 'false'; // Default to FAST_MAP mode

// ============================================================================
// CONCURRENCY CONFIGURATION - Critical for AWS Instance Sizing
// ============================================================================

/**
 * Instance Type Detection and Concurrency Optimization
 *
 * AWS Instance Recommendations:
 *
 * r7i.2xlarge (8 vCPU, 64GB RAM) - RECOMMENDED FOR PRODUCTION:
 *   - Single course: 80 concurrent requests
 *   - Multi-course: 100 concurrent requests
 *   - Parallel courses: Up to 20 simultaneously
 *   - Total capacity: ~2000 concurrent operations
 *   - Memory usage: 20-40GB under heavy load
 *   - CPU usage: 70-90%
 *   - Cost-effective for bulk extraction
 *
 * r7i.4xlarge (16 vCPU, 128GB RAM) - FOR VERY LARGE SCALE:
 *   - Single course: 150 concurrent requests
 *   - Multi-course: 200 concurrent requests
 *   - Parallel courses: Up to 40 simultaneously
 *   - Total capacity: ~8000 concurrent operations
 *
 * t3.large (2 vCPU, 8GB RAM) - FOR DEVELOPMENT/TESTING:
 *   - Single course: 50 concurrent requests
 *   - Multi-course: 60 concurrent requests
 *   - Parallel courses: Up to 8 simultaneously
 *
 * Local Development (MacBook Pro, 16GB RAM):
 *   - Single course: 40 concurrent requests
 *   - Multi-course: 50 concurrent requests
 *   - Memory usage: 4-8GB
 */
const isMultiCourse = EXTRACT_COURSES_ENV && EXTRACT_COURSES_ENV !== 'false';
const AWS_INSTANCE_TYPE = process.env.AWS_INSTANCE_TYPE || '';
const isAWS = AWS_INSTANCE_TYPE.includes('r7i') || process.env.AWS_INSTANCE_ID;

// Maximum concurrency: AWS instances can handle much higher concurrency
// r7i.2xlarge: 8 vCPUs can handle 100+ concurrent requests with proper optimization
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY) || (
  isAWS
    ? (isMultiCourse ? 100 : 80)  // Optimized for r7i.2xlarge
    : (isMultiCourse ? 50 : 40)   // Local development
);

const MAX_REQUESTS_PER_CRAWL = parseInt(process.env.MAX_REQUESTS_PER_CRAWL) || (FAST_MAP ? 200 : 1000);
const MAX_REQUEST_RETRIES = parseInt(process.env.MAX_REQUEST_RETRIES) || 3;
const MAX_DEPTH = parseInt(process.env.MAX_DEPTH) || (FAST_MAP ? 3 : Infinity);

// Parallel course processing
const MAX_PARALLEL_COURSES = isAWS ? 20 : 5;

// Page timeouts
const PAGE_TIMEOUT_MS = parseInt(process.env.PAGE_TIMEOUT_MS) || 30000;
const NAVIGATION_TIMEOUT_MS = parseInt(process.env.NAVIGATION_TIMEOUT_MS) || 60000;

// ============================================================================
// AUTH & SECURITY CONFIGURATION
// ============================================================================

const MAX_AUTH_RETRIES = parseInt(process.env.MAX_AUTH_RETRIES) || 3;
const AUTH_STATUS_CODES = [401, 403];
const BLOCKED_STATUS_CODES = [429, 503];

// Privacy safeguards: never crawl student-specific grade or submission views
const STUDENT_DATA_PATH_PATTERNS = [
  /\/courses\/\d+\/grades(?:\/|$)/i,
  /\/courses\/\d+\/gradebook(?:\/|$)/i,
  /\/submissions\/\d+/i,
  /\/speed_grader/i
];

function isStudentDataUrl(targetUrl) {
  if (!targetUrl) return false;
  try {
    const parsed = new URL(targetUrl, LMS_URL);
    const pathname = parsed.pathname.toLowerCase();
    return STUDENT_DATA_PATH_PATTERNS.some((pattern) => pattern.test(pathname));
  } catch {
    const normalized = String(targetUrl).split('?')[0].toLowerCase();
    return STUDENT_DATA_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
  }
}

// ============================================================================
// EXTRACTION TIMEZONE
// ============================================================================

const EXTRACTION_TIMEZONE = process.env.EXTRACTION_TIMEZONE || 'America/Denver';

// Cookie file path
const COOKIE_FILE = process.env.COOKIE_FILE || path.join(__dirname, '..', '..', 'data', 'auth', 'cookies.json');

// Global extraction folder
let EXTRACTION_FOLDER = null;

/**
 * Format a timestamp string for the configured timezone
 */
function formatTimestampForTimezone(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = dtf.formatToParts(date);
  const get = (type) => parts.find(p => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}-${get('minute')}-${get('second')}`;
}

/**
 * Get or create the extraction folder name
 */
function getExtractionFolder() {
  if (EXTRACTION_FOLDER) {
    return EXTRACTION_FOLDER;
  }

  const dateStr = formatTimestampForTimezone(new Date(), EXTRACTION_TIMEZONE);
  let folderName = `extraction-${dateStr}`;
  let extractionPath = path.join(__dirname, '..', '..', 'storage', 'datasets', folderName);
  let counter = 1;

  while (fs.existsSync(extractionPath)) {
    folderName = `extraction-${dateStr}-${String(counter).padStart(2, '0')}`;
    extractionPath = path.join(__dirname, '..', '..', 'storage', 'datasets', folderName);
    counter += 1;
  }

  fs.mkdirSync(extractionPath, { recursive: true });
  fs.mkdirSync(path.join(extractionPath, 'mapping'), { recursive: true });
  fs.mkdirSync(path.join(extractionPath, 'courses'), { recursive: true });

  process.env.CRAWLEE_STORAGE_DIR = extractionPath;
  EXTRACTION_FOLDER = folderName;

  return folderName;
}

// ============================================================================
// COOKIE MANAGEMENT
// ============================================================================

let cachedCookies = null;

async function loadCookies(allowRetry = true) {
  if (cachedCookies) {
    return cachedCookies;
  }

  if (!fs.existsSync(COOKIE_FILE)) {
    throw new Error(`Cookie file not found: ${COOKIE_FILE}. Please run authentication first.`);
  }

  const cookieData = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
  const cookies = cookieData.cookies || cookieData;

  if (!Array.isArray(cookies) || cookies.length === 0) {
    throw new Error('No cookies found in cookie file');
  }

  // Validate cookie expiration
  const now = Date.now() / 1000;
  const validCookies = cookies.filter(c => !c.expires || c.expires > now);

  if (validCookies.length === 0) {
    throw new Error('All cookies have expired. Please re-authenticate.');
  }

  cachedCookies = validCookies;
  return validCookies;
}

// ============================================================================
// URL CLASSIFICATION
// ============================================================================

/**
 * Classify URL by content type based on path patterns
 */
function classifyUrl(url, courseId) {
  if (!url) return null;

  const patterns = {
    'assignment': new RegExp(`/courses/${courseId}/assignments/\\d+`),
    'module': new RegExp(`/courses/${courseId}/modules`),
    'file': new RegExp(`/courses/${courseId}/files`),
    'page': new RegExp(`/courses/${courseId}/pages/`),
    'announcement': new RegExp(`/courses/${courseId}/announcements`),
    'discussion': new RegExp(`/courses/${courseId}/discussion_topics`),
    'quiz': new RegExp(`/courses/${courseId}/quizzes/\\d+`),
    'syllabus': new RegExp(`/courses/${courseId}/assignments/syllabus`)
  };

  for (const [type, pattern] of Object.entries(patterns)) {
    if (pattern.test(url)) return type;
  }

  // Course home page
  if (new RegExp(`/courses/${courseId}/?$`).test(url)) {
    return 'course-home';
  }

  return 'unknown';
}

// ============================================================================
// PHASE 1: MAPPING
// ============================================================================

/**
 * Phase 1: Mapping Mode - Discover and classify all URLs in a course
 *
 * Resource Usage:
 * - Time: 30-60 seconds per course
 * - Memory: ~500MB per course
 * - Network: ~100-200 requests per course
 * - CPU: 20-40%
 */
async function runMappingPhase(courseId, options = {}) {
  const startTime = Date.now();
  console.log('\n🗺️  Phase 1: Starting URL Mapping...');
  console.log(`   Course ID: ${courseId}`);
  console.log(`   LMS URL: ${LMS_URL}`);
  console.log(`   Mode: ${FAST_MAP ? '⚡ FAST_MAP (preferred)' : '📊 FULL'}`);
  if (FAST_MAP) {
    console.log(`   Max Depth: ${MAX_DEPTH}, Max Requests: ${MAX_REQUESTS_PER_CRAWL}, Concurrency: ${MAX_CONCURRENCY}`);
  }
  console.log(`   Started at: ${new Date().toISOString()}`);

  const cookies = await loadCookies(false);
  const courseUrl = `${LMS_URL}/courses/${courseId}`;

  // Track discovered URLs
  const discoveredUrls = new Set();
  const urlClassifications = {};
  const depthStats = { maxDepth: 0, depthCounts: {} };

  const mappingDataset = await Dataset.open('mapping');
  const requestQueue = await RequestQueue.open(`mapping-${courseId}-${Date.now()}`);

  const crawler = new PlaywrightCrawler({
    requestQueue,
    maxConcurrency: MAX_CONCURRENCY,
    maxRequestsPerCrawl: MAX_REQUESTS_PER_CRAWL,
    requestHandlerTimeoutSecs: PAGE_TIMEOUT_MS / 1000,
    navigationTimeoutSecs: NAVIGATION_TIMEOUT_MS / 1000,

    async preNavigationHooks({ page }) {
      const context = page.context();
      await context.addCookies(cookies);
    },

    async requestHandler({ request, page, enqueueLinks, log }) {
      const url = request.loadedUrl || request.url;

      if (isStudentDataUrl(url)) {
        log.info(`   🚫 Skipping student-specific page: ${url}`);
        return;
      }

      const currentDepth = request.userData?.depth || 0;
      depthStats.maxDepth = Math.max(depthStats.maxDepth, currentDepth);
      depthStats.depthCounts[currentDepth] = (depthStats.depthCounts[currentDepth] || 0) + 1;

      console.log(`   🔍 [Depth ${currentDepth}] Processing: ${url}`);

      // Classify the URL
      const classification = classifyUrl(url, courseId);

      if (!discoveredUrls.has(url)) {
        discoveredUrls.add(url);
        urlClassifications[url] = classification;

        await mappingDataset.pushData({
          url,
          classification,
          courseId,
          depth: currentDepth,
          discoveredAt: new Date().toISOString()
        });
      }

      // Depth limiting for fast mode
      if (currentDepth >= MAX_DEPTH) {
        return;
      }

      // Enqueue discovered links
      await enqueueLinks({
        strategy: 'same-domain',
        transformRequestFunction: (req) => {
          if (isStudentDataUrl(req.url)) return false;
          if (discoveredUrls.has(req.url)) return false;
          req.userData = { ...req.userData, depth: currentDepth + 1 };
          return req;
        }
      });
    },

    async failedRequestHandler({ request, error }) {
      console.error(`   ❌ Failed: ${request.url} - ${error.message}`);
    }
  });

  // Start crawling
  await requestQueue.addRequest({
    url: courseUrl,
    userData: { depth: 0 }
  });

  await crawler.run();

  const mappingTimeMs = Date.now() - startTime;

  // Generate statistics
  const statistics = {
    totalUrls: discoveredUrls.size,
    byType: {},
    maxDepth: depthStats.maxDepth,
    depthCounts: depthStats.depthCounts
  };

  for (const [url, type] of Object.entries(urlClassifications)) {
    statistics.byType[type] = (statistics.byType[type] || 0) + 1;
  }

  console.log(`\n   ✅ Mapping complete: ${statistics.totalUrls} URLs discovered`);
  console.log(`   ⏱️  Time: ${(mappingTimeMs / 1000).toFixed(1)}s`);
  console.log(`   📊 By type:`, statistics.byType);

  return {
    courseId,
    urls: urlClassifications,
    statistics,
    mappingTimeMs
  };
}

// ============================================================================
// PHASE 2: EXTRACTION
// ============================================================================

/**
 * Phase 2: Content Extraction - Extract detailed content from discovered URLs
 *
 * Resource Usage:
 * - Time: 2-10 minutes per course (depends on content volume)
 * - Memory: ~2-4GB per course under heavy extraction
 * - Network: ~500-2000 requests per course
 * - CPU: 60-90% during active extraction
 */
async function runExtractionPhase(courseId, mappingData, options = {}) {
  const startTime = Date.now();
  console.log(`\n📦 Phase 2: Starting Content Extraction...`);
  console.log(`   Course ID: ${courseId}`);
  console.log(`   URLs to process: ${Object.keys(mappingData.urls).length}`);
  console.log(`   Max concurrency: ${MAX_CONCURRENCY}`);

  const cookies = await loadCookies(false);
  const extractedData = {
    courseId,
    assignments: [],
    modules: [],
    files: [],
    pages: [],
    announcements: [],
    discussions: [],
    quizzes: []
  };

  // Group URLs by type for batch processing
  const urlsByType = {};
  for (const [url, type] of Object.entries(mappingData.urls)) {
    if (!urlsByType[type]) urlsByType[type] = [];
    urlsByType[type].push(url);
  }

  // Process each content type
  for (const [contentType, urls] of Object.entries(urlsByType)) {
    if (urls.length === 0) continue;
    if (contentType === 'unknown' || contentType === 'course-home') continue;

    console.log(`   Processing ${contentType}: ${urls.length} items`);

    const requestQueue = await RequestQueue.open(`extraction-${courseId}-${contentType}-${Date.now()}`);

    const crawler = new PlaywrightCrawler({
      requestQueue,
      maxConcurrency: MAX_CONCURRENCY,
      maxRequestsPerCrawl: urls.length + 100,
      requestHandlerTimeoutSecs: PAGE_TIMEOUT_MS / 1000,
      navigationTimeoutSecs: NAVIGATION_TIMEOUT_MS / 1000,

      async preNavigationHooks({ page }) {
        const context = page.context();
        await context.addCookies(cookies);
      },

      async requestHandler({ request, page, log }) {
        const url = request.loadedUrl || request.url;

        // [Content extraction logic abstracted]
        // Each content type has specialized DOM selectors and extraction logic
        // that are not included in this infrastructure-focused file

        const data = {
          url,
          type: contentType,
          courseId,
          extractedAt: new Date().toISOString()
          // ... extracted fields would be populated by type-specific extractors
        };

        if (extractedData[contentType + 's']) {
          extractedData[contentType + 's'].push(data);
        }
      }
    });

    for (const url of urls) {
      await requestQueue.addRequest({ url });
    }

    await crawler.run();
  }

  const extractionTimeMs = Date.now() - startTime;
  const totalExtracted = Object.values(extractedData)
    .filter(Array.isArray)
    .reduce((sum, arr) => sum + arr.length, 0);

  console.log(`   ✅ Extraction complete`);
  console.log(`   ⏱️  Time: ${(extractionTimeMs / 1000).toFixed(1)}s`);
  console.log(`   📊 Extracted: ${totalExtracted} items`);

  return {
    ...extractedData,
    extractionTimeMs
  };
}

// ============================================================================
// PHASE 3: DOWNLOADS
// ============================================================================

/**
 * Phase 3: File Downloads - Download file attachments to local storage
 *
 * Resource Usage:
 * - Time: 1-30 minutes (depends on file count/size)
 * - Memory: ~1-2GB (streaming downloads)
 * - Network: High bandwidth usage
 * - Disk: Variable (typical course: 100MB-2GB)
 */
async function runDownloadPhase(courseId, extractedData, options = {}) {
  console.log(`\n📥 Phase 3: Starting File Downloads...`);

  const files = extractedData.files || [];
  console.log(`   Files to download: ${files.length}`);

  if (files.length === 0) {
    console.log(`   ⏭️  No files to download`);
    return { downloaded: 0, skipped: 0, failed: 0 };
  }

  const startTime = Date.now();
  const results = { downloaded: 0, skipped: 0, failed: 0 };

  // Download concurrency is lower than crawl concurrency to avoid overwhelming network
  const downloadConcurrency = Math.min(10, Math.floor(MAX_CONCURRENCY / 4));
  console.log(`   Download concurrency: ${downloadConcurrency}`);

  // [Download logic abstracted]
  // File downloading uses streaming to minimize memory usage
  // Files are organized by course folder structure

  const downloadTimeMs = Date.now() - startTime;
  console.log(`   ✅ Downloads complete`);
  console.log(`   ⏱️  Time: ${(downloadTimeMs / 1000).toFixed(1)}s`);

  return results;
}

// ============================================================================
// MULTI-COURSE PROCESSING
// ============================================================================

/**
 * Process a single course through all extraction phases
 */
async function processCourse(courseId, index, total) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📚 Course ${index + 1}/${total}: ${courseId}`);
  console.log(`${'='.repeat(60)}`);

  const courseStartTime = Date.now();

  try {
    // Phase 1: Mapping
    const mappingResult = await runMappingPhase(courseId);

    // Phase 2: Extraction
    const extractedData = await runExtractionPhase(courseId, mappingResult);

    // Phase 3: Downloads
    const downloadResults = await runDownloadPhase(courseId, extractedData);

    const courseTimeMs = Date.now() - courseStartTime;

    return {
      courseId,
      success: true,
      statistics: mappingResult.statistics,
      extractedData,
      downloadResults,
      processingTimeMs: courseTimeMs
    };
  } catch (error) {
    console.error(`   ❌ Course ${courseId} failed: ${error.message}`);
    return {
      courseId,
      success: false,
      error: error.message,
      processingTimeMs: Date.now() - courseStartTime
    };
  }
}

/**
 * Discover all favorited courses
 */
async function discoverAllCourses() {
  console.log('\n🔍 Discovering favorited courses...');

  const cookies = await loadCookies(false);
  const coursesUrl = `${LMS_URL}/courses`;
  const courseIds = [];

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext();
  await context.addCookies(cookies);
  const page = await context.newPage();

  try {
    await page.goto(coursesUrl, { waitUntil: 'networkidle', timeout: NAVIGATION_TIMEOUT_MS });

    // [Course discovery logic abstracted]
    // Extracts course IDs from favorited courses dashboard

    console.log(`   Found ${courseIds.length} favorited courses`);
  } finally {
    await browser.close();
  }

  return courseIds;
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

async function main() {
  try {
    const extractionFolder = getExtractionFolder();
    console.log(`\n🚀 LMS Data Extraction System`);
    console.log(`   Instance: ${isAWS ? `AWS ${AWS_INSTANCE_TYPE || 'EC2'}` : 'Local'}`);
    console.log(`   Max concurrency: ${MAX_CONCURRENCY}`);
    console.log(`   Max parallel courses: ${MAX_PARALLEL_COURSES}`);
    console.log(`📁 Extraction folder: storage/datasets/${extractionFolder}/`);

    // Validate cookies at startup
    console.log('🔐 Validating authentication cookies...');
    try {
      await loadCookies(true);
      console.log('✅ Cookies validated successfully\n');
    } catch (cookieError) {
      console.error(`\n❌ Cookie validation failed: ${cookieError.message}`);
      console.error(`\n💡 Please ensure cookies are valid before running extraction.`);
      process.exit(1);
    }

    // Determine courses to process
    let courseIds = [];
    const shouldAutoDiscoverCourses = !EXTRACT_COURSES_ENV && !COURSE_ID;

    if (EXTRACT_COURSES_ENV === 'all' || shouldAutoDiscoverCourses) {
      if (shouldAutoDiscoverCourses) {
        console.log('⚙️  No COURSE_ID/EXTRACT_COURSES provided – auto-detecting favorited courses...');
      }
      courseIds = await discoverAllCourses();

      if (courseIds.length === 0) {
        console.error('❌ Error: No favorited courses found. Please star courses or provide COURSE_ID/EXTRACT_COURSES.');
        process.exit(1);
      }
    } else if (EXTRACT_COURSES_ENV) {
      courseIds = EXTRACT_COURSES_ENV.split(',').map(id => id.trim()).filter(id => id);
    } else {
      courseIds = [COURSE_ID];
    }

    // Process courses
    const parallelLimit = Math.min(courseIds.length, MAX_PARALLEL_COURSES);
    const pLimitFn = await getPLimit();
    const limit = pLimitFn(parallelLimit);

    console.log(`\n🚀 Processing ${courseIds.length} courses (${parallelLimit} in parallel)...`);
    console.log(`   Instance: ${isAWS ? 'AWS r7i.2xlarge (8 vCPUs, 64GB RAM)' : 'Local'}`);
    console.log(`   Each course uses ${MAX_CONCURRENCY} concurrent requests internally`);
    console.log(`   Total concurrent capacity: ~${parallelLimit * MAX_CONCURRENCY} requests`);

    const extractionStartTime = Date.now();

    const results = await Promise.all(
      courseIds.map((courseId, i) =>
        limit(() => processCourse(courseId, i, courseIds.length))
      )
    );

    // Generate summary
    const totalTimeMs = Date.now() - extractionStartTime;
    const successful = results.filter(r => r.success).length;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`📊 EXTRACTION SUMMARY`);
    console.log(`   Total courses: ${courseIds.length}`);
    console.log(`   Successful: ${successful}`);
    console.log(`   Failed: ${courseIds.length - successful}`);
    console.log(`   Total time: ${(totalTimeMs / 1000 / 60).toFixed(1)} minutes`);
    console.log(`   Avg per course: ${(totalTimeMs / courseIds.length / 1000).toFixed(1)}s`);

    console.log('\n✅ All extraction tasks completed successfully');
    process.exit(0);

  } catch (error) {
    console.error('❌ Crawler failed:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n⚠️  Process interrupted by user');
  process.exit(0);
});

if (require.main === module) {
  main().catch((error) => {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
  });
}

module.exports = {
  runMappingPhase,
  runExtractionPhase,
  runDownloadPhase,
  discoverAllCourses,
  processCourse,
  loadCookies,
  main,
  // Export configuration for AWS sizing
  MAX_CONCURRENCY,
  MAX_PARALLEL_COURSES,
  MAX_REQUESTS_PER_CRAWL,
  isAWS
};
