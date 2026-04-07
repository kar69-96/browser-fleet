/**
 * Extraction Manager Lambda Function
 *
 * Runs every 5 minutes via EventBridge to:
 * - Check for pending extractions in the queue
 * - Auto-start EC2 extraction instance when work is available
 * - Auto-stop (hibernate) instance when extraction is complete
 * - Trigger extraction process via SSM Run Command
 *
 * This ensures the extraction instance only runs when needed,
 * reducing costs from 24/7 operation to on-demand.
 */

const {
  EC2Client,
  DescribeInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
} = require("@aws-sdk/client-ec2");

const {
  SSMClient,
  SendCommandCommand,
  GetCommandInvocationCommand,
} = require("@aws-sdk/client-ssm");

const { createClient } = require("@supabase/supabase-js");

// Configuration
const CONFIG = {
  aws: {
    region: process.env.AWS_REGION || "us-east-1",
    extractionInstanceId:
      process.env.EXTRACTION_INSTANCE_ID,
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_KEY,
  },
  extraction: {
    // Max time to wait for extraction (3 hours)
    maxExtractionTimeMs: parseInt(
      process.env.MAX_EXTRACTION_TIME_MS || String(3 * 60 * 60 * 1000),
      10,
    ),
    // Time to consider instance idle after last activity (15 minutes)
    idleTimeoutMs: parseInt(
      process.env.EXTRACTION_IDLE_TIMEOUT_MS || String(15 * 60 * 1000),
      10,
    ),
    // Path to extraction script on EC2
    extractionScriptPath:
      process.env.EXTRACTION_SCRIPT_PATH || "/home/ec2-user/extraction",
  },
};

// AWS clients
const ec2Client = new EC2Client({ region: CONFIG.aws.region });
const ssmClient = new SSMClient({ region: CONFIG.aws.region });

// Supabase client
let supabase = null;

function getSupabase() {
  if (!supabase) {
    if (!CONFIG.supabase.url || !CONFIG.supabase.serviceKey) {
      throw new Error("Supabase not configured");
    }
    supabase = createClient(CONFIG.supabase.url, CONFIG.supabase.serviceKey);
  }
  return supabase;
}

/**
 * Get current state of the extraction EC2 instance
 */
async function getInstanceState() {
  const command = new DescribeInstancesCommand({
    InstanceIds: [CONFIG.aws.extractionInstanceId],
  });

  const response = await ec2Client.send(command);
  const instance = response.Reservations?.[0]?.Instances?.[0];

  if (!instance) {
    throw new Error(`Instance ${CONFIG.aws.extractionInstanceId} not found`);
  }

  return {
    instanceId: instance.InstanceId,
    state: instance.State.Name,
    publicIp: instance.PublicIpAddress,
    launchTime: instance.LaunchTime,
  };
}

/**
 * Start the extraction instance
 */
async function startInstance() {
  console.log(
    `Starting extraction instance: ${CONFIG.aws.extractionInstanceId}`,
  );

  const command = new StartInstancesCommand({
    InstanceIds: [CONFIG.aws.extractionInstanceId],
  });

  await ec2Client.send(command);

  // Log event
  await logExtractionEvent("instance_starting", {
    instanceId: CONFIG.aws.extractionInstanceId,
    reason: "pending_extractions_found",
  });

  return true;
}

/**
 * Stop (hibernate) the extraction instance
 */
async function stopInstance(hibernate = true) {
  console.log(
    `Stopping extraction instance: ${CONFIG.aws.extractionInstanceId} (hibernate: ${hibernate})`,
  );

  const command = new StopInstancesCommand({
    InstanceIds: [CONFIG.aws.extractionInstanceId],
    Hibernate: hibernate,
  });

  await ec2Client.send(command);

  // Log event
  await logExtractionEvent("instance_stopping", {
    instanceId: CONFIG.aws.extractionInstanceId,
    hibernate,
    reason: "no_pending_extractions",
  });

  return true;
}

/**
 * Get count of pending extractions
 */
async function getPendingExtractionCount() {
  const db = getSupabase();

  const { count, error } = await db
    .from("pending_extractions")
    .select("*", { count: "exact", head: true })
    .eq("status", "pending");

  if (error) {
    console.error("Error getting pending extraction count:", error);
    throw error;
  }

  return count || 0;
}

/**
 * Get count of in-progress extractions
 */
async function getInProgressExtractionCount() {
  const db = getSupabase();

  const { count, error } = await db
    .from("pending_extractions")
    .select("*", { count: "exact", head: true })
    .eq("status", "in_progress");

  if (error) {
    console.error("Error getting in-progress extraction count:", error);
    throw error;
  }

  return count || 0;
}

/**
 * Get the last activity timestamp from extraction events
 */
async function getLastExtractionActivity() {
  const db = getSupabase();

  // Check most recent completed extraction
  const { data: completed, error: completedError } = await db
    .from("completed_extractions")
    .select("extraction_completed_at")
    .order("extraction_completed_at", { ascending: false })
    .limit(1)
    .single();

  // Check most recent in-progress extraction update
  const { data: inProgress, error: inProgressError } = await db
    .from("pending_extractions")
    .select("updated_at")
    .eq("status", "in_progress")
    .order("updated_at", { ascending: false })
    .limit(1)
    .single();

  const timestamps = [];
  if (completed?.extraction_completed_at) {
    timestamps.push(new Date(completed.extraction_completed_at));
  }
  if (inProgress?.updated_at) {
    timestamps.push(new Date(inProgress.updated_at));
  }

  if (timestamps.length === 0) {
    return null;
  }

  return new Date(Math.max(...timestamps.map((t) => t.getTime())));
}

