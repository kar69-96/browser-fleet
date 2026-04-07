/**
 * Lightweight Announcement Extractor for Updates
 * Extracts essential announcement data from Canvas
 * Optimized for speed - focuses on key fields for change detection
 */

/**
 * Extracts announcement data from a Canvas announcement/discussion page
 * @param {Object} page - Playwright page object
 * @param {string} url - The announcement URL
 * @returns {Promise<Object>} - Announcement data object
 */
async function extractAnnouncement(page, url) {
  try {
    // Extract IDs from URL
    const courseIdMatch = url.match(/\/courses\/(\d+)/);
    const courseId = courseIdMatch ? courseIdMatch[1] : null;
    const announcementIdMatch = url.match(/\/discussion_topics\/(\d+)/);
    const announcementId = announcementIdMatch ? announcementIdMatch[1] : null;

    const announcementData = {
      announcementId,
      courseId,
      url,
      extractedAt: new Date().toISOString(),
      isAnnouncement: true,
    };

    // Wait for content to load
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page.waitForSelector('h1, h2, .discussion-title', { timeout: 3000 }).catch(() => {});

    // Extract all data in single evaluate
    const pageData = await page.evaluate(() => {
      const result = {};

      // Check if actually an announcement
      const announcementIndicators = [
        '.announcement',
        '[data-testid="announcement"]',
        '.is_announcement',
        'body.announcements'
      ];
      result.isAnnouncement = announcementIndicators.some(sel => document.querySelector(sel)) ||
        window.location.href.includes('announcement') ||
        document.title.toLowerCase().includes('announcement');

      // Title extraction
      const titleSelectors = ['h1', 'h2', '.discussion-title', '.announcement-title'];
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

      // Content extraction
      const contentSelectors = [
        '[data-resource-type="announcement.body"]',
        '.user_content.enhanced',
        '.user_content',
        '.discussion-content',
        '.message'
      ];
      for (const selector of contentSelectors) {
        const el = document.querySelector(selector);
        if (el) {
          const html = el.innerHTML.trim();
          if (html && html.length > 20) {
            result.content = html;
            result.contentText = el.textContent.trim().substring(0, 500);
            break;
          }
        }
      }

      // Author extraction
      const authorSelectors = ['.author', '.posted-by', '.user-name', '.discussion-author'];
      for (const selector of authorSelectors) {
        const el = document.querySelector(selector);
        if (el) {
          result.author = el.textContent.trim();
          break;
        }
      }

      // Post date extraction
      const dateSelectors = ['time[datetime]', '.posted-at', '.date', '.posted-date'];
      for (const selector of dateSelectors) {
        const el = document.querySelector(selector);
        if (el) {
          result.postDate = el.getAttribute('datetime') || el.textContent.trim();
          break;
        }
      }

      return result;
    });

    return { ...announcementData, ...pageData };
  } catch (error) {
    console.error(`Error extracting announcement from ${url}:`, error.message);
    return {
      announcementId: url.match(/\/discussion_topics\/(\d+)/)?.[1],
      courseId: url.match(/\/courses\/(\d+)/)?.[1],
      url,
      extractedAt: new Date().toISOString(),
      isAnnouncement: true,
      error: error.message
    };
  }
}

module.exports = { extractAnnouncement };
