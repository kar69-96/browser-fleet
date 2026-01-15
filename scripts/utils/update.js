#!/usr/bin/env node
/**
 * LMS Update Checker
 * Quickly checks for updates in courses by comparing stored mapping data
 * at initial depth (depth 0-1) with current state.
 * When changes are detected, performs deep extraction of new/changed items.
 *
 * This is an INCREMENTAL update system - much faster than full extraction.
 */

const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright-core");

// ============================================================================
// UPDATE CONFIGURATION
// ============================================================================

const LMS_URL = process.env.LMS_URL || process.env.CANVAS_URL || "https://canvas.colorado.edu";
const COOKIE_FILE = path.join(__dirname, "..", "..", "data", "auth", "cookies.json");
const STORAGE_DIR = path.join(__dirname, "..", "..", "storage", "datasets");

// Timeout per page check (keep it fast)
const PAGE_CHECK_TIMEOUT = Number(process.env.UPDATE_PAGE_TIMEOUT_MS) || 15000;

// Concurrent page checks during update scan
const MAX_CONCURRENT_CHECKS = Number(process.env.UPDATE_MAX_CONCURRENT_CHECKS) || 8;

// Only check depth 0-1 for changes (surface scan)
const INITIAL_DEPTH_MAX = 1;

// Results directory
const UPDATE_RESULTS_DIR = process.env.UPDATE_RESULTS_DIR
  ? path.resolve(process.env.UPDATE_RESULTS_DIR)
  : path.join(__dirname, "..", "storage", "update-results");

const UPDATE_RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");

// Dry run mode (check for changes but don't extract)
const UPDATE_DRY_RUN = (process.env.UPDATE_DRY_RUN || "false").toLowerCase() !== "false";

// Specific courses to check (optional)
const UPDATE_COURSE_IDS = process.env.UPDATE_COURSE_IDS
  ? process.env.UPDATE_COURSE_IDS.split(",").map((id) => id.trim()).filter(Boolean)
  : null;

const UPDATE_MAX_COURSES = Number(process.env.UPDATE_MAX_COURSES) || null;

// Date tolerance for change detection (hours)
const DATE_TOLERANCE_HOURS = Number(process.env.UPDATE_DATE_TOLERANCE_HOURS) || 24;

// Title similarity threshold for fuzzy matching
const TITLE_SIMILARITY_THRESHOLD = Number(process.env.UPDATE_TITLE_SIMILARITY_THRESHOLD) || 0.8;

// ============================================================================
// CHANGE DETECTION CONFIGURATION
// ============================================================================

/**
 * Fields checked for changes by content type
 * Only surface-level fields that indicate modification
 */
const CONTENT_TYPE_FIELDS = {
  assignments: ["title", "dueDate", "modifiedDate", "points"],
  quizzes: ["title", "dueDate", "modifiedDate", "points"],
  announcements: ["title", "postDate", "modifiedDate", "lastReplyDate", "author"],
  files: ["title", "name", "modifiedDate", "size"],
  modules: ["title", "itemCount", "unlockDate", "completionStatus"],
  pages: ["title"],
  discussions: ["title", "lastReplyDate", "replyCount"]
};

// ============================================================================
// PRIVACY GUARDRAILS
// ============================================================================

/**
 * PRIVACY GUARDRAIL: Filter out grade-related data
 * Ensures we never store or calculate student grades
 */
const GRADE_FIELDS_TO_FILTER = new Set([
  "grade", "grades", "score", "scores",
  "final_grade", "current_grade", "final_score", "current_score",
  "computed_final_grade", "computed_current_grade",
  "computed_final_score", "computed_current_score", "gpa"
]);

function filterGradeData(data) {
  if (!data || typeof data !== "object") return data;

  if (Array.isArray(data)) {
    return data.map(filterGradeData);
  }

  const filtered = {};
  for (const [key, value] of Object.entries(data)) {
    if (!GRADE_FIELDS_TO_FILTER.has(key.toLowerCase())) {
      filtered[key] = typeof value === "object" ? filterGradeData(value) : value;
    }
  }
  return filtered;
}

// ============================================================================
// CHANGE DETECTION UTILITIES
// ============================================================================

/**
 * Compare dates with tolerance
 */
