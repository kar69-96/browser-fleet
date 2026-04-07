/**
 * Base Extractor Interface
 *
 * All content extractors should extend this class.
 * See examples/canvas/ for working reference implementations.
 */

class BaseExtractor {
  /**
   * Check if this extractor can handle the given URL
   * @param {string} url - The page URL to check
   * @returns {boolean} Whether this extractor should be used
   */
  canHandle(url) {
    throw new Error("canHandle() must be implemented by subclass");
  }

  /**
   * Extract structured data from a page
   * @param {import('playwright-core').Page} page - Playwright page instance
   * @param {string} url - The current page URL
   * @returns {Promise<Object>} Extracted data
   */
  async extract(page, url) {
    throw new Error("extract() must be implemented by subclass");
  }

  /**
   * Get the entity type this extractor produces (e.g., "assignment", "file")
   * @returns {string}
   */
  get entityType() {
    throw new Error("entityType getter must be implemented by subclass");
  }
}

module.exports = BaseExtractor;
