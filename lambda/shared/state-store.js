/**
 * Supabase state store for EC2 instance management
 */

const { createClient } = require("@supabase/supabase-js");
const config = require("./config");

let supabaseClient = null;

/**
 * Get or create Supabase client
 */
function getSupabase() {
  if (!supabaseClient) {
    if (!config.supabase.url || !config.supabase.serviceKey) {
      throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set");
    }
    supabaseClient = createClient(
      config.supabase.url,
      config.supabase.serviceKey,
    );
  }
  return supabaseClient;
}

// =============================================================================
// Instance Operations
// =============================================================================

/**
 * Register a new instance in the database
 */
async function registerInstance(instanceId, initialData = {}) {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("streaming_instances")
    .insert({
      instance_id: instanceId,
      status: initialData.status || config.status.STARTING,
      tunnel_url: initialData.tunnelUrl || null,
      current_sessions: 0,
      max_sessions:
        initialData.maxSessions || config.instances.maxSessionsPerInstance,
      last_activity_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    console.error("Failed to register instance:", error);
    throw error;
  }

  await logEvent(instanceId, config.eventTypes.INSTANCE_STARTING, {
    initialData,
  });

  return data;
}

/**
 * Update instance status and data
 */
async function updateInstance(instanceId, updates) {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("streaming_instances")
    .update({
      ...updates,
      updated_at: new Date().toISOString(),
    })
    .eq("instance_id", instanceId)
    .select()
    .single();

  if (error) {
    console.error("Failed to update instance:", error);
    throw error;
  }

  return data;
}

/**
 * Update instance tunnel URL when ready
 */
async function setInstanceReady(instanceId, tunnelUrl) {
  const instance = await updateInstance(instanceId, {
    status: config.status.WARM,
    tunnel_url: tunnelUrl,
    last_activity_at: new Date().toISOString(),
    health_check_failures: 0,
  });

  await logEvent(instanceId, config.eventTypes.INSTANCE_READY, { tunnelUrl });

  return instance;
}

/**
 * Get instance by ID
 */
async function getInstance(instanceId) {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("streaming_instances")
    .select("*")
    .eq("instance_id", instanceId)
    .single();

  if (error && error.code !== "PGRST116") {
    console.error("Failed to get instance:", error);
    throw error;
  }

  return data;
}

/**
 * Get all instances by status
 */
async function getInstancesByStatus(statuses) {
  const supabase = getSupabase();
  const statusArray = Array.isArray(statuses) ? statuses : [statuses];

  const { data, error } = await supabase
    .from("streaming_instances")
    .select("*")
    .in("status", statusArray);

  if (error) {
    console.error("Failed to get instances by status:", error);
    throw error;
  }

  return data || [];
}

/**
 * Find an available instance with capacity
 */
async function findAvailableInstance() {
  const supabase = getSupabase();

  const { data, error } = await supabase.rpc("find_available_instance");

  if (error) {
    console.error("Failed to find available instance:", error);
    throw error;
  }

  return data && data.length > 0 ? data[0] : null;
}

/**
 * Mark instance as hibernating
 */
async function setInstanceHibernating(instanceId) {
  const instance = await updateInstance(instanceId, {
    status: config.status.HIBERNATING,
    tunnel_url: null,
    current_sessions: 0,
  });

  await logEvent(instanceId, config.eventTypes.INSTANCE_HIBERNATING);

  return instance;
}

/**
 * Mark instance as stopped
 */
async function setInstanceStopped(instanceId) {
  const instance = await updateInstance(instanceId, {
    status: config.status.STOPPED,
  });

  await logEvent(instanceId, config.eventTypes.INSTANCE_STOPPED);

  return instance;
}

/**
 * Delete instance record
 */
async function deleteInstance(instanceId) {
  const supabase = getSupabase();

  await logEvent(instanceId, config.eventTypes.INSTANCE_TERMINATED);

  const { error } = await supabase
    .from("streaming_instances")
    .delete()
    .eq("instance_id", instanceId);

  if (error) {
    console.error("Failed to delete instance:", error);
    throw error;
  }
}

/**
 * Increment health check failures
 */
async function incrementHealthFailures(instanceId) {
  const supabase = getSupabase();

  // First get current value
  const { data: current, error: getError } = await supabase
    .from("streaming_instances")
    .select("health_check_failures")
    .eq("instance_id", instanceId)
    .single();

  if (getError) {
    console.error("Failed to get health failures:", getError);
    throw getError;
  }

  const newFailures = (current?.health_check_failures || 0) + 1;

  // Then update with incremented value
  const { data, error } = await supabase
    .from("streaming_instances")
    .update({ health_check_failures: newFailures })
    .eq("instance_id", instanceId)
    .select("health_check_failures")
    .single();

  if (error) {
    console.error("Failed to increment health failures:", error);
    throw error;
  }

  await logEvent(instanceId, config.eventTypes.INSTANCE_HEALTH_FAILED, {
    failures: data?.health_check_failures,
  });

  return data?.health_check_failures || 0;
}

/**
 * Reset health check failures
 */
async function resetHealthFailures(instanceId) {
  return updateInstance(instanceId, { health_check_failures: 0 });
}

// =============================================================================
// Request Queue Operations
// =============================================================================

/**
 * Enqueue a new auth request
 */
async function enqueueRequest(email, context = "login") {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("auth_requests")
    .insert({
      email,
      context,
      status: config.requestStatus.PENDING,
    })
    .select()
    .single();

  if (error) {
    console.error("Failed to enqueue request:", error);
    throw error;
  }

  return data;
}

/**
 * Get pending requests count
 */
async function getPendingCount() {
  const supabase = getSupabase();

  const { count, error } = await supabase
    .from("auth_requests")
    .select("*", { count: "exact", head: true })
    .eq("status", config.requestStatus.PENDING);

  if (error) {
    console.error("Failed to get pending count:", error);
    throw error;
  }

  return count || 0;
}

/**
 * Get next pending request
 */
async function getNextPendingRequest() {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("auth_requests")
    .select("*")
    .eq("status", config.requestStatus.PENDING)
    .order("created_at", { ascending: true })
    .limit(1)
    .single();

  if (error && error.code !== "PGRST116") {
    console.error("Failed to get next pending request:", error);
    throw error;
  }

  return data;
}

/**
 * Assign a request to an instance
 */
async function assignRequestToInstance(requestId, instanceId) {
  const supabase = getSupabase();

  const { data, error } = await supabase.rpc("assign_request_to_instance", {
    p_request_id: requestId,
    p_instance_id: instanceId,
  });

  if (error) {
    console.error("Failed to assign request:", error);
    throw error;
  }

  if (data) {
    await logEvent(instanceId, config.eventTypes.SESSION_ASSIGNED, {
      requestId,
    });
  }

  return data;
}

/**
 * Release a session when auth completes
 */
async function releaseSession(
  requestId,
  status = config.requestStatus.COMPLETED,
) {
  const supabase = getSupabase();

  const { error } = await supabase.rpc("release_instance_session", {
    p_request_id: requestId,
    p_new_status: status,
  });

  if (error) {
    console.error("Failed to release session:", error);
    throw error;
  }
}

/**
 * Get queue position for a request
 */
async function getQueuePosition(requestId) {
  const supabase = getSupabase();

  const { data, error } = await supabase.rpc("get_queue_position", {
    request_id: requestId,
  });

  if (error) {
    console.error("Failed to get queue position:", error);
    throw error;
  }

  return data;
}

/**
 * Get request by ID
 */
async function getRequest(requestId) {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("auth_requests")
    .select("*")
    .eq("id", requestId)
    .single();

  if (error && error.code !== "PGRST116") {
    console.error("Failed to get request:", error);
    throw error;
  }

  return data;
}

/**
 * Get timed out requests
 */
async function getTimedOutRequests() {
  const supabase = getSupabase();
  const timeoutThreshold = new Date(
    Date.now() - config.burst.maxQueueWaitMs,
  ).toISOString();

  const { data, error } = await supabase
    .from("auth_requests")
    .select("*")
    .eq("status", config.requestStatus.PENDING)
    .lt("created_at", timeoutThreshold);

  if (error) {
    console.error("Failed to get timed out requests:", error);
    throw error;
  }

  return data || [];
}

/**
 * Mark request as timed out
 */
async function markRequestTimedOut(requestId) {
  const supabase = getSupabase();

  const { error } = await supabase
    .from("auth_requests")
    .update({
      status: config.requestStatus.TIMEOUT,
      completed_at: new Date().toISOString(),
    })
    .eq("id", requestId);

  if (error) {
    console.error("Failed to mark request timed out:", error);
    throw error;
  }
}

// =============================================================================
// Metrics & Scaling
// =============================================================================

/**
 * Get scaling metrics for auto-scaler decisions
 */
async function getScalingMetrics() {
  const supabase = getSupabase();

  const { data, error } = await supabase.rpc("get_scaling_metrics");

  if (error) {
    console.error("Failed to get scaling metrics:", error);
    throw error;
  }

  return data && data.length > 0 ? data[0] : null;
}

/**
 * Get idle instances (no activity for idleTimeoutMs)
 */
async function getIdleInstances() {
  const supabase = getSupabase();
  const idleThreshold = new Date(
    Date.now() - config.instances.idleTimeoutMs,
  ).toISOString();

  const { data, error } = await supabase
    .from("streaming_instances")
    .select("*")
    .eq("status", config.status.WARM)
    .eq("current_sessions", 0)
    .lt("last_activity_at", idleThreshold);

  if (error) {
    console.error("Failed to get idle instances:", error);
    throw error;
  }

  return data || [];
}

// =============================================================================
// Event Logging
// =============================================================================

/**
 * Log an instance event for audit trail
 */
async function logEvent(instanceId, eventType, details = {}) {
  const supabase = getSupabase();

  const { error } = await supabase.from("instance_events").insert({
    instance_id: instanceId,
    event_type: eventType,
    details,
  });

  if (error) {
    console.error("Failed to log event:", error);
    // Don't throw - logging failures shouldn't break operations
  }
}

module.exports = {
  getSupabase,

  // Instance operations
  registerInstance,
  updateInstance,
  setInstanceReady,
  getInstance,
  getInstancesByStatus,
  findAvailableInstance,
  setInstanceHibernating,
  setInstanceStopped,
  deleteInstance,
  incrementHealthFailures,
  resetHealthFailures,

  // Request queue operations
  enqueueRequest,
  getPendingCount,
  getNextPendingRequest,
  assignRequestToInstance,
  releaseSession,
  getQueuePosition,
  getRequest,
  getTimedOutRequests,
  markRequestTimedOut,

  // Metrics
  getScalingMetrics,
  getIdleInstances,

  // Logging
  logEvent,
};
