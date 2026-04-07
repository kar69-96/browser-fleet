/**
 * EC2 Manager - Callback Lambda Function
 *
 * Receives notifications from EC2 instances when they're ready.
 * Called by instance user data script when cloudflared tunnel is established.
 */

const config = require("./shared/config");
const stateStore = require("./shared/state-store");

/**
 * Main Lambda handler
 */
exports.handler = async (event) => {
  console.log("Callback Lambda invoked:", JSON.stringify(event));

  try {
    // Verify internal API key
    const headers = event.headers || {};
    const internalKey = headers["x-internal-key"] || headers["X-Internal-Key"];

    if (
      config.api.internalApiKey &&
      internalKey !== config.api.internalApiKey
    ) {
      console.warn("Invalid internal API key");
      return response(401, { error: "Unauthorized" });
    }

    // Parse request body
    const body =
      typeof event.body === "string" ? JSON.parse(event.body) : event.body;
    const { instanceId, tunnelUrl } = body;

    if (!instanceId) {
      return response(400, { error: "instanceId is required" });
    }

    if (!tunnelUrl) {
      return response(400, { error: "tunnelUrl is required" });
    }

    console.log(`Instance ${instanceId} ready with tunnel: ${tunnelUrl}`);

    // Check if instance exists in database
    const instance = await stateStore.getInstance(instanceId);

    if (!instance) {
      // Instance not registered, register it now
      console.log(`Registering new instance: ${instanceId}`);
      await stateStore.registerInstance(instanceId, {
        status: config.status.WARM,
        tunnelUrl,
      });
    } else {
      // Update instance to warm with tunnel URL
      await stateStore.setInstanceReady(instanceId, tunnelUrl);
    }

    // Try to assign pending requests to this instance
    const assignedCount = await assignPendingRequests(instanceId, tunnelUrl);

    return response(200, {
      success: true,
      instanceId,
      tunnelUrl,
      assignedRequests: assignedCount,
    });
  } catch (error) {
    console.error("Error processing callback:", error);
    return response(500, {
      error: "Failed to process callback",
      details: error.message,
    });
  }
};

/**
 * Assign pending requests to the newly available instance
 */
async function assignPendingRequests(instanceId, tunnelUrl) {
  let assignedCount = 0;
  const maxSessions = config.instances.maxSessionsPerInstance;

  // Get pending requests and assign up to maxSessions
  while (assignedCount < maxSessions) {
    const nextRequest = await stateStore.getNextPendingRequest();

    if (!nextRequest) {
      break;
    }

    const assigned = await stateStore.assignRequestToInstance(
      nextRequest.id,
      instanceId,
    );

    if (assigned) {
      console.log(
        `Assigned pending request ${nextRequest.id} to instance ${instanceId}`,
      );
      assignedCount++;
    } else {
      // Instance might be full now
      break;
    }
  }

  if (assignedCount > 0) {
    console.log(
      `Assigned ${assignedCount} pending requests to instance ${instanceId}`,
    );
  }

  return assignedCount;
}

/**
 * Format HTTP response
 */
function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type,X-Internal-Key",
    },
    body: JSON.stringify(body),
  };
}
