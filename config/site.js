/**
 * Site Configuration — URL-Agnostic Auth & Extraction
 *
 * This file centralizes all target-site-specific configuration.
 * Override any value via environment variables for your deployment.
 */

module.exports = {
  // Target site for authentication
  target: {
    url: process.env.TARGET_URL || "https://example.com",
    name: process.env.TARGET_NAME || "Application",
  },

  // Login detection: how to know the user successfully authenticated
  loginDetection: {
    // URL patterns that indicate successful login (comma-separated)
    successPatterns: (process.env.LOGIN_SUCCESS_PATTERNS || "/dashboard,/home")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),

    // URL patterns that indicate auth-in-progress (should NOT trigger success)
    excludePatterns: (
      process.env.LOGIN_EXCLUDE_PATTERNS || "/login,/auth,/sso,/fedauth"
    )
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
  },

  // Post-login actions (optional)
  postLogin: {
    // URL to navigate to after login for data extraction (optional)
    profileUrl: process.env.POST_LOGIN_URL || null,

    // CSS selectors for extracting username/identity (comma-separated, optional)
    usernameSelectors: (process.env.USERNAME_SELECTORS || "")
      .split(",")
      .filter(Boolean),
  },
};