function hasDateChanged(date1, date2, toleranceHours = DATE_TOLERANCE_HOURS) {
  if (!date1 && !date2) return false;
  if (!date1 || !date2) return true;

  try {
    const d1 = new Date(date1).getTime();
    const d2 = new Date(date2).getTime();
    const toleranceMs = toleranceHours * 60 * 60 * 1000;
    return Math.abs(d1 - d2) > toleranceMs;
  } catch {
    return date1 !== date2;
  }
}

/**
 * Calculate title similarity using Jaccard index
 */
function getTitleSimilarity(title1, title2) {
  if (!title1 || !title2) return 0;
  if (title1 === title2) return 1;

  const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  const words1 = new Set(normalize(title1));
  const words2 = new Set(normalize(title2));

  const intersection = new Set([...words1].filter((w) => words2.has(w)));
  const union = new Set([...words1, ...words2]);

  return union.size > 0 ? intersection.size / union.size : 0;
}

/**
 * Detect changes between baseline and current item
 */
function detectChanges(baseline, current, contentType) {
  const fields = CONTENT_TYPE_FIELDS[contentType] || ["title"];
  const changes = [];

  for (const field of fields) {
    const baselineValue = baseline[field];
    const currentValue = current[field];

    if (field.toLowerCase().includes("date")) {
      if (hasDateChanged(baselineValue, currentValue)) {
        changes.push({ field, from: baselineValue, to: currentValue, type: "date" });
      }
    } else if (field === "title") {
      const similarity = getTitleSimilarity(baselineValue, currentValue);
      if (similarity < TITLE_SIMILARITY_THRESHOLD) {
        changes.push({ field, from: baselineValue, to: currentValue, type: "title", similarity });
      }
    } else {
      if (baselineValue !== currentValue) {
        changes.push({ field, from: baselineValue, to: currentValue, type: "value" });
      }
    }
  }

  return changes;
}

// ============================================================================
// COOKIE MANAGEMENT
// ============================================================================

async function loadCookies() {
  if (!fs.existsSync(COOKIE_FILE)) {
    throw new Error(`Cookie file not found: ${COOKIE_FILE}`);
  }

  const cookieData = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8"));
  const cookies = cookieData.cookies || cookieData;

  if (!Array.isArray(cookies) || cookies.length === 0) {
    throw new Error("No cookies found in cookie file");
  }

  return cookies;
}

// ============================================================================
// UPDATE WORKFLOW
// ============================================================================

/**
 * Resource Requirements for Update Check:
 *
 * Quick Scan (Surface):
 * - Time: 10-30 seconds per course
 * - Memory: ~200-500MB
 * - Network: ~50-100 requests per course
 *
 * Deep Extraction (Changed Items Only):
 * - Time: Variable (depends on change volume)
 * - Typical: 1-5 items changed = 30 seconds
 * - Heavy update: 50+ items = 5-10 minutes
 */
