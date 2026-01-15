const path = require('path');
const fs = require('fs');

/**
 * Centralized cookie file path helpers
 * Manages authentication cookie storage paths
 */

// Output directory for cookie files
// Uses home directory on EC2/production, or relative path for local development
const OUTPUT_DIR = process.env.OUTPUT_DIR ||
  (process.env.HOME
    ? path.join(process.env.HOME, 'canvas-wrapper-data', 'auth')
    : path.join(__dirname, '..', '..', 'data', 'auth'));

/**
 * Get email-specific cookie filename
 * Creates sanitized filename from email address
 *
 * @param {string} email - User email address
 * @returns {string} Full path to email-specific cookie file
 */
function getCookieFilename(email) {
  const sanitizedEmail = email.toLowerCase().replace(/[^a-z0-9]/g, '-');
  return path.join(OUTPUT_DIR, `cookies-${sanitizedEmail}.json`);
}

/**
 * Get main cookie file path (used by AWS update script)
 *
 * @returns {string} Full path to main cookie file
 */
function getMainCookieFile() {
  return path.join(OUTPUT_DIR, 'cookies.json');
}

/**
 * Ensure output directory exists
 * Creates directory recursively if it doesn't exist
 */
function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

/**
 * Copy email-specific cookie file to main cookie file
 * Required for AWS update script compatibility
 *
 * @param {string} email - User email address
 * @returns {boolean} True if copy succeeded, false otherwise
 */
function copyCookiesToMainFile(email) {
  const normalizedEmail = email.toLowerCase().trim();
  const emailSpecificFile = getCookieFilename(normalizedEmail);
  const mainCookieFile = getMainCookieFile();

  console.log('[cookie-helpers] Copying cookies to main file...');
  console.log('[cookie-helpers]    From:', emailSpecificFile);
  console.log('[cookie-helpers]    To:', mainCookieFile);

  if (fs.existsSync(emailSpecificFile)) {
    try {
      ensureOutputDir();
      fs.copyFileSync(emailSpecificFile, mainCookieFile);
      console.log(`[cookie-helpers] ✅ Copied cookies to main file: ${mainCookieFile}`);
      return true;
    } catch (error) {
      console.error('[cookie-helpers] ❌ Error copying cookies to main file:', error);
      return false;
    }
  } else {
    console.warn('[cookie-helpers] ⚠️  Email-specific cookie file not found');
  }
  return false;
}

module.exports = {
  getCookieFilename,
  getMainCookieFile,
  ensureOutputDir,
  copyCookiesToMainFile,
  OUTPUT_DIR,
};
