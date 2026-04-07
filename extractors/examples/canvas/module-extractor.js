/**
 * Lightweight Module Extractor for Updates
 * Extracts module information from Canvas
 * Optimized for speed - focuses on key fields for change detection
 */

/**
 * Extracts module data from a Canvas modules page
 * @param {Object} page - Playwright page object
 * @param {string} url - The modules URL
 * @returns {Promise<Object>} - Module data object with modules array
 */
async function extractModules(page, url) {
  try {
    const courseIdMatch = url.match(/\/courses\/(\d+)/);
    const courseId = courseIdMatch ? courseIdMatch[1] : null;
    const moduleIdMatch = url.match(/\/modules\/(\d+)/);
    const moduleId = moduleIdMatch ? moduleIdMatch[1] : null;

    const result = {
      courseId,
      url,
      extractedAt: new Date().toISOString(),
      modules: []
    };

    // Wait for content to load
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page.waitForSelector('.context_module, [data-testid="module"], .module', { timeout: 3000 }).catch(() => {});

    // Extract all modules data
    const pageData = await page.evaluate((targetModuleId) => {
      const modules = [];

      const moduleElements = document.querySelectorAll('.context_module, [data-testid="module"], .module');
      moduleElements.forEach(moduleEl => {
        // Get module ID
        let modId = moduleEl.getAttribute('data-module-id') ||
                    moduleEl.getAttribute('id')?.match(/context_module_(\d+)/)?.[1];

        if (!modId) {
          const link = moduleEl.querySelector('a[href*="/modules/"]');
          if (link) {
            const match = link.getAttribute('href').match(/\/modules\/(\d+)/);
            if (match) modId = match[1];
          }
        }

        // If we're looking for a specific module, skip others
        if (targetModuleId && modId !== targetModuleId) return;

        if (!modId) return;

        const module = { moduleId: modId };

        // Name
        const nameEl = moduleEl.querySelector('.ig-header-title, .module-name, h3, h2');
        if (nameEl) module.name = nameEl.textContent.trim();

        // Items
        const items = [];
        const itemElements = moduleEl.querySelectorAll('.ig-list-item, .module-item, .context_module_item');
        itemElements.forEach(itemEl => {
          const item = {};

          // Item ID
          const itemId = itemEl.getAttribute('data-module-item-id') ||
                        itemEl.getAttribute('id')?.match(/context_module_item_(\d+)/)?.[1];
          if (itemId) item.moduleItemId = itemId;

          // Item link and title
          const itemLink = itemEl.querySelector('a[href]');
          if (itemLink) {
            item.title = itemLink.textContent.trim();
            item.url = itemLink.href;

            // Determine type from URL
            if (item.url.includes('/assignments/')) item.type = 'Assignment';
            else if (item.url.includes('/pages/')) item.type = 'Page';
            else if (item.url.includes('/files/')) item.type = 'File';
            else if (item.url.includes('/discussion_topics/')) item.type = 'Discussion';
            else if (item.url.includes('/quizzes/')) item.type = 'Quiz';
            else if (item.url.includes('/external_url/')) item.type = 'ExternalUrl';
            else item.type = 'Other';
          }

          if (item.title || item.url) items.push(item);
        });

        module.items = items;
        module.itemCount = items.length;

        // Unlock date
        const unlockEl = moduleEl.querySelector('.unlock-date, .module-unlock, [data-testid="unlock-date"]');
        if (unlockEl) module.unlockDate = unlockEl.getAttribute('datetime') || unlockEl.textContent.trim();

        // Completion status
        const completionEl = moduleEl.querySelector('.module-completion, .completion-status, .requirements_message');
        if (completionEl) module.completionStatus = completionEl.textContent.trim();

        modules.push(module);
      });

      return { modules };
    }, moduleId);

    result.modules = pageData.modules;

    return result;
  } catch (error) {
    console.error(`Error extracting modules from ${url}:`, error.message);
    return {
      courseId: url.match(/\/courses\/(\d+)/)?.[1],
      url,
      extractedAt: new Date().toISOString(),
      modules: [],
      error: error.message
    };
  }
}

module.exports = { extractModules };
