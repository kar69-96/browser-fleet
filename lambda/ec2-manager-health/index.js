/**
 * EC2 Manager - Health Check Lambda Function
 *
 * Runs every 60 seconds via EventBridge to:
 * - Health check all active/warm instances
 * - Terminate unhealthy instances
 * - Clean up stale records
 */

const https = require("https");
const http = require("http");
const config = require("./shared/config");
const stateStore = require("./shared/state-store");
const ec2Ops = require("./shared/ec2-ops");

/**
 * Main Lambda handler
 */
exports.handler = async (event) => {
  console.log("Health Lambda invoked:", JSON.stringify(event));

  try {
    // Get all instances that should be healthy
    const instances = await stateStore.getInstancesByStatus([
      config.status.WARM,
      config.status.ACTIVE,
    ]);

    console.log(`Checking health of ${instances.length} instances`);

    const results = {
      checked: 0,
      healthy: 0,
      unhealthy: 0,
      terminated: 0,
    };

    for (const instance of instances) {
      results.checked++;

      if (!instance.tunnel_url) {
        console.log(
          `Instance ${instance.instance_id} has no tunnel URL, marking unhealthy`,
        );
        await handleUnhealthyInstance(instance, results);
        continue;
      }

      const healthy = await checkInstanceHealth(instance);

      if (healthy) {
        results.healthy++;
        // Reset health failures on successful check
        if (instance.health_check_failures > 0) {
          await stateStore.resetHealthFailures(instance.instance_id);
        }
      } else {
        results.unhealthy++;
        await handleUnhealthyInstance(instance, results);
      }
    }

    // Clean up stale starting instances (stuck starting for > 5 minutes)
    await cleanupStaleStartingInstances();

    console.log("Health check results:", results);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, results }),
    };
  } catch (error) {
    console.error("Error in health check:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

/**
 * Check if an instance is healthy by pinging its tunnel URL
 */
async function checkInstanceHealth(instance) {
  const { tunnel_url, instance_id } = instance;

  try {
    // Try to fetch the health endpoint
    const healthUrl = `${tunnel_url}/health`;
    const result = await fetchWithTimeout(healthUrl, 5000);

    if (result.ok) {
      console.log(`Instance ${instance_id} is healthy`);
      return true;
    }

    console.log(
      `Instance ${instance_id} health check failed: status ${result.status}`,
    );
    return false;
  } catch (error) {
    console.log(
      `Instance ${instance_id} health check failed: ${error.message}`,
    );
    return false;
  }
}

/**
 * Fetch URL with timeout
 */
function fetchWithTimeout(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith("https://");
    const httpModule = isHttps ? https : http;

    const timeout = setTimeout(() => {
      reject(new Error("Timeout"));
    }, timeoutMs);

    const req = httpModule.get(url, (res) => {
      clearTimeout(timeout);
      resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
      });
    });

    req.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

/**
 * Handle an unhealthy instance
 */
async function handleUnhealthyInstance(instance, results) {
  const { instance_id } = instance;

  // Increment failure count
  const failures = await stateStore.incrementHealthFailures(instance_id);

  console.log(
    `Instance ${instance_id} health failures: ${failures}/${config.instances.maxHealthCheckFailures}`,
  );

  if (failures >= config.instances.maxHealthCheckFailures) {
    console.log(`Instance ${instance_id} exceeded max failures, terminating`);

    try {
      // Release any sessions on this instance
      await releaseInstanceSessions(instance_id);

      // Terminate the instance
      await ec2Ops.terminateInstance(instance_id);
      await stateStore.deleteInstance(instance_id);

      results.terminated++;

      console.log(`Terminated unhealthy instance: ${instance_id}`);
    } catch (error) {
      console.error(`Failed to terminate instance ${instance_id}:`, error);
    }
  }
}

/**
 * Release all sessions on an instance
 */
async function releaseInstanceSessions(instanceId) {
  const supabase = stateStore.getSupabase();

  // Find all requests assigned to this instance
  const { data: requests, error } = await supabase
    .from("auth_requests")
    .select("id")
    .eq("assigned_instance", instanceId)
    .in("status", [
      config.requestStatus.ASSIGNED,
      config.requestStatus.IN_PROGRESS,
    ]);

  if (error) {
    console.error("Failed to find requests for instance:", error);
    return;
  }

  // Mark them as failed so they can be reassigned
  for (const request of requests || []) {
    await stateStore.releaseSession(request.id, config.requestStatus.FAILED);
    console.log(`Released failed session: ${request.id}`);
  }
}

/**
 * Clean up instances that have been stuck in starting state
 */
async function cleanupStaleStartingInstances() {
  const supabase = stateStore.getSupabase();

  // Find instances that have been starting for > 5 minutes
  const staleThreshold = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const { data: staleInstances, error } = await supabase
    .from("streaming_instances")
    .select("*")
    .eq("status", config.status.STARTING)
    .lt("created_at", staleThreshold);

  if (error) {
    console.error("Failed to find stale instances:", error);
    return;
  }

  for (const instance of staleInstances || []) {
    console.log(
      `Instance ${instance.instance_id} stuck in starting state, checking EC2...`,
    );

    // Check actual EC2 state
    const ec2Instance = await ec2Ops.describeInstance(instance.instance_id);

    if (!ec2Instance) {
      // Instance doesn't exist, clean up
      console.log(
        `Instance ${instance.instance_id} no longer exists, cleaning up`,
      );
      await stateStore.deleteInstance(instance.instance_id);
      continue;
    }

    const ec2State = ec2Instance.State.Name;

    if (ec2State === "running") {
      // Instance is running but never called back, might be broken
      console.log(
        `Instance ${instance.instance_id} is running but never registered, incrementing failures`,
      );
      const failures = await stateStore.incrementHealthFailures(
        instance.instance_id,
      );

      if (failures >= 2) {
        console.log(`Terminating stale instance ${instance.instance_id}`);
        await ec2Ops.terminateInstance(instance.instance_id);
        await stateStore.deleteInstance(instance.instance_id);
      }
    } else if (ec2State === "terminated" || ec2State === "shutting-down") {
      // Instance was terminated, clean up
      console.log(
        `Instance ${instance.instance_id} was terminated, cleaning up`,
      );
      await stateStore.deleteInstance(instance.instance_id);
    }
  }
}
