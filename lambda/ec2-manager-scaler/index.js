/**
 * EC2 Manager - Scaler Lambda Function
 *
 * Runs every 30 seconds via EventBridge to:
 * - Process pending requests
 * - Scale up when needed
 * - Scale down idle instances
 * - Handle timed out requests
 */

const config = require("./shared/config");
const stateStore = require("./shared/state-store");
const ec2Ops = require("./shared/ec2-ops");

/**
 * Main Lambda handler
 */
exports.handler = async (event) => {
  console.log("Scaler Lambda invoked:", JSON.stringify(event));

  try {
    // Get current metrics
    const metrics = await stateStore.getScalingMetrics();
    console.log("Current metrics:", metrics);

    // Step 1: Handle timed out requests
    await handleTimedOutRequests();

    // Step 2: Sync instance states with EC2
    await syncInstanceStates();

    // Step 3: Process pending requests
    await processPendingRequests(metrics);

    // Step 4: Check for burst scaling
    await checkBurstScaling(metrics);

    // Step 5: Scale down idle instances
    await scaleDownIdleInstances(metrics);

    // Step 6: Ensure minimum warm instances
    await ensureMinimumWarmInstances(metrics);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, metrics }),
    };
  } catch (error) {
    console.error("Error in scaler:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

/**
 * Handle requests that have been waiting too long
 */
async function handleTimedOutRequests() {
  const timedOut = await stateStore.getTimedOutRequests();

  for (const request of timedOut) {
    console.log(`Request ${request.id} timed out`);
    await stateStore.markRequestTimedOut(request.id);
  }

  if (timedOut.length > 0) {
    console.log(`Marked ${timedOut.length} requests as timed out`);
  }
}

/**
 * Sync database instance states with actual EC2 states
 */
async function syncInstanceStates() {
  // Get all instances we think exist
  const dbInstances = await stateStore.getInstancesByStatus([
    config.status.STARTING,
    config.status.WARM,
    config.status.ACTIVE,
    config.status.HIBERNATING,
    config.status.STOPPED,
  ]);

  // Get actual EC2 instances
  const ec2Instances = await ec2Ops.describeManagedInstances();
  const ec2Map = new Map(ec2Instances.map((i) => [i.InstanceId, i]));

  for (const dbInstance of dbInstances) {
    const ec2Instance = ec2Map.get(dbInstance.instance_id);

    if (!ec2Instance) {
      // Instance no longer exists in EC2, remove from database
      console.log(
        `Instance ${dbInstance.instance_id} no longer exists, removing`,
      );
      await stateStore.deleteInstance(dbInstance.instance_id);
      continue;
    }

    // Update status based on EC2 state
    const ec2Status = ec2Ops.mapEC2StateToStatus(ec2Instance.State.Name);

    if (
      dbInstance.status === config.status.STARTING &&
      ec2Status === config.status.WARM
    ) {
      // Instance is now running, but we need to wait for tunnel registration
      // Don't update to warm until the callback is received
      console.log(
        `Instance ${dbInstance.instance_id} is running, waiting for tunnel registration`,
      );
    } else if (dbInstance.status !== ec2Status) {
      // State mismatch, update (except for the starting -> warm case above)
      if (dbInstance.status !== config.status.STARTING) {
        console.log(
          `Updating instance ${dbInstance.instance_id} status: ${dbInstance.status} -> ${ec2Status}`,
        );
        await stateStore.updateInstance(dbInstance.instance_id, {
          status: ec2Status,
        });
      }
    }
  }
}

/**
 * Process pending requests and assign to available instances
 */
async function processPendingRequests(metrics) {
  if (metrics.pending_requests === 0) {
    return;
  }

  console.log(`Processing ${metrics.pending_requests} pending requests`);

  // Get warm instances with capacity
  let available = await stateStore.findAvailableInstance();

  while (available && metrics.pending_requests > 0) {
    const nextRequest = await stateStore.getNextPendingRequest();

    if (!nextRequest) {
      break;
    }

    const assigned = await stateStore.assignRequestToInstance(
      nextRequest.id,
      available.instance_id,
    );

    if (assigned) {
      console.log(
        `Assigned request ${nextRequest.id} to instance ${available.instance_id}`,
      );
      metrics.pending_requests--;

      // Check if instance still has capacity
      available = await stateStore.findAvailableInstance();
    } else {
      break;
    }
  }
}

/**
 * Check if burst scaling is needed
 */
async function checkBurstScaling(metrics) {
  if (metrics.pending_requests < config.burst.scaleThreshold) {
    return;
  }

  console.log(
    `Burst threshold reached: ${metrics.pending_requests} pending requests`,
  );

  // Calculate how many instances to start
  const warmInstances = metrics.warm_instances;
  const hibernatedInstances = await stateStore.getInstancesByStatus([
    config.status.STOPPED,
    config.status.HIBERNATING,
  ]);

  // First, try to resume hibernated instances
  const instancesToResume = Math.min(
    config.burst.scaleCount,
    hibernatedInstances.length,
  );

  for (let i = 0; i < instancesToResume; i++) {
    const instance = hibernatedInstances[i];
    console.log(`Burst scaling: resuming instance ${instance.instance_id}`);

    await ec2Ops.startInstance(instance.instance_id);
    await stateStore.updateInstance(instance.instance_id, {
      status: config.status.STARTING,
    });

    await stateStore.logEvent(
      instance.instance_id,
      config.eventTypes.SCALE_UP,
      {
        reason: "burst",
        pendingRequests: metrics.pending_requests,
      },
    );
  }

  // If we need more and can launch new ones
  const totalInstances =
    metrics.active_instances + warmInstances + hibernatedInstances.length;
  const remainingToScale = config.burst.scaleCount - instancesToResume;
  const canLaunch = config.instances.maxInstances - totalInstances;
  const tolaunch = Math.min(remainingToScale, canLaunch);

  for (let i = 0; i < tolaunch; i++) {
    try {
      console.log("Burst scaling: launching new instance");
      const newInstanceId = await ec2Ops.launchInstance();
      await stateStore.registerInstance(newInstanceId, {
        status: config.status.STARTING,
      });

      await stateStore.logEvent(newInstanceId, config.eventTypes.SCALE_UP, {
        reason: "burst",
        pendingRequests: metrics.pending_requests,
      });
    } catch (error) {
      console.error("Failed to launch instance during burst:", error);
      break;
    }
  }
}

/**
 * Scale down idle instances
 */
async function scaleDownIdleInstances(metrics) {
  const idleInstances = await stateStore.getIdleInstances();

  if (idleInstances.length === 0) {
    return;
  }

  // Keep minimum warm instances
  const currentWarm = metrics.warm_instances;
  const canHibernate = Math.max(
    0,
    currentWarm - config.instances.minWarmInstances,
  );
  const toHibernate = Math.min(idleInstances.length, canHibernate);

  for (let i = 0; i < toHibernate; i++) {
    const instance = idleInstances[i];
    console.log(
      `Scaling down: hibernating idle instance ${instance.instance_id}`,
    );

    await ec2Ops.stopInstance(instance.instance_id, true); // hibernate = true
    await stateStore.setInstanceHibernating(instance.instance_id);

    await stateStore.logEvent(
      instance.instance_id,
      config.eventTypes.SCALE_DOWN,
      {
        reason: "idle",
        idleMinutes: Math.floor(
          (Date.now() - new Date(instance.last_activity_at).getTime()) / 60000,
        ),
      },
    );
  }
}

/**
 * Ensure we have minimum warm instances ready
 */
async function ensureMinimumWarmInstances(metrics) {
  const warmCount = metrics.warm_instances;

  if (warmCount >= config.instances.minWarmInstances) {
    return;
  }

  const deficit = config.instances.minWarmInstances - warmCount;
  console.log(`Need ${deficit} more warm instances (current: ${warmCount})`);

  // First, try to resume hibernated instances
  const hibernated = await stateStore.getInstancesByStatus([
    config.status.STOPPED,
    config.status.HIBERNATING,
  ]);

  const toResume = Math.min(deficit, hibernated.length);

  for (let i = 0; i < toResume; i++) {
    const instance = hibernated[i];
    console.log(`Warming up: resuming instance ${instance.instance_id}`);

    await ec2Ops.startInstance(instance.instance_id);
    await stateStore.updateInstance(instance.instance_id, {
      status: config.status.STARTING,
    });
  }

  // If still need more, launch new ones
  const remainingDeficit = deficit - toResume;
  const totalInstances =
    metrics.active_instances + warmCount + hibernated.length;
  const canLaunch = Math.min(
    remainingDeficit,
    config.instances.maxInstances - totalInstances,
  );

  for (let i = 0; i < canLaunch; i++) {
    try {
      console.log("Warming up: launching new instance");
      const newInstanceId = await ec2Ops.launchInstance();
      await stateStore.registerInstance(newInstanceId, {
        status: config.status.STARTING,
      });
    } catch (error) {
      console.error("Failed to launch instance for warm pool:", error);
      break;
    }
  }
}
