#!/usr/bin/env node

/**
 * Canvas Cookie Extraction - Streaming Mode
 *
 * Launches a browser session and streams the screen to connected clients via WebSocket.
 * Allows users to interact with the browser remotely while cookies are extracted.
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

// Load environment-specific config
const isDev = process.env.NODE_ENV === "development";
const envFile = isDev ? ".env.development" : ".env";
require("dotenv").config({ path: path.join(__dirname, "../..", envFile) });

console.log(`[streaming] Environment: ${isDev ? "DEVELOPMENT" : "PRODUCTION"}`);

// Configuration
const PORT = parseInt(process.env.STREAMING_PORT || "3002");
const CANVAS_URL = process.env.CANVAS_URL || "https://canvas.colorado.edu";
const COOKIE_OUTPUT_FILE =
  process.env.COOKIE_OUTPUT_FILE ||
  path.join(__dirname, "../../data/auth/canvas-cookies.json");
const EXTRACTION_EMAIL = process.env.EXTRACTION_EMAIL;

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

// Ensure output directory exists
const outputDir = path.dirname(COOKIE_OUTPUT_FILE);
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Store browser context
let browserContext = null;
let page = null;
let extractionComplete = false;
let browserStarting = false; // Flag to prevent restart during startup
let exitTimeout = null; // Timeout for delayed exit after extraction
let isMobileClient = false; // Flag for mobile viewport
let browserStarted = false; // Flag to track if browser has been started

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

let currentStage = STATUS_STAGES.CONNECTING;

function emitStatus(stage, message, details = {}) {
  currentStage = stage;
  io.emit("status", { stage, message, timestamp: Date.now(), ...details });
  console.log(`[streaming] Status: ${stage} - ${message}`);
}

// Timeout constants
const TIMEOUTS = {
  BROWSER_LAUNCH: 15000, // 15 seconds
  SCREENCAST: 5000, // 5 seconds
  NAVIGATION: 30000, // 30 seconds
};

/**
 * Serve the streaming viewer HTML page (minimal UI, fullscreen)
 */