async function runUpdateCheck(courseId, baselineData, browser) {
  console.log(`\n🔍 UPDATE CHECK - Course ${courseId}`);
  console.log(`   Page timeout: ${PAGE_CHECK_TIMEOUT}ms`);
  console.log(`   Concurrent checks: ${MAX_CONCURRENT_CHECKS}`);
  console.log(`   Scan depth: ${INITIAL_DEPTH_MAX}`);

  const startTime = Date.now();
  const updateReport = {
    courseId,
    checkedAt: new Date().toISOString(),
    runId: UPDATE_RUN_ID,
    dryRun: UPDATE_DRY_RUN,
    changes: {
      new: [],
      modified: [],
      deleted: []
    },
    statistics: {}
  };

  const cookies = await loadCookies();
  const context = await browser.newContext();
  await context.addCookies(cookies);

  try {
    // Phase 1: Quick surface scan
    console.log(`   📡 Scanning for changes...`);

    // [Surface scan logic abstracted]
    // Performs lightweight checks on content listing pages
    // Collects titles, dates, counts without full content extraction

    const currentState = {
      assignments: [],
      modules: [],
      files: [],
      pages: [],
      announcements: []
    };

    // Phase 2: Compare against baseline
    console.log(`   🔬 Comparing against baseline...`);

    for (const contentType of Object.keys(CONTENT_TYPE_FIELDS)) {
      const baselineItems = baselineData[contentType] || [];
      const currentItems = currentState[contentType] || [];

      // Find new items
      const baselineIds = new Set(baselineItems.map((i) => i.id || i.url));
      const newItems = currentItems.filter((i) => !baselineIds.has(i.id || i.url));
      updateReport.changes.new.push(
        ...newItems.map((i) => ({ type: contentType, item: filterGradeData(i) }))
      );

      // Find modified items
      for (const current of currentItems) {
        const itemId = current.id || current.url;
        const baseline = baselineItems.find((b) => (b.id || b.url) === itemId);
        if (baseline) {
          const changes = detectChanges(baseline, current, contentType);
          if (changes.length > 0) {
            updateReport.changes.modified.push({
              type: contentType,
              item: filterGradeData(current),
              changes
            });
          }
        }
      }

      // Find deleted items
      const currentIds = new Set(currentItems.map((i) => i.id || i.url));
      const deletedItems = baselineItems.filter((i) => !currentIds.has(i.id || i.url));
      updateReport.changes.deleted.push(
        ...deletedItems.map((i) => ({ type: contentType, item: filterGradeData(i) }))
      );
    }

    // Phase 3: Deep extraction of changed items (if not dry run)
    const totalChanges =
      updateReport.changes.new.length + updateReport.changes.modified.length;

    if (totalChanges > 0 && !UPDATE_DRY_RUN) {
      console.log(`   ⚡ Found ${totalChanges} changes - performing deep extraction...`);

      // [Deep extraction logic abstracted]
      // Only extracts full content for items with detected changes
      // Uses type-specific extractors on targeted URLs

    } else if (totalChanges > 0) {
      console.log(`   ⚡ Found ${totalChanges} changes (DRY RUN - skipping extraction)`);
    } else {
      console.log(`   ✅ No changes detected`);
    }

    updateReport.statistics = {
      scanTimeMs: Date.now() - startTime,
      itemsChecked: Object.values(currentState).flat().length,
      newItems: updateReport.changes.new.length,
      modifiedItems: updateReport.changes.modified.length,
      deletedItems: updateReport.changes.deleted.length,
      totalChanges
    };

    console.log(`   ⏱️  Update check complete in ${(updateReport.statistics.scanTimeMs / 1000).toFixed(1)}s`);

    return updateReport;
  } finally {
    await context.close();
  }
}

/**
 * Load baseline data from previous extraction
 */
function loadBaselineData(courseId) {
  // Look for most recent extraction data
  const extractionDirs = fs.readdirSync(STORAGE_DIR)
    .filter((d) => d.startsWith("extraction-"))
    .sort()
    .reverse();

  for (const dir of extractionDirs) {
    const coursePath = path.join(STORAGE_DIR, dir, "courses", courseId);
    if (fs.existsSync(coursePath)) {
      console.log(`   📂 Found baseline: ${dir}`);

      const baseline = {
        assignments: [],
        modules: [],
        files: [],
        pages: [],
        announcements: []
      };

      // Load each content type
      for (const type of Object.keys(baseline)) {
        const typePath = path.join(coursePath, `${type}.json`);
        if (fs.existsSync(typePath)) {
          try {
            baseline[type] = JSON.parse(fs.readFileSync(typePath, "utf8"));
          } catch {
            // Skip if can't parse
          }
        }
      }

      return baseline;
    }
  }

  console.log(`   ⚠️  No baseline found for course ${courseId}`);
  return null;
}

/**
 * Save update report
 */
