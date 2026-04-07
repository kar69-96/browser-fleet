/**
 * EC2 SDK operations for instance management
 */

const {
  EC2Client,
  StartInstancesCommand,
  StopInstancesCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  DescribeInstancesCommand,
  waitUntilInstanceRunning,
  waitUntilInstanceStopped,
} = require("@aws-sdk/client-ec2");

const config = require("./config");

let ec2Client = null;

/**
 * Get or create EC2 client
 */
function getEC2Client() {
  if (!ec2Client) {
    ec2Client = new EC2Client({ region: config.aws.region });
  }
  return ec2Client;
}

/**
 * Get user data script for instance startup
 * Note: config values are injected directly into the script since this runs as bash on EC2
 */
function getUserDataScript() {
  // Inject config values directly - these won't be substituted inside the bash script otherwise
  const apiBaseUrl = config.api.baseUrl;
  const internalApiKey = config.api.internalApiKey || "";
  const tunnelToken = config.cloudflare.tunnelToken || "";
  const tunnelUrl = config.cloudflare.tunnelUrl;

  const script = `#!/bin/bash
set -e

# Log everything
exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1

echo "Starting streaming auth server setup..."

# Get instance ID from metadata
INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
echo "Instance ID: $INSTANCE_ID"

# Fixed tunnel URL (named tunnel via token)
TUNNEL_URL="${tunnelUrl}"
echo "Using named tunnel URL: $TUNNEL_URL"

# Start cloudflared with named tunnel token
echo "Starting cloudflared named tunnel..."
TUNNEL_TOKEN="${tunnelToken}"

if [ -n "$TUNNEL_TOKEN" ]; then
  # Use named tunnel with token - provides stable URL
  cloudflared tunnel run --token "$TUNNEL_TOKEN" > /var/log/cloudflared.log 2>&1 &
  echo "Named tunnel started with token"
else
  # Fallback to quick tunnel (random URL) if no token configured
  echo "WARNING: No tunnel token configured, using quick tunnel (random URL)"
  cloudflared tunnel --url http://localhost:3002 --logfile /var/log/cloudflared.log &
  sleep 5

  # Wait for random tunnel URL
  for i in {1..30}; do
    TUNNEL_URL=$(grep -oP 'https://[a-z0-9-]+\\.trycloudflare\\.com' /var/log/cloudflared.log | tail -1)
    if [ -n "$TUNNEL_URL" ]; then
      echo "Quick tunnel URL: $TUNNEL_URL"
      break
    fi
    echo "Waiting for tunnel URL... attempt $i"
    sleep 2
  done

  if [ -z "$TUNNEL_URL" ]; then
    echo "ERROR: Failed to get tunnel URL"
    exit 1
  fi
fi

# Wait for tunnel to establish connection
sleep 5

# Start streaming auth server
echo "Starting streaming server..."
cd /home/ec2-user/streaming-server
export NODE_ENV=production
export STREAMING_PORT=3002
pm2 start server.js --name streaming-auth

# Wait for streaming server to be ready
sleep 5

# Signal ready to instance manager
echo "Signaling ready to instance manager..."
curl -X POST "${apiBaseUrl}/api/internal/instance-ready" \\
  -H "Content-Type: application/json" \\
  -H "X-Internal-Key: ${internalApiKey}" \\
  -d "{\\"instanceId\\": \\"$INSTANCE_ID\\", \\"tunnelUrl\\": \\"$TUNNEL_URL\\"}"

echo "Setup complete!"
`;

  return Buffer.from(script).toString("base64");
}

/**
 * Start a stopped/hibernated instance
 */
async function startInstance(instanceId) {
  const ec2 = getEC2Client();

  console.log(`Starting instance: ${instanceId}`);

  const command = new StartInstancesCommand({
    InstanceIds: [instanceId],
  });

  const result = await ec2.send(command);
  console.log(`Start command sent for instance: ${instanceId}`);

  return result;
}

/**
 * Stop an instance (with hibernation if supported)
 */
async function stopInstance(instanceId, hibernate = true) {
  const ec2 = getEC2Client();

  console.log(`Stopping instance: ${instanceId} (hibernate: ${hibernate})`);

  const command = new StopInstancesCommand({
    InstanceIds: [instanceId],
    Hibernate: hibernate,
  });

  const result = await ec2.send(command);
  console.log(`Stop command sent for instance: ${instanceId}`);

  return result;
}

/**
 * Launch a new instance from AMI
 */
