#!/usr/bin/env node
/**
 * Force Stop AWS EC2 Instance
 * Forces an EC2 instance to stop immediately (does not attempt hibernation)
 */

// Load .env file if it exists
const path = require('path');
const fs = require('fs');
const envPath = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const [key, ...valueParts] = trimmed.split('=');
      const value = valueParts.join('=').replace(/^["']|["']$/g, '');
      if (key && value) {
        process.env[key.trim()] = value.trim();
      }
    }
  });
}

const { EC2Client, StopInstancesCommand, DescribeInstancesCommand } = require('@aws-sdk/client-ec2');
const { getInstanceState, waitForInstanceState } = require('./utils/aws-ec2-manager.js');

// Configuration
const AWS_INSTANCE_ID = process.env.AWS_INSTANCE_ID;
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

// Initialize EC2 client
const ec2Client = new EC2Client({ region: AWS_REGION });

/**
 * Force stop EC2 instance
 */
async function forceStopInstance(instanceId) {
  if (!instanceId) {
    console.error('❌ Error: AWS_INSTANCE_ID environment variable is required');
    process.exit(1);
  }

  try {
    // Check current state first
    const currentState = await getInstanceState(instanceId);
    console.log(`\n🔍 Current instance state: ${currentState || 'unknown'}`);

    if (currentState === 'stopped') {
      console.log(`✅ Instance ${instanceId} is already stopped`);
      return { success: true, alreadyStopped: true };
    }

    if (currentState === 'stopping') {
      console.log(`⏳ Instance is already stopping. Waiting for it to finish...`);
      const stopped = await waitForInstanceState(instanceId, 'stopped', 300000);
      if (stopped) {
        console.log(`✅ Instance has finished stopping`);
        return { success: true, alreadyStopped: true };
      } else {
        console.log(`⚠️  Instance did not finish stopping within timeout`);
        return { success: false, error: 'Timeout waiting for instance to stop' };
      }
    }

    if (currentState === 'terminated') {
      console.log(`⚠️  Instance ${instanceId} is already terminated`);
      return { success: true, alreadyStopped: true };
    }

    // Force stop the instance (no hibernation)
    console.log(`🛑 Force stopping EC2 instance: ${instanceId}...`);

    const command = new StopInstancesCommand({
      InstanceIds: [instanceId],
      Force: true  // Force stop immediately
    });

    const response = await ec2Client.send(command);

    if (response.StoppingInstances && response.StoppingInstances.length > 0) {
      const instance = response.StoppingInstances[0];
      console.log(`✅ Force stop initiated. Current state: ${instance.CurrentState.Name}`);

      // Wait for instance to be stopped
      console.log(`⏳ Waiting for instance to stop...`);
      const reachedStopped = await waitForInstanceState(instanceId, 'stopped', 300000);

      if (reachedStopped) {
        console.log(`✅ Instance has been force stopped successfully`);
        return { success: true, state: 'stopped', instanceId: instanceId };
      } else {
        console.log(`⚠️  Instance stop initiated but did not reach stopped state within timeout`);
        return { success: true, state: instance.CurrentState.Name, instanceId: instanceId };
      }
    }

    return { success: false, error: 'No instance in response' };
  } catch (error) {
    console.error(`❌ Error force stopping instance: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Main execution
 */
async function main() {
  console.log('🛑 Force Stop AWS EC2 Instance');
  console.log('='.repeat(60));
  console.log(`   Instance ID: ${AWS_INSTANCE_ID}`);
  console.log(`   Region: ${AWS_REGION}`);
  console.log('='.repeat(60));

  const result = await forceStopInstance(AWS_INSTANCE_ID);

  if (result.success) {
    console.log('\n✅ Force stop completed successfully');
    process.exit(0);
  } else {
    console.error(`\n❌ Force stop failed: ${result.error}`);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
  });
}

module.exports = { forceStopInstance };
