/**
 * Shared configuration for EC2 Manager Lambda functions
 *
 * All site-specific values are read from environment variables — no defaults
 * that tie this to a particular deployment.
 */

module.exports = {
  // AWS Configuration
  aws: {
    region: process.env.AWS_REGION || "us-east-1",
    instanceType: process.env.EC2_INSTANCE_TYPE || "t3.small",
    amiId: process.env.EC2_AMI_ID, // Custom AMI with Playwright pre-installed
    keyPairName: process.env.EC2_KEY_PAIR_NAME,
    securityGroupIds: (process.env.EC2_SECURITY_GROUPS || "")
      .split(",")
      .filter(Boolean),
    subnetId: process.env.EC2_SUBNET_ID,
    iamInstanceProfile: process.env.EC2_IAM_PROFILE || null, // Optional - don't require IAM profile
  },

  // Instance Management (optimized for 30+ concurrent users)
  instances: {
    minWarmInstances: parseInt(process.env.MIN_WARM_INSTANCES || "1", 10), // Keep 1 warm, scale on demand
    maxInstances: parseInt(process.env.MAX_INSTANCES || "10", 10), // 10 instances × 3 sessions = 30 users max
    maxSessionsPerInstance: parseInt(
      process.env.MAX_SESSIONS_PER_INSTANCE || "3",
      10,
    ),

    // Timeouts (in milliseconds)
    idleTimeoutMs: parseInt(
      process.env.IDLE_TIMEOUT_MS || String(5 * 60 * 1000),
      10,
    ), // 5 min
    warmTimeoutMs: parseInt(
      process.env.WARM_TIMEOUT_MS || String(15 * 60 * 1000),
      10,
    ), // 15 min
    hibernateTimeoutMs: parseInt(
      process.env.HIBERNATE_TIMEOUT_MS || String(60 * 60 * 1000),
      10,
    ), // 1 hour

    // Wait times for instance operations
    startWaitMs: parseInt(process.env.START_WAIT_MS || "30000", 10), // 30s for hibernated
    launchWaitMs: parseInt(process.env.LAUNCH_WAIT_MS || "90000", 10), // 90s for new

    // Health check configuration
    healthCheckIntervalMs: parseInt(
      process.env.HEALTH_CHECK_INTERVAL_MS || "60000",
      10,
    ), // 1 min
    maxHealthCheckFailures: parseInt(
      process.env.MAX_HEALTH_FAILURES || "3",
      10,
    ),
  },

  // Burst Handling (scale up when 2+ users waiting)
  burst: {
    scaleThreshold: parseInt(process.env.BURST_SCALE_THRESHOLD || "2", 10),
    scaleCount: parseInt(process.env.BURST_SCALE_COUNT || "1", 10),
    maxQueueWaitMs: parseInt(
      process.env.MAX_QUEUE_WAIT_MS || String(2 * 60 * 1000),
      10,
    ), // 2 min
  },

  // Supabase Configuration
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_KEY,
  },

  // API Configuration
  api: {
    baseUrl: process.env.API_BASE_URL,
    internalApiKey: process.env.INTERNAL_API_KEY,
  },

  // Cloudflare Configuration (named tunnel for stable URL)
  cloudflare: {
    tunnelToken: process.env.CLOUDFLARE_TUNNEL_TOKEN,
    tunnelUrl: process.env.CLOUDFLARE_TUNNEL_URL,
  },

  // Tags for EC2 instances
  tags: {
    service: process.env.SERVICE_TAG || "streaming-auth",
    managedBy: "ec2-manager",
    environment: process.env.NODE_ENV || "production",
  },

  // Instance status constants
  status: {
    STARTING: "starting",
    WARM: "warm",
    ACTIVE: "active",
    HIBERNATING: "hibernating",
    STOPPED: "stopped",
    TERMINATING: "terminating",
  },

  // Request status constants
  requestStatus: {
    PENDING: "pending",
    ASSIGNED: "assigned",
    IN_PROGRESS: "in_progress",
    COMPLETED: "completed",
    FAILED: "failed",
    TIMEOUT: "timeout",
  },

  // Event types for logging
  eventTypes: {
    INSTANCE_STARTING: "instance_starting",
    INSTANCE_READY: "instance_ready",
    INSTANCE_HIBERNATING: "instance_hibernating",
    INSTANCE_STOPPED: "instance_stopped",
    INSTANCE_TERMINATED: "instance_terminated",
    INSTANCE_HEALTH_FAILED: "instance_health_failed",
    SESSION_ASSIGNED: "session_assigned",
    SESSION_RELEASED: "session_released",
    SCALE_UP: "scale_up",
    SCALE_DOWN: "scale_down",
  },
};