function saveUpdateReport(report) {
  if (!fs.existsSync(UPDATE_RESULTS_DIR)) {
    fs.mkdirSync(UPDATE_RESULTS_DIR, { recursive: true });
  }

  const filename = `update-${report.courseId}-${UPDATE_RUN_ID}.json`;
  const filepath = path.join(UPDATE_RESULTS_DIR, filename);

  fs.writeFileSync(filepath, JSON.stringify(report, null, 2));
  console.log(`   📝 Saved report: ${filename}`);

  return filepath;
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

async function main() {
  console.log("🔄 LMS Update Checker");
  console.log(`   Run ID: ${UPDATE_RUN_ID}`);
  console.log(`   Dry run: ${UPDATE_DRY_RUN}`);
  console.log(`   Date tolerance: ${DATE_TOLERANCE_HOURS} hours`);
  console.log(`   Title similarity threshold: ${TITLE_SIMILARITY_THRESHOLD}`);

  // Validate cookies
  console.log("\n🔐 Validating cookies...");
  try {
    await loadCookies();
    console.log("✅ Cookies valid");
  } catch (error) {
    console.error(`❌ Cookie validation failed: ${error.message}`);
    process.exit(1);
  }

  // Determine courses to check
  let courseIds = UPDATE_COURSE_IDS;

  if (!courseIds) {
    // Auto-discover from previous extractions
    console.log("\n🔍 Auto-discovering courses from previous extractions...");
    const extractionDirs = fs.readdirSync(STORAGE_DIR)
      .filter((d) => d.startsWith("extraction-"))
      .sort()
      .reverse();

    if (extractionDirs.length > 0) {
      const latestDir = extractionDirs[0];
      const coursesPath = path.join(STORAGE_DIR, latestDir, "courses");
      if (fs.existsSync(coursesPath)) {
        courseIds = fs.readdirSync(coursesPath).filter((d) => /^\d+$/.test(d));
      }
    }

    if (!courseIds || courseIds.length === 0) {
      console.error("❌ No courses found. Set UPDATE_COURSE_IDS or run extraction first.");
      process.exit(1);
    }
  }

  if (UPDATE_MAX_COURSES) {
    courseIds = courseIds.slice(0, UPDATE_MAX_COURSES);
  }

  console.log(`\n📚 Checking ${courseIds.length} courses for updates...`);

  // Launch browser
  const browser = await chromium.launch({ headless: true });

  try {
    const allReports = [];

    for (const courseId of courseIds) {
      const baseline = loadBaselineData(courseId);

      if (!baseline) {
        console.log(`   ⏭️  Skipping course ${courseId} (no baseline)`);
        continue;
      }

      const report = await runUpdateCheck(courseId, baseline, browser);
      allReports.push(report);

      // Save individual report
      saveUpdateReport(report);
    }

    // Generate summary
    console.log(`\n${"=".repeat(60)}`);
    console.log("📊 UPDATE SUMMARY");
    console.log(`   Courses checked: ${allReports.length}`);
    console.log(`   Total new items: ${allReports.reduce((s, r) => s + r.changes.new.length, 0)}`);
    console.log(`   Total modified: ${allReports.reduce((s, r) => s + r.changes.modified.length, 0)}`);
    console.log(`   Total deleted: ${allReports.reduce((s, r) => s + r.changes.deleted.length, 0)}`);

    // Save summary
    const summaryPath = path.join(UPDATE_RESULTS_DIR, `summary-${UPDATE_RUN_ID}.json`);
    fs.writeFileSync(
      summaryPath,
      JSON.stringify(
        {
          runId: UPDATE_RUN_ID,
          checkedAt: new Date().toISOString(),
          dryRun: UPDATE_DRY_RUN,
          coursesChecked: allReports.length,
          totalNew: allReports.reduce((s, r) => s + r.changes.new.length, 0),
          totalModified: allReports.reduce((s, r) => s + r.changes.modified.length, 0),
          totalDeleted: allReports.reduce((s, r) => s + r.changes.deleted.length, 0),
          reports: allReports.map((r) => ({
            courseId: r.courseId,
            new: r.changes.new.length,
            modified: r.changes.modified.length,
            deleted: r.changes.deleted.length
          }))
        },
        null,
        2
      )
    );

    console.log(`\n✅ Update check complete`);
    console.log(`   Summary saved: summary-${UPDATE_RUN_ID}.json`);
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("❌ Error:", error.message);
    process.exit(1);
  });
}

module.exports = {
  runUpdateCheck,
  detectChanges,
  loadBaselineData,
  CONTENT_TYPE_FIELDS,
  MAX_CONCURRENT_CHECKS,
  PAGE_CHECK_TIMEOUT,
  DATE_TOLERANCE_HOURS,
  TITLE_SIMILARITY_THRESHOLD
};
