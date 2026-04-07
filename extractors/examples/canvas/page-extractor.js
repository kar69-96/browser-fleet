/**
 * Lightweight Page Extractor for Updates
 * Extracts page content from Canvas
 * Optimized for speed - focuses on key fields for change detection
 */

/**
 * Extracts page data from a Canvas page
 * @param {Object} page - Playwright page object
 * @param {string} url - The page URL
 * @returns {Promise<Object>} - Page data object
 */
async function extractPage(page, url) {
  try {
    const courseIdMatch = url.match(/\/courses\/(\d+)/);
    const courseId = courseIdMatch ? courseIdMatch[1] : null;
    const pageSlugMatch = url.match(/\/pages\/([^\/\?]+)/);
    const pageSlug = pageSlugMatch ? decodeURIComponent(pageSlugMatch[1]) : null;

    const pageData = {
      pageSlug,
      courseId,
      url,
      extractedAt: new Date().toISOString(),
    };

    // Wait for content to load
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page.waitForSelector('h1, h2, .page-title, .user_content', { timeout: 3000 }).catch(() => {});

    // Extract all data in single evaluate
    const data = await page.evaluate(() => {
      const result = {};

      // Title
      const titleSelectors = ['h1', 'h2', '.page-title', '[data-testid="page-title"]'];
      for (const sel of titleSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const text = el.textContent.trim();
          if (text && text.length > 0 && !text.includes('Loading')) {
            result.title = text;
            break;
          }
        }
      }

      // Content
      const contentSelectors = ['.user_content', '.page-content', '.wiki-page-content', '[data-testid="page-content"]'];
      for (const sel of contentSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const html = el.innerHTML.trim();
          if (html && html.length > 10) {
            result.content = html;
            result.contentText = el.textContent.trim().substring(0, 500);
            break;
          }
        }
      }

      // Last modified
      const modifiedSelectors = ['.last-updated', '.modified-date', 'time[datetime]'];
      for (const sel of modifiedSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          result.modifiedDate = el.getAttribute('datetime') || el.textContent.trim();
          break;
        }
      }

      return result;
    });

    return { ...pageData, ...data };
  } catch (error) {
    console.error(`Error extracting page from ${url}:`, error.message);
    return {
      pageSlug: url.match(/\/pages\/([^\/\?]+)/)?.[1],
      courseId: url.match(/\/courses\/(\d+)/)?.[1],
      url,
      extractedAt: new Date().toISOString(),
      error: error.message
    };
  }
}

module.exports = { extractPage };