app.get("/", (req, res) => {
  // Check if mobile client
  if (req.query.mobile === "1") {
    isMobileClient = true;
    console.log("[streaming] Mobile client detected, will use mobile viewport");
  }

  // Start browser on first page request (after mobile flag is set)
  if (!browserStarted && !browserStarting) {
    browserStarted = true;
    console.log("[streaming] Starting browser on first client request...");
    startStreaming().catch((err) => {
      console.error("[streaming] Failed to start streaming:", err);
    });
  }

  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Canvas Login</title>
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
      <div class="step" id="step-canvas" data-step="canvas">
        <span class="step-icon">3</span>
        <span class="step-label">Canvas</span>
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
    const socket = io();
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
      console.log('Connected to streaming server');
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
          updateStep('canvas', 'active');
          break;
        case 'ready_for_login':
          updateStep('canvas', 'complete');
          updateStep('login', 'active');
          break;
        case 'login_detected':
        case 'extracting_cookies':
          // Close popup immediately - don't show any Canvas content
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
  `);
});

/**
 * Health check endpoint
 */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    port: PORT,
    extractionComplete,
    email: EXTRACTION_EMAIL,
  });
});

/**
 * Extraction result endpoint
 */
app.get("/extraction-result/:email", (req, res) => {
  const { email } = req.params;

  // Check if extraction is complete
  if (extractionComplete) {
    // Check if cookie file exists
    const outputFile = COOKIE_OUTPUT_FILE;

    if (fs.existsSync(outputFile)) {
      try {
        const cookieData = JSON.parse(fs.readFileSync(outputFile, "utf8"));

        console.log("[streaming] Extraction result fetched by frontend");

        // Result was fetched - exit sooner (2 seconds to allow response to complete)
        if (exitTimeout) {
          clearTimeout(exitTimeout);
          exitTimeout = setTimeout(() => {
            console.log("[streaming] Exiting after result fetch");
            process.exit(0);
          }, 2000);
        }

        return res.json({
          success: true,
          username:
            cookieData.username || cookieData.metadata?.username || null,
          cookies: cookieData.cookies || [],
          extractedAt:
            cookieData.metadata?.extractedAt || new Date().toISOString(),
        });
      } catch (err) {
        console.error("[streaming] Error reading cookie file:", err);
      }
    }
  }

  // If browser is active, return pending status
  if (page && !extractionComplete) {
    return res.json({
      success: false,
      pending: true,
      message:
        "Authentication in progress. Please complete login in the popup window.",
    });
  }

  // No active session
  return res.json({
    success: false,
    error: "No authentication session found",
    requiresReauth: true,
  });
});

/**
 * Restart browser to ensure fresh session (fixes "Stale Request" errors)
 */
async function restartBrowser() {
  console.log("[streaming] Restarting browser for fresh session...");

  // Close existing browser if any
  if (browserContext) {
    try {
      await browserContext.close();
      console.log("[streaming] Previous browser closed");
    } catch (err) {
      console.error("[streaming] Error closing browser:", err.message);
    }
  }

  browserContext = null;
  page = null;
  extractionComplete = false;

  // Restart streaming
  await startStreaming();
}

/**
 * Socket.IO connection handler
 */
io.on("connection", (socket) => {
  console.log("[streaming] Client connected:", socket.id);

  // Only restart browser if it's not currently starting up
  // This prevents killing the browser during initial navigation
  if (page && !extractionComplete && !browserStarting) {
    console.log(
      "[streaming] Browser already in use and ready, restarting for fresh session...",
    );
    restartBrowser().catch((err) => {
      console.error("[streaming] Failed to restart browser:", err);
      socket.emit("error", "Failed to initialize browser");
    });
  } else if (browserStarting) {
    console.log("[streaming] Browser is starting up, skipping restart");
  } else if (!page && !browserStarting && !browserStarted) {
    // No browser running at all - start one (handles direct Socket.IO connections from Vercel viewer)
    console.log(
      "[streaming] No browser running, starting fresh browser for new connection...",
    );
    browserStarted = true;
    startStreaming().catch((err) => {
      console.error("[streaming] Failed to start streaming:", err);
      socket.emit("error", "Failed to initialize browser");
    });
  }

  socket.on("mouse-move", async (data) => {
    if (page) {
      await page.mouse.move(data.x, data.y).catch((err) => {
        console.error("[streaming] Mouse move error:", err.message);
      });
    }
  });

  socket.on("mouse-down", async (data) => {
    if (page) {
      await page.mouse
        .down({
          button: data.button === "right" ? "right" : "left",
        })
        .catch((err) => {
          console.error("[streaming] Mouse down error:", err.message);
        });
    }
  });

  socket.on("mouse-up", async (data) => {
    if (page) {
      await page.mouse
        .up({
          button: data.button === "right" ? "right" : "left",
        })
        .catch((err) => {
          console.error("[streaming] Mouse up error:", err.message);
        });
    }
  });

  socket.on("mouse-click", async (data) => {
    if (page) {
      await page.mouse
        .click(data.x, data.y, {
          button: data.button === "right" ? "right" : "left",
        })
        .catch((err) => {
          console.error("[streaming] Mouse click error:", err.message);
        });
    }
  });

  socket.on("key-down", async (data) => {
    if (page) {
      await page.keyboard.down(data.key).catch((err) => {
        console.error("[streaming] Key down error:", err.message);
      });
    }
  });

  socket.on("key-up", async (data) => {
    if (page) {
      await page.keyboard.up(data.key).catch((err) => {
        console.error("[streaming] Key up error:", err.message);
      });
    }
  });

  socket.on("type-text", async (data) => {
    if (page && data.text) {
      await page.keyboard.type(data.text).catch((err) => {
        console.error("[streaming] Type text error:", err.message);
      });
    }
  });

  socket.on("disconnect", () => {
    console.log("[streaming] Client disconnected:", socket.id);
  });
});

/**
 * Extract cookies from browser context
 */
async function extractCookies() {
  if (!browserContext) {
    throw new Error("Browser context not initialized");
  }

  const cookies = await browserContext.cookies();

  // Get username from page if possible
  let username = null;
  try {
    if (page) {
      // Wait briefly for the page to fully render (reduced from 2000ms)
      await page.waitForTimeout(500);

      console.log(
        "[streaming] Attempting to extract username from Canvas page...",
      );

      // Method 1: Try to extract from user settings/profile page
      try {
        // Navigate to profile/settings to get the actual username
        const currentUrl = page.url();
        console.log("[streaming] Current URL before navigation:", currentUrl);

        // Try to get user ID from any Canvas page and construct settings URL
        const userId = await page.evaluate(() => {
          // Check for ENV.current_user_id in Canvas
          return window.ENV?.current_user_id || null;
        });

        if (userId) {
          console.log("[streaming] Found user ID:", userId);
          await page.goto(`https://canvas.colorado.edu/profile/settings`, {
            waitUntil: "networkidle",
            timeout: 10000,
          });
          await page.waitForTimeout(1000);

          // Try to find login/username field
          const loginInput = await page.$(
            'input[name="user[short_name]"], input[name="user[name]"], #user_short_name',
          );
          if (loginInput) {
            username = await loginInput.evaluate((el) => el.value);
            console.log(
              "[streaming] Extracted username from profile settings:",
              username,
            );
          }
        }
      } catch (navErr) {
        console.log(
          "[streaming] Could not navigate to settings:",
          navErr.message,
        );
      }

      // Method 2: Try to extract from page content/title
      if (!username) {
        try {
          const pageTitle = await page.title();
          console.log("[streaming] Page title:", pageTitle);

          // Sometimes Canvas includes username in title
          const titleMatch = pageTitle.match(/([a-z]{4}\d{4})/i);
          if (titleMatch) {
            username = titleMatch[1];
            console.log(
              "[streaming] Extracted username from page title:",
              username,
            );
          }
        } catch (titleErr) {
          console.log("[streaming] Could not extract from title");
        }
      }

      // Method 3: Extract from URL if user navigated to their profile
      if (!username) {
        try {
          const url = page.url();
          const urlMatch = url.match(/\/users\/\d+/);
          if (urlMatch) {
            // Try to get username from profile page
            await page.waitForSelector("body", { timeout: 2000 });
            const profileText = await page.textContent("body");
            const usernameMatch = profileText.match(/([a-z]{4}\d{4})/i);
            if (usernameMatch) {
              username = usernameMatch[1];
              console.log(
                "[streaming] Extracted username from profile:",
                username,
              );
            }
          }
        } catch (urlErr) {
          console.log("[streaming] Could not extract from URL");
        }
      }

      if (!username) {
        console.log(
          "[streaming] Could not extract username - will need manual verification",
        );
      }
    }
  } catch (err) {
    console.warn("[streaming] Error extracting username:", err.message);
  }

  // Save cookies to file
  const cookieData = {
    username,
    cookies,
    metadata: {
      extractedAt: new Date().toISOString(),
      url: CANVAS_URL,
      email: EXTRACTION_EMAIL,
    },
  };

  fs.writeFileSync(COOKIE_OUTPUT_FILE, JSON.stringify(cookieData, null, 2));
  console.log("[streaming] ✅ Cookies saved to:", COOKIE_OUTPUT_FILE);
  console.log("[streaming]    Username:", username || "not extracted");
  console.log("[streaming]    Cookie count:", cookies.length);

  return cookieData;
}

