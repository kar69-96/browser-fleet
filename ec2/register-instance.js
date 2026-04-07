#!/usr/bin/env node
/**
 * EC2 Instance Registration Script
 *
 * Registers this instance with the EC2 Manager service.
 * Called by startup.sh after the streaming server is ready.
 */

const https = require("https");
const http = require("http");
const fs = require("fs");

// Configuration
const API_BASE_URL = process.env.API_BASE_URL;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || "";
const INSTANCE_ID = process.env.INSTANCE_ID;
const TUNNEL_URL = process.env.TUNNEL_URL;

// Validate required environment variables
if (!INSTANCE_ID) {
  console.error("ERROR: INSTANCE_ID environment variable is required");
  process.exit(1);
}

if (!TUNNEL_URL) {
  console.error("ERROR: TUNNEL_URL environment variable is required");
  process.exit(1);
}

/**
 * Make HTTP POST request
 */
function postRequest(url, data) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === "https:";
    const httpModule = isHttps ? https : http;

    const body = JSON.stringify(data);

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...(INTERNAL_API_KEY && { "X-Internal-Key": INTERNAL_API_KEY }),
      },
    };

    const req = httpModule.request(options, (res) => {
      let responseBody = "";

      res.on("data", (chunk) => {
        responseBody += chunk;
      });

      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          body: responseBody,
        });
      });
    });

    req.on("error", reject);

    req.write(body);
    req.end();
  });
}

/**
 * Register with EC2 Manager
 */
async function register() {
  console.log("Registering instance with EC2 Manager...");
  console.log(`  Instance ID: ${INSTANCE_ID}`);
  console.log(`  Tunnel URL: ${TUNNEL_URL}`);
  console.log(`  API Base URL: ${API_BASE_URL}`);

  const callbackUrl = `${API_BASE_URL}/api/internal/instance-ready`;

  try {
    const response = await postRequest(callbackUrl, {
      instanceId: INSTANCE_ID,
      tunnelUrl: TUNNEL_URL,
    });

    if (response.statusCode >= 200 && response.statusCode < 300) {
      console.log("Successfully registered with EC2 Manager");
      console.log(`  Response: ${response.body}`);

      // Parse response for additional info
      try {
        const data = JSON.parse(response.body);
        if (data.assignedRequests > 0) {
          console.log(`  Assigned ${data.assignedRequests} pending requests`);
        }
      } catch {
        // Ignore parse errors
      }

      return true;
    }

    console.error(`Failed to register: HTTP ${response.statusCode}`);
    console.error(`  Response: ${response.body}`);
    return false;
  } catch (error) {
    console.error("Failed to register:", error.message);
    return false;
  }
}

/**
 * Wait for local streaming server to be ready
 */
async function waitForServer(maxAttempts = 30) {
  const healthUrl = "http://localhost:3002/health";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(healthUrl, (res) => {
          if (res.statusCode === 200) {
            resolve(true);
          } else {
            reject(new Error(`Status: ${res.statusCode}`));
          }
        });
        req.on("error", reject);
        req.setTimeout(5000, () => {
          req.destroy();
          reject(new Error("Timeout"));
        });
      });

      console.log("Streaming server is ready");
      return true;
    } catch {
      console.log(
        `Waiting for streaming server... attempt ${attempt}/${maxAttempts}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  console.error("Streaming server did not become ready");
  return false;
}

/**
 * Main
 */
async function main() {
  console.log("=".repeat(50));
  console.log("Streaming Auth - Instance Registration");
  console.log("=".repeat(50));

  // Wait for local server to be ready
  const serverReady = await waitForServer();
  if (!serverReady) {
    process.exit(1);
  }

  // Register with EC2 Manager
  const registered = await register();
  if (!registered) {
    // Don't exit with error - the health check will handle re-registration
    console.warn("WARNING: Registration failed, health check will retry");
  }

  // Save registration state
  const stateFile = "/home/ec2-user/registration-state.json";
  try {
    fs.writeFileSync(
      stateFile,
      JSON.stringify(
        {
          instanceId: INSTANCE_ID,
          tunnelUrl: TUNNEL_URL,
          registeredAt: new Date().toISOString(),
          success: registered,
        },
        null,
        2,
      ),
    );
    console.log(`Registration state saved to ${stateFile}`);
  } catch (error) {
    console.warn("Failed to save registration state:", error.message);
  }

  console.log("=".repeat(50));
  console.log("Registration complete");
  console.log("=".repeat(50));
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