async function launchInstance() {
  const ec2 = getEC2Client();

  if (!config.aws.amiId) {
    throw new Error("EC2_AMI_ID must be set to launch new instances");
  }

  console.log("Launching new instance...");

  const command = new RunInstancesCommand({
    ImageId: config.aws.amiId,
    InstanceType: config.aws.instanceType,
    MinCount: 1,
    MaxCount: 1,
    KeyName: config.aws.keyPairName,
    SecurityGroupIds:
      config.aws.securityGroupIds.length > 0
        ? config.aws.securityGroupIds
        : undefined,
    SubnetId: config.aws.subnetId || undefined,
    IamInstanceProfile: config.aws.iamInstanceProfile
      ? { Name: config.aws.iamInstanceProfile }
      : undefined,
    UserData: getUserDataScript(),
    TagSpecifications: [
      {
        ResourceType: "instance",
        Tags: [
          { Key: "Name", Value: config.tags.service },
          { Key: "Service", Value: config.tags.service },
          { Key: "ManagedBy", Value: config.tags.managedBy },
          { Key: "Environment", Value: config.tags.environment },
        ],
      },
    ],
    HibernationOptions: {
      Configured: true,
    },
    MetadataOptions: {
      HttpTokens: "optional", // Allow IMDSv1 for simpler scripts
      HttpEndpoint: "enabled",
    },
  });

  const result = await ec2.send(command);
  const instanceId = result.Instances[0].InstanceId;

  console.log(`Launched new instance: ${instanceId}`);

  return instanceId;
}

/**
 * Terminate an instance
 */
async function terminateInstance(instanceId) {
  const ec2 = getEC2Client();

  console.log(`Terminating instance: ${instanceId}`);

  const command = new TerminateInstancesCommand({
    InstanceIds: [instanceId],
  });

  const result = await ec2.send(command);
  console.log(`Terminate command sent for instance: ${instanceId}`);

  return result;
}

/**
 * Get instance details from EC2
 */
async function describeInstance(instanceId) {
  const ec2 = getEC2Client();

  const command = new DescribeInstancesCommand({
    InstanceIds: [instanceId],
  });

  const result = await ec2.send(command);

  if (result.Reservations && result.Reservations.length > 0) {
    const instances = result.Reservations[0].Instances;
    if (instances && instances.length > 0) {
      return instances[0];
    }
  }

  return null;
}

/**
 * Get all managed instances
 */
async function describeManagedInstances() {
  const ec2 = getEC2Client();

  const command = new DescribeInstancesCommand({
    Filters: [
      {
        Name: "tag:Service",
        Values: [config.tags.service],
      },
      {
        Name: "tag:ManagedBy",
        Values: [config.tags.managedBy],
      },
      {
        Name: "instance-state-name",
        Values: ["pending", "running", "stopping", "stopped"],
      },
    ],
  });

  const result = await ec2.send(command);

  const instances = [];
  if (result.Reservations) {
    for (const reservation of result.Reservations) {
      if (reservation.Instances) {
        instances.push(...reservation.Instances);
      }
    }
  }

  return instances;
}

/**
 * Wait for instance to be running
 */
async function waitForInstanceRunning(instanceId, maxWaitTimeSeconds = 120) {
  const ec2 = getEC2Client();

  console.log(`Waiting for instance ${instanceId} to be running...`);

  try {
    await waitUntilInstanceRunning(
      {
        client: ec2,
        maxWaitTime: maxWaitTimeSeconds,
      },
      {
        InstanceIds: [instanceId],
      },
    );

    console.log(`Instance ${instanceId} is now running`);
    return true;
  } catch (error) {
    console.error(`Timeout waiting for instance ${instanceId} to run:`, error);
    return false;
  }
}

/**
 * Wait for instance to be stopped
 */
async function waitForInstanceStopped(instanceId, maxWaitTimeSeconds = 120) {
  const ec2 = getEC2Client();

  console.log(`Waiting for instance ${instanceId} to be stopped...`);

  try {
    await waitUntilInstanceStopped(
      {
        client: ec2,
        maxWaitTime: maxWaitTimeSeconds,
      },
      {
        InstanceIds: [instanceId],
      },
    );

    console.log(`Instance ${instanceId} is now stopped`);
    return true;
  } catch (error) {
    console.error(`Timeout waiting for instance ${instanceId} to stop:`, error);
    return false;
  }
}

/**
 * Map EC2 state to our internal status
 */
function mapEC2StateToStatus(ec2State) {
  switch (ec2State) {
    case "pending":
      return config.status.STARTING;
    case "running":
      return config.status.WARM;
    case "stopping":
      return config.status.HIBERNATING;
    case "stopped":
      return config.status.STOPPED;
    case "shutting-down":
    case "terminated":
      return config.status.TERMINATING;
    default:
      return config.status.STARTING;
  }
}

/**
 * Get instance public IP
 */
async function getInstancePublicIp(instanceId) {
  const instance = await describeInstance(instanceId);
  return instance?.PublicIpAddress || null;
}

/**
 * Check if instance is in a running state
 */
async function isInstanceRunning(instanceId) {
  const instance = await describeInstance(instanceId);
  return instance?.State?.Name === "running";
}

/**
 * Check if instance is stopped/hibernated
 */
async function isInstanceStopped(instanceId) {
  const instance = await describeInstance(instanceId);
  return instance?.State?.Name === "stopped";
}

module.exports = {
  getEC2Client,
  startInstance,
  stopInstance,
  launchInstance,
  terminateInstance,
  describeInstance,
  describeManagedInstances,
  waitForInstanceRunning,
  waitForInstanceStopped,
  mapEC2StateToStatus,
  getInstancePublicIp,
  isInstanceRunning,
  isInstanceStopped,
};