/**
 * Monitor page for login completion
 */
async function monitorLoginCompletion() {
  if (!page) return;

  console.log("[streaming] Monitoring for login completion...");

  // Listen for URL changes
  page.on("framenavigated", async (frame) => {
    if (frame !== page.mainFrame()) return;

    const url = page.url();
    console.log("[streaming] Page navigated to:", url);

    // Check if we're on Canvas (not fedauth)
    if (url.includes("canvas.colorado.edu") && !url.includes("fedauth")) {
      console.log("[streaming] ✅ Login complete! User reached Canvas");
      console.log("[streaming]    Current URL:", url);

      // Emit login detected status
      emitStatus(STATUS_STAGES.LOGIN_DETECTED, "Login successful!");

      // FIRST: Stop screencast to prevent any more frames being sent
      console.log("[streaming] Stopping screencast...");
      try {
        const cdpSession = await page.context().newCDPSession(page);
        await cdpSession.send("Page.stopScreencast");
        console.log("[streaming] Screencast stopped");
      } catch (err) {
        console.log("[streaming] Could not stop screencast:", err.message);
      }

      // THEN: Tell frontend to close popup (after screencast is stopped)
      console.log("[streaming] Sending close-popup signal...");
      io.emit("close-popup");

      // Wait for popup to close before navigating to profile page
      await page.waitForTimeout(300);

      // Extract cookies HEADLESSLY (user won't see profile page navigation)
      try {
        console.log(
          "[streaming] Extracting cookies and username headlessly...",
        );
        const cookieData = await extractCookies();

        console.log("[streaming] ✅ Cookie extraction completed");
        console.log(
          "[streaming]    Username:",
          cookieData.username || "not extracted",
        );
        console.log("[streaming]    Cookies:", cookieData.cookies.length);

        // Emit completion status
        emitStatus(STATUS_STAGES.COMPLETE, "Authentication complete!");

        // Notify clients
        io.emit("extraction-complete", {
          success: true,
          username: cookieData.username,
          cookieCount: cookieData.cookies.length,
        });

        console.log("[streaming] ✅ Notified clients of extraction completion");
        extractionComplete = true;

        // Close browser to free resources (but keep server running for HTTP polling)
        console.log("[streaming] Closing browser...");
        if (browserContext) {
          await browserContext.close();
          browserContext = null;
          page = null;
        }

        // Keep server alive for 30 seconds to allow frontend to fetch extraction result via HTTP
        // The frontend polls /extraction-result/:email and needs the server to respond
        console.log(
          "[streaming] Server will exit in 30 seconds (waiting for result fetch)...",
        );
        exitTimeout = setTimeout(() => {
          console.log("[streaming] Exiting after timeout");
          process.exit(0);
        }, 30000);
      } catch (err) {
        console.error("[streaming] Error extracting cookies:", err);
        emitStatus(STATUS_STAGES.ERROR, "Failed to save credentials", {
          suggestion: "Please try logging in again.",
        });
        io.emit("error", err.message);
      }
    }
  });
}

