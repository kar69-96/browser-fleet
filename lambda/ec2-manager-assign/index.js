/**
 * EC2 Manager - Assign Lambda Function
 *
 * Handles incoming auth requests and assigns them to available instances.
 * Called by /api/streaming-auth/start via API Gateway.
 */

const crypto = require("crypto");
const config = require("./shared/config");
const stateStore = require("./shared/state-store");
const ec2Ops = require("./shared/ec2-ops");

/**
 * Main Lambda handler
 */
exports.handler = async (event) => {
  console.log("Assign Lambda invoked:", JSON.stringify(event));

  try {
    // Parse request body
    const body =
      typeof event.body === "string" ? JSON.parse(event.body) : event.body;
    const { email, context = "login" } = body;

    if (!email) {
      return response(400, { error: "Email is required" });
    }

    console.log(`Processing auth request for: ${email} (${context})`);

    // Generate a unique session ID for this auth request
    const sessionId = crypto.randomUUID();

    // Create request record
    const request = await stateStore.enqueueRequest(email, context);
    console.log(`Created request: ${request.id} with sessionId: ${sessionId}`);

    // Try to assign to an instance
    const assignment = await assignToInstance(request);

    if (assignment.success) {
      console.log(`Assigned to instance: ${assignment.instanceId}`);
      // Append sessionId to tunnel URL
      const tunnelUrlWithSession = `${assignment.tunnelUrl}?sessionId=${sessionId}`;
      return response(200, {
        success: true,
        requestId: request.id,
        sessionId: sessionId,
        tunnelUrl: tunnelUrlWithSession,
        instanceId: assignment.instanceId,
      });
    }

    // Request was queued
    const position = await stateStore.getQueuePosition(request.id);
    const estimatedWait = calculateEstimatedWait(position);

    console.log(`Request queued at position: ${position}`);
    return response(202, {
      success: true,
      queued: true,
      requestId: request.id,
      sessionId: sessionId,
      position,
      estimatedWaitSeconds: estimatedWait,
      message: `Your request is queued at position ${position}. Estimated wait: ${estimatedWait} seconds.`,
    });
  } catch (error) {
    console.error("Error processing request:", error);
    return response(500, {
      error: "Failed to process request",
      details: error.message,
    });
  }
};

/**
 * Try to assign a request to an available instance
 */
async function assignToInstance(request) {
  // Step 1: Check for warm instance with capacity
  const available = await stateStore.findAvailableInstance();

  if (available) {
    const assigned = await stateStore.assignRequestToInstance(
      request.id,
      available.instance_id,
    );

    if (assigned) {
      return {
        success: true,
        instanceId: available.instance_id,
        tunnelUrl: available.tunnel_url,
      };
    }
  }

  // Step 2: Check for hibernated instances we can resume
  const hibernated = await stateStore.getInstancesByStatus([
    config.status.STOPPED,
    config.status.HIBERNATING,
  ]);

  if (hibernated.length > 0) {
    const instance = hibernated[0];
    console.log(`Resuming hibernated instance: ${instance.instance_id}`);

    // Start the instance
    await ec2Ops.startInstance(instance.instance_id);
    await stateStore.updateInstance(instance.instance_id, {
      status: config.status.STARTING,
    });

    // Don't wait - return queued status, instance will call back when ready
    // The scaler will assign this request once the instance is ready
    return { success: false, reason: "instance_starting" };
  }

  // Step 3: Check if we can launch a new instance
  const metrics = await stateStore.getScalingMetrics();
  const totalInstances =
    metrics.active_instances +
    metrics.warm_instances +
    metrics.hibernated_instances;

  if (totalInstances < config.instances.maxInstances) {
    console.log("Launching new instance...");

    try {
      const newInstanceId = await ec2Ops.launchInstance();
      await stateStore.registerInstance(newInstanceId, {
        status: config.status.STARTING,
      });

      // Don't wait - return queued status, instance will call back when ready
      return { success: false, reason: "instance_launching" };
    } catch (error) {
      console.error("Failed to launch instance:", error);
    }
  }

  // Step 4: All options exhausted, request stays in queue
  return { success: false, reason: "queued" };
}

/**
 * Calculate estimated wait time based on queue position
 */
function calculateEstimatedWait(position) {
  // Rough estimate: 30 seconds per position (assuming instances are starting)
  // This could be made smarter based on current instance states
  return Math.min(position * 30, 120);
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
