/**
 * Lightweight File Extractor for Updates
 * Extracts file information from Canvas
 * Optimized for speed - focuses on key fields for change detection
 */

/**
 * Extracts file data from a Canvas files page or individual file
 * @param {Object} page - Playwright page object
 * @param {string} url - The file/files URL
 * @returns {Promise<Object>} - File data object with files array
 */
async function extractFiles(page, url) {
  try {
    const courseIdMatch = url.match(/\/courses\/(\d+)/);
    const courseId = courseIdMatch ? courseIdMatch[1] : null;
    const fileIdMatch = url.match(/\/files\/(\d+)/);
    const fileId = fileIdMatch ? fileIdMatch[1] : null;

    const result = {
      courseId,
      url,
      extractedAt: new Date().toISOString(),
      files: [],
      folders: []
    };

    // Wait for content to load
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page.waitForSelector('.ef-directory, .ef-item-row, .file-preview, [data-testid="file"]', { timeout: 3000 }).catch(() => {});

    // If this is a single file page
    if (fileId) {
      const fileData = await page.evaluate((fid) => {
        const result = { fileId: fid };

        // Try to get file name
        const nameSelectors = ['h1', '.file-name', '.ef-file-preview-header-filename', '[data-testid="file-name"]'];
        for (const sel of nameSelectors) {
          const el = document.querySelector(sel);
          if (el) {
            result.name = el.textContent.trim();
            break;
          }
        }

        // Try to get file info
        const infoText = document.body.textContent;
        const sizeMatch = infoText.match(/(\d+(?:\.\d+)?\s*(?:KB|MB|GB|bytes))/i);
        if (sizeMatch) result.size = sizeMatch[1];

        const dateMatch = infoText.match(/Modified.*?(\w+\s+\d+,?\s+\d{4})/i);
        if (dateMatch) result.modifiedDate = dateMatch[1];

        return result;
      }, fileId);

      result.files.push(fileData);
      return result;
    }

    // List view - extract all visible files
    const pageData = await page.evaluate(() => {
      const files = [];
      const folders = [];

      const rows = document.querySelectorAll('.ef-item-row, [role="row"], .file-item');
      rows.forEach(row => {
        const link = row.querySelector('a[href*="/files/"]');
        if (!link) return;

        const href = link.getAttribute('href');
        const name = link.textContent.trim() || link.getAttribute('title');

        // Get file ID from href
        const fileIdMatch = href.match(/\/files\/(\d+)/);
        const fullUrl = href.startsWith('http') ? href : new URL(href, window.location.href).href;

        // Check if folder
        if (href.includes('/folder/')) {
          folders.push({ url: fullUrl, name });
          return;
        }

        const file = {
          fileId: fileIdMatch ? fileIdMatch[1] : null,
          url: fullUrl,
          name
        };

        // Size
        const sizeEl = row.querySelector('.ef-size-col, .file-size, [data-testid="file-size"]');
        if (sizeEl) file.size = sizeEl.textContent.trim();

        // Modified date
        const dateEl = row.querySelector('.ef-date-col, .modified-date, time');
        if (dateEl) file.modifiedDate = dateEl.getAttribute('datetime') || dateEl.textContent.trim();

        // File type from extension
        if (name) {
          const extMatch = name.match(/\.(\w+)$/);
          if (extMatch) file.fileType = extMatch[1].toLowerCase();
        }

        files.push(file);
      });

      return { files, folders };
    });

    result.files = pageData.files;
    result.folders = pageData.folders;

    return result;
  } catch (error) {
    console.error(`Error extracting files from ${url}:`, error.message);
    return {
      courseId: url.match(/\/courses\/(\d+)/)?.[1],
      url,
      extractedAt: new Date().toISOString(),
      files: [],
      folders: [],
      error: error.message
    };
  }
}

module.exports = { extractFiles };