/**
 * Start streaming session
 */
async function startStreaming() {
  try {
    // Set flag to prevent restart during startup
    browserStarting = true;

    console.log("[streaming] Starting browser...");
    console.log("[streaming]    Port:", PORT);
    console.log("[streaming]    Canvas URL:", CANVAS_URL);
    console.log("[streaming]    Extraction email:", EXTRACTION_EMAIL);
    console.log("[streaming]    Output file:", COOKIE_OUTPUT_FILE);

    // Emit browser launching status
    emitStatus(STATUS_STAGES.BROWSER_LAUNCHING, "Starting secure browser...");

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
      emitStatus(STATUS_STAGES.ERROR, "Failed to start browser", {
        suggestion:
          "The browser may not be installed. Try running: npx playwright install chromium",
      });
      throw launchErr;
    }

    emitStatus(STATUS_STAGES.BROWSER_READY, "Browser started successfully");

    // Create browser context - use mobile viewport if mobile client
    const viewport = isMobileClient
      ? { width: 390, height: 844 } // iPhone 14 Pro dimensions
      : { width: 1280, height: 720 };

    const userAgent = isMobileClient
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
      : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    console.log(
      `[streaming] Using ${isMobileClient ? "mobile" : "desktop"} viewport: ${viewport.width}x${viewport.height}`,
    );

    browserContext = await browser.newContext({
      viewport,
      userAgent,
      storageState: undefined,
      bypassCSP: false,
      ignoreHTTPSErrors: false,
      isMobile: isMobileClient,
      hasTouch: isMobileClient,
    });

    page = await browserContext.newPage();

    // Enable CDP session for screencast
    emitStatus(
      STATUS_STAGES.SCREENCAST_STARTING,
      "Preparing screen capture...",
    );

    const cdpSession = await page.context().newCDPSession(page);

    // Start screencast with timeout - use mobile dimensions if mobile client
    try {
      const screencastPromise = cdpSession.send("Page.startScreencast", {
        format: "jpeg",
        quality: isMobileClient ? 70 : 50, // Higher quality for mobile (smaller images)
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
      emitStatus(STATUS_STAGES.ERROR, "Failed to start screen capture", {
        suggestion:
          "Please try again. If the problem persists, contact support.",
      });
      await browserContext?.close();
      throw screencastErr;
    }

    console.log("[streaming] ✅ Screencast started");

    // Listen for screencast frames
    cdpSession.on("Page.screencastFrame", async (frame) => {
      io.emit("frame", frame.data);
      await cdpSession.send("Page.screencastFrameAck", {
        sessionId: frame.sessionId,
      });
    });

    // Navigate to Canvas login with timeout
    emitStatus(STATUS_STAGES.NAVIGATING, "Loading Canvas login page...");

    try {
      await page.goto(CANVAS_URL, {
        waitUntil: "domcontentloaded",
        timeout: TIMEOUTS.NAVIGATION,
      });
    } catch (navErr) {
      browserStarting = false; // Clear flag on error
      emitStatus(STATUS_STAGES.ERROR, "Failed to load Canvas", {
        suggestion: "Please check your network connection and try again.",
      });
      await browserContext?.close();
      throw navErr;
    }

    // Browser is ready - clear the startup flag
    browserStarting = false;
    emitStatus(
      STATUS_STAGES.READY_FOR_LOGIN,
      "Ready - please log in to Canvas",
    );

    // Start monitoring for login completion
    monitorLoginCompletion();
  } catch (err) {
    browserStarting = false; // Clear flag on error
    console.error("[streaming] Error starting browser:", err);
    // Only emit error if not already emitted
    if (currentStage !== STATUS_STAGES.ERROR) {
      emitStatus(
        STATUS_STAGES.ERROR,
        err.message || "An unexpected error occurred",
        {
          suggestion: "Please close this window and try again.",
        },
      );
    }
    process.exit(1);
  }
}

// Start the server
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[streaming] 🚀 Streaming server started on port ${PORT}`);
  console.log(`[streaming]    View at: http://localhost:${PORT}`);
  console.log(`[streaming]    Browser will start when first client connects`);
  // Browser startup is now triggered by first page request to detect mobile
});

// Cleanup on exit
process.on("SIGINT", async () => {
  console.log("\n[streaming] Shutting down...");
  if (browserContext) {
    await browserContext.close();
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n[streaming] Shutting down...");
  if (browserContext) {
    await browserContext.close();
  }
  process.exit(0);
});
