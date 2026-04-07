/**
 * Lightweight Assignment Extractor for Updates
 * Extracts essential assignment data from Canvas assignment pages
 * Optimized for speed - focuses on key fields for change detection
 */

/**
 * Extracts assignment data from a Canvas assignment page
 * @param {Object} page - Playwright page object
 * @param {string} url - The assignment URL
 * @returns {Promise<Object>} - Assignment data object
 */
async function extractAssignment(page, url) {
  try {
    // Extract IDs from URL
    const assignmentIdMatch = url.match(/\/assignments\/(\d+)/);
    const assignmentId = assignmentIdMatch ? assignmentIdMatch[1] : null;
    const courseIdMatch = url.match(/\/courses\/(\d+)/);
    const courseId = courseIdMatch ? courseIdMatch[1] : null;

    const assignmentData = {
      assignmentId,
      courseId,
      url,
      extractedAt: new Date().toISOString(),
    };

    // Wait for content to load (short timeout for speed)
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page.waitForSelector('h1, h2, .assignment-title', { timeout: 3000 }).catch(() => {});

    // Extract all data in a single evaluate call for speed
    const pageData = await page.evaluate(() => {
      const result = {};

      // Title extraction
      const titleSelectors = ['h2', 'h1', '.assignment-title', '.page-title'];
      for (const selector of titleSelectors) {
        const el = document.querySelector(selector);
        if (el) {
          const text = el.textContent.trim();
          if (text && text.length > 0 && !text.includes('Loading')) {
            result.title = text;
            break;
          }
        }
      }

      // Due date extraction
      const dueDateSelectors = [
        '.assignment_dates .date_text',
        '.assignment-dates .due-date',
        '[data-testid="due-date"]',
        '.due-date-details',
        '.assignment-info .date'
      ];
      for (const selector of dueDateSelectors) {
        const el = document.querySelector(selector);
        if (el) {
          result.dueDate = el.getAttribute('datetime') || el.textContent.trim();
          break;
        }
      }

      // Also check for date in the details table
      if (!result.dueDate) {
        const rows = document.querySelectorAll('.assignment_dates tr, .assignment-details tr');
        rows.forEach(row => {
          const label = row.querySelector('th, td:first-child');
          const value = row.querySelector('td:last-child');
          if (label && value) {
            const labelText = label.textContent.toLowerCase();
            if (labelText.includes('due')) {
              result.dueDate = value.getAttribute('datetime') || value.textContent.trim();
            }
          }
        });
      }

      // Points extraction
      const pointsSelectors = [
        '.points_possible',
        '.assignment-points',
        '[data-testid="points-possible"]'
      ];
      for (const selector of pointsSelectors) {
        const el = document.querySelector(selector);
        if (el) {
          const text = el.textContent.trim();
          const match = text.match(/(\d+(?:\.\d+)?)/);
          if (match) {
            result.pointsPossible = parseFloat(match[1]);
            break;
          }
        }
      }

      // Description (truncated for speed)
      const descSelectors = ['.user_content', '.assignment-description', '.description'];
      for (const selector of descSelectors) {
        const el = document.querySelector(selector);
        if (el) {
          const html = el.innerHTML.trim();
          if (html && html.length > 20) {
            result.description = html;
            result.descriptionText = el.textContent.trim().substring(0, 500);
            break;
          }
        }
      }

      // Submission status
      const statusEl = document.querySelector('.submission-status, .assignment_turned_in_status');
      if (statusEl) {
        result.submissionStatus = statusEl.textContent.trim().toLowerCase().includes('submitted') ? 'yes' : 'no';
      }

      return result;
    });

    return { ...assignmentData, ...pageData };
  } catch (error) {
    console.error(`Error extracting assignment from ${url}:`, error.message);
    return {
      assignmentId: url.match(/\/assignments\/(\d+)/)?.[1],
      courseId: url.match(/\/courses\/(\d+)/)?.[1],
      url,
      extractedAt: new Date().toISOString(),
      error: error.message
    };
  }
}

module.exports = { extractAssignment };