/**
 * Trigger extraction process via SSM Run Command
 */
async function triggerExtraction() {
  console.log("Triggering extraction via SSM Run Command");

  const command = new SendCommandCommand({
    InstanceIds: [CONFIG.aws.extractionInstanceId],
    DocumentName: "AWS-RunShellScript",
    Parameters: {
      commands: [
        `cd ${CONFIG.extraction.extractionScriptPath}`,
        "source ~/.bashrc",
        "npm run process-queue -- --all 2>&1 | tee -a /var/log/extraction.log",
      ],
    },
    TimeoutSeconds: 3600, // 1 hour timeout
  });

  try {
    const response = await ssmClient.send(command);
    console.log("SSM command sent:", response.Command?.CommandId);

    await logExtractionEvent("extraction_triggered", {
      commandId: response.Command?.CommandId,
      instanceId: CONFIG.aws.extractionInstanceId,
    });

    return response.Command?.CommandId;
  } catch (error) {
    console.error("Failed to trigger extraction via SSM:", error);
    // Don't throw - the instance might not have SSM agent, extraction may run via cron
    return null;
  }
}

/**
 * Log extraction event to Supabase
 */
async function logExtractionEvent(eventType, data) {
  try {
    const db = getSupabase();

    await db.from("extraction_events").insert({
      event_type: eventType,
      data,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    // Don't fail if logging fails
    console.error("Failed to log extraction event:", error);
  }
}

/**
 * Main Lambda handler
 */
exports.handler = async (event) => {
  console.log("Extraction Manager Lambda invoked:", JSON.stringify(event));

  try {
    // Get current instance state
    const instanceState = await getInstanceState();
    console.log("Instance state:", instanceState);

    // Get extraction queue status
    const pendingCount = await getPendingExtractionCount();
    const inProgressCount = await getInProgressExtractionCount();
    const totalWork = pendingCount + inProgressCount;

    console.log(
      `Queue status: ${pendingCount} pending, ${inProgressCount} in-progress`,
    );

    // Decision logic
    if (totalWork > 0) {
      // There's work to do
      if (instanceState.state === "stopped") {
        // Instance is stopped, start it
        console.log("Work found, starting instance...");
        await startInstance();

        return {
          statusCode: 200,
          body: JSON.stringify({
            action: "started_instance",
            pendingCount,
            inProgressCount,
          }),
        };
      } else if (instanceState.state === "running") {
        // Instance is running, check if extraction is active
        if (pendingCount > 0 && inProgressCount === 0) {
          // Pending but not in-progress - trigger extraction
          console.log("Instance running, triggering extraction...");
          const commandId = await triggerExtraction();

          return {
            statusCode: 200,
            body: JSON.stringify({
              action: "triggered_extraction",
              commandId,
              pendingCount,
            }),
          };
        } else {
          // Extraction is in progress, let it continue
          console.log("Extraction in progress, no action needed");

          return {
            statusCode: 200,
            body: JSON.stringify({
              action: "none",
              reason: "extraction_in_progress",
              inProgressCount,
            }),
          };
        }
      } else if (
        instanceState.state === "pending" ||
        instanceState.state === "stopping"
      ) {
        // Instance is transitioning, wait
        console.log(`Instance in ${instanceState.state} state, waiting...`);

        return {
          statusCode: 200,
          body: JSON.stringify({
            action: "waiting",
            instanceState: instanceState.state,
          }),
        };
      }
    } else {
      // No work to do
      if (instanceState.state === "running") {
        // Check if instance has been idle long enough
        const lastActivity = await getLastExtractionActivity();
        const idleTime = lastActivity
          ? Date.now() - lastActivity.getTime()
          : CONFIG.extraction.idleTimeoutMs + 1;

        console.log(
          `No work, instance running. Idle time: ${Math.round(idleTime / 60000)} minutes`,
        );

        if (idleTime > CONFIG.extraction.idleTimeoutMs) {
          // Instance has been idle, stop it
          console.log("Instance idle, stopping...");
          await stopInstance(true); // hibernate for faster resume

          return {
            statusCode: 200,
            body: JSON.stringify({
              action: "stopped_instance",
              reason: "idle_timeout",
              idleMinutes: Math.round(idleTime / 60000),
            }),
          };
        } else {
          console.log("Instance still within idle grace period");

          return {
            statusCode: 200,
            body: JSON.stringify({
              action: "none",
              reason: "within_idle_grace_period",
              idleMinutes: Math.round(idleTime / 60000),
            }),
          };
        }
      } else {
        // Instance already stopped, nothing to do
        console.log("No work and instance stopped, no action needed");

        return {
          statusCode: 200,
          body: JSON.stringify({
            action: "none",
            reason: "no_work_instance_stopped",
          }),
        };
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ action: "none", reason: "unknown" }),
    };
  } catch (error) {
    console.error("Error in extraction manager:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
