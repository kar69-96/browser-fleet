// Vercel serverless function for starting streaming auth
const https = require("https");
const http = require("http");
const crypto = require("crypto");

// EC2 Manager configuration
const EC2_MANAGER_ENABLED = process.env.EC2_MANAGER_ENABLED === "true";
const EC2_MANAGER_URL =
  process.env.EC2_MANAGER_URL;

/**
 * Make HTTP request to EC2 Manager
 */
function requestAssignment(email, context) {
  return new Promise((resolve, reject) => {
    const url = new URL("/api/ec2-manager/assign", EC2_MANAGER_URL);
    const isHttps = url.protocol === "https:";
    const httpModule = isHttps ? https : http;

    const body = JSON.stringify({ email, context });

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 30000,
    };

    const req = httpModule.request(options, (res) => {
      let responseBody = "";

      res.on("data", (chunk) => {
        responseBody += chunk;
      });

      res.on("end", () => {
        try {
          const parsed = JSON.parse(responseBody);
          resolve(parsed);
        } catch {
          reject(new Error(`Invalid response: ${responseBody}`));
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });

    req.write(body);
    req.end();
  });
}

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { email, context = "login" } = req.body;

    if (!email) {
      return res
        .status(400)
        .json({ success: false, error: "Email is required" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Try EC2 Manager for dynamic instance assignment
    if (EC2_MANAGER_ENABLED) {
      console.log("[streaming-auth] Using EC2 Manager for dynamic assignment");

      try {
        const assignment = await requestAssignment(normalizedEmail, context);

        if (assignment.success && assignment.tunnelUrl) {
          // Successfully assigned to an instance
          console.log(
            `[streaming-auth] Assigned to instance ${assignment.instanceId} with sessionId ${assignment.sessionId}`,
          );
          return res.json({
            success: true,
            url: assignment.tunnelUrl,
            streamingServerUrl: assignment.tunnelUrl.split("?")[0], // Base URL without sessionId for result polling
            sessionId: assignment.sessionId,
            instanceId: assignment.instanceId,
            requestId: assignment.requestId,
            message: "Assigned to streaming instance",
          });
        }

        if (assignment.queued) {
          // Request was queued - return queue position
          console.log(
            `[streaming-auth] Request queued at position ${assignment.position} with sessionId ${assignment.sessionId}`,
          );
          return res.status(202).json({
            success: true,
            queued: true,
            requestId: assignment.requestId,
            sessionId: assignment.sessionId,
            position: assignment.position,
            estimatedWaitSeconds: assignment.estimatedWaitSeconds,
            message: `Your request is queued at position ${assignment.position}. An instance is being prepared.`,
          });
        }

        // EC2 Manager returned an error, fall back to static URL
        console.warn(
          "[streaming-auth] EC2 Manager assignment failed:",
          assignment.error,
        );
      } catch (error) {
        console.error("[streaming-auth] EC2 Manager error:", error.message);
        // Fall through to static URL fallback
      }
    }

    // Fallback: Use static STREAMING_SERVER_URL
    const streamingUrl = process.env.STREAMING_SERVER_URL;

    if (!streamingUrl) {
      return res.status(500).json({
        success: false,
        error: "Streaming server not configured",
      });
    }

    // Generate sessionId for static fallback
    const sessionId = crypto.randomUUID();
    const urlWithSession = `${streamingUrl}?sessionId=${sessionId}`;

    console.log(
      `[streaming-auth] Using static streaming server URL with sessionId: ${sessionId}`,
    );

    // Return the tunnel URL with sessionId
    return res.json({
      success: true,
      url: urlWithSession,
      streamingServerUrl: streamingUrl,
      sessionId: sessionId,
      message: "Streaming server ready",
    });
  } catch (error) {
    console.error("Streaming auth start error:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};
