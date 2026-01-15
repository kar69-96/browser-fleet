#!/usr/bin/env node
/**
 * AWS EC2 Instance Manager
 * Handles starting and stopping (hibernating) EC2 instances for extraction jobs
 */

const { EC2Client, StartInstancesCommand, StopInstancesCommand, DescribeInstancesCommand } = require('@aws-sdk/client-ec2');

// Configuration from environment variables
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const AWS_INSTANCE_ID = process.env.AWS_INSTANCE_ID;
const AWS_WAIT_FOR_RUNNING = process.env.AWS_WAIT_FOR_RUNNING !== 'false'; // Default: wait for instance to be running
const AWS_WAIT_FOR_STOPPED = process.env.AWS_WAIT_FOR_STOPPED !== 'false'; // Default: wait for instance to be stopped

// Initialize EC2 client
const ec2Client = new EC2Client({ region: AWS_REGION });

/**
 * Wait for instance to reach a specific state
 */
async function waitForInstanceState(instanceId, targetState, maxWaitTime = 300000) {
  const startTime = Date.now();
  const pollInterval = 5000; // Check every 5 seconds

  console.log(`⏳ Waiting for instance ${instanceId} to reach state: ${targetState}...`);

  while (Date.now() - startTime < maxWaitTime) {
    try {
      const command = new DescribeInstancesCommand({
        InstanceIds: [instanceId]
      });
      const response = await ec2Client.send(command);

      if (response.Reservations && response.Reservations.length > 0) {
        const instance = response.Reservations[0].Instances[0];
        const currentState = instance.State.Name;

        if (currentState === targetState) {
          console.log(`✅ Instance ${instanceId} is now ${targetState}`);
          return true;
        }

        // If we're waiting for 'running' but it's 'stopped', it won't reach running
        if (targetState === 'running' && currentState === 'stopped') {
          console.log(`⚠️  Instance ${instanceId} is stopped and cannot reach running state`);
          return false;
        }

        // If we're waiting for 'stopped' but it's 'terminated', it's already stopped
        if (targetState === 'stopped' && currentState === 'terminated') {
          console.log(`⚠️  Instance ${instanceId} is terminated`);
          return false;
        }

        process.stdout.write(`   Current state: ${currentState}...\r`);
      }
    } catch (error) {
      console.error(`\n❌ Error checking instance state: ${error.message}`);
      return false;
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  console.log(`\n⚠️  Timeout waiting for instance ${instanceId} to reach ${targetState}`);
  return false;
}

/**
 * Get current instance state
 */
async function getInstanceState(instanceId) {
  try {
    const command = new DescribeInstancesCommand({
      InstanceIds: [instanceId]
    });
    const response = await ec2Client.send(command);

    if (response.Reservations && response.Reservations.length > 0) {
      const instance = response.Reservations[0].Instances[0];
      return instance.State.Name;
    }

    return null;
  } catch (error) {
    console.error(`❌ Error getting instance state: ${error.message}`);
    return null;
  }
}

/**
 * Get instance type and details
 */
async function getInstanceDetails(instanceId) {
  try {
    const command = new DescribeInstancesCommand({
      InstanceIds: [instanceId]
    });
    const response = await ec2Client.send(command);

    if (response.Reservations && response.Reservations.length > 0) {
      const instance = response.Reservations[0].Instances[0];
      return {
        instanceType: instance.InstanceType,
        state: instance.State.Name,
        publicIp: instance.PublicIpAddress,
        privateIp: instance.PrivateIpAddress
      };
    }

    return null;
  } catch (error) {
    console.error(`❌ Error getting instance details: ${error.message}`);
    return null;
  }
}

/**
 * Start EC2 instance (resumes from hibernation if applicable)
 */
async function startInstance(instanceId = AWS_INSTANCE_ID) {
  if (!instanceId) {
    console.error('❌ Error: AWS_INSTANCE_ID environment variable is not set');
    return { success: false, error: 'AWS_INSTANCE_ID not set' };
  }

  try {
    // Check current state first
    let currentState = await getInstanceState(instanceId);
    console.log(`\n🔍 Current instance state: ${currentState || 'unknown'}`);

    if (currentState === 'running') {
      console.log(`✅ Instance ${instanceId} is already running`);
      return { success: true, alreadyRunning: true, state: 'running' };
    }

    if (currentState === 'terminated') {
      console.error(`❌ Instance ${instanceId} is terminated and cannot be started`);
      return { success: false, error: 'Instance is terminated' };
    }

    // Handle transitional states
    if (currentState === 'stopping') {
      console.log(`⏳ Instance is currently stopping. Waiting for it to finish...`);
      const stopped = await waitForInstanceState(instanceId, 'stopped', 300000); // Wait up to 5 minutes
      if (!stopped) {
        return { success: false, error: 'Instance did not finish stopping within timeout' };
      }
      console.log(`✅ Instance has finished stopping`);
      currentState = 'stopped';
    }

    if (currentState === 'starting') {
      console.log(`⏳ Instance is currently starting. Waiting for it to finish...`);
      const running = await waitForInstanceState(instanceId, 'running', 300000); // Wait up to 5 minutes
      if (!running) {
        return { success: false, error: 'Instance did not finish starting within timeout' };
      }
      console.log(`✅ Instance has finished starting`);
      // Get public IP and return
      const publicIp = await getInstancePublicIp(instanceId);
      return {
        success: true,
        state: 'running',
        publicIp: publicIp,
        instanceId: instanceId,
        alreadyRunning: false
      };
    }

    if (currentState === 'pending') {
      console.log(`⏳ Instance is currently pending. Waiting for it to start...`);
      const running = await waitForInstanceState(instanceId, 'running', 300000); // Wait up to 5 minutes
      if (!running) {
        return { success: false, error: 'Instance did not finish starting within timeout' };
      }
      console.log(`✅ Instance has finished starting`);
      // Get public IP and return
      const publicIp = await getInstancePublicIp(instanceId);
      return {
        success: true,
        state: 'running',
        publicIp: publicIp,
        instanceId: instanceId,
        alreadyRunning: false
      };
    }

    // Check if instance is hibernated (stopped state could be from hibernation)
    const isHibernated = currentState === 'stopped';
    const actionText = isHibernated ? 'Resuming EC2 instance from hibernation' : 'Starting EC2 instance';
    console.log(`🚀 ${actionText}: ${instanceId}...`);

    const command = new StartInstancesCommand({
      InstanceIds: [instanceId]
    });

    const response = await ec2Client.send(command);

    if (response.StartingInstances && response.StartingInstances.length > 0) {
      const instance = response.StartingInstances[0];
      const actionText2 = isHibernated ? 'Instance resume from hibernation initiated' : 'Instance start initiated';
      console.log(`✅ ${actionText2}. Current state: ${instance.CurrentState.Name}`);

      // Wait for instance to be running if configured
      if (AWS_WAIT_FOR_RUNNING) {
        const reachedRunning = await waitForInstanceState(instanceId, 'running');
        if (reachedRunning) {
          // Get the public IP address (with retry logic - IP may take a few seconds to assign)
          console.log(`   ⏳ Waiting for public IP assignment...`);
          const publicIp = await getInstancePublicIp(instanceId);

          return {
            success: true,
            state: 'running',
            publicIp: publicIp,
            instanceId: instanceId,
            resumedFromHibernation: isHibernated
          };
        }
      }

      return { success: true, state: instance.CurrentState.Name, instanceId: instanceId };
    }

    return { success: false, error: 'No instance in response' };
  } catch (error) {
    // Provide more helpful error messages
    let errorMessage = error.message;
    if (errorMessage.includes('not in a state from which it can be started')) {
      const currentState = await getInstanceState(instanceId);
      errorMessage = `Instance is in '${currentState}' state and cannot be started. Please wait for it to finish its current operation.`;
      console.error(`❌ Error starting instance: ${errorMessage}`);
    } else {
      console.error(`❌ Error starting instance: ${errorMessage}`);
    }
    return { success: false, error: errorMessage };
  }
}

/**
 * Get public IP address of instance (with retry logic)
 * Sometimes the public IP takes a few seconds to be assigned after instance starts
 */
async function getInstancePublicIp(instanceId = AWS_INSTANCE_ID, maxRetries = 12, retryDelay = 5000) {
  if (!instanceId) {
    return null;
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const command = new DescribeInstancesCommand({
        InstanceIds: [instanceId]
      });
      const response = await ec2Client.send(command);

      if (response.Reservations && response.Reservations.length > 0) {
        const instance = response.Reservations[0].Instances[0];
        const publicIp = instance.PublicIpAddress;

        if (publicIp) {
          if (attempt > 1) {
            console.log(`   ✅ Public IP assigned: ${publicIp} (after ${attempt} attempts)`);
          }
          return publicIp;
        }

        // If no public IP yet, wait and retry
        if (attempt < maxRetries) {
          process.stdout.write(`   ⏳ Waiting for public IP assignment (attempt ${attempt}/${maxRetries})...\r`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    } catch (error) {
      console.error(`\n❌ Error getting instance IP: ${error.message}`);
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }

  // If we get here, we couldn't get a public IP
  // Check if instance is in a VPC without public IP or needs Elastic IP
  try {
    const command = new DescribeInstancesCommand({
      InstanceIds: [instanceId]
    });
    const response = await ec2Client.send(command);

    if (response.Reservations && response.Reservations.length > 0) {
      const instance = response.Reservations[0].Instances[0];
      const privateIp = instance.PrivateIpAddress;
      const networkInterfaces = instance.NetworkInterfaces || [];

      console.log(`\n⚠️  No public IP found after ${maxRetries} attempts`);
      console.log(`   Instance state: ${instance.State.Name}`);
      console.log(`   Private IP: ${privateIp || 'none'}`);
      console.log(`   Network interfaces: ${networkInterfaces.length}`);

      // Check if instance has an Elastic IP associated
      if (networkInterfaces.length > 0) {
        const eni = networkInterfaces[0];
        if (eni.Association && eni.Association.PublicIp) {
          console.log(`   ✅ Found Elastic IP: ${eni.Association.PublicIp}`);
          return eni.Association.PublicIp;
        }
      }

      console.log(`   💡 Tip: Instance may need an Elastic IP or be in a subnet with auto-assign public IP enabled`);
    }
  } catch (error) {
    // Ignore error in diagnostic check
  }

  return null;
}

/**
 * Wait for SSH to be ready on instance
 * Tests both port connectivity and actual SSH authentication
 */
async function waitForSSH(publicIp, maxWaitTime = 120000, keyFile = null) {
  const net = require('net');
  const { spawn } = require('child_process');

  const startTime = Date.now();
  const pollInterval = 5000; // Check every 5 seconds
  const sshUser = process.env.AWS_SSH_USER || 'ec2-user';

  console.log(`⏳ Waiting for SSH to be ready on ${publicIp}...`);

  // First, wait for port 22 to be open
  let portOpen = false;
  while (Date.now() - startTime < maxWaitTime && !portOpen) {
    try {
      const socket = new net.Socket();
      const connected = await new Promise((resolve) => {
        socket.setTimeout(2000);
        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.once('timeout', () => {
          socket.destroy();
          resolve(false);
        });
        socket.once('error', () => {
          socket.destroy();
          resolve(false);
        });
        socket.connect(22, publicIp);
      });

      if (connected) {
        portOpen = true;
        console.log(`   ✅ Port 22 is open`);
      }
    } catch (error) {
      // Continue waiting
    }

    if (!portOpen) {
      process.stdout.write(`   Waiting for port 22...\r`);
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  }

  if (!portOpen) {
    console.log(`\n⚠️  Timeout waiting for port 22 on ${publicIp}`);
    return false;
  }

  // Now test actual SSH authentication if key file is provided
  if (keyFile) {
    console.log(`   ⏳ Testing SSH authentication...`);
    const testStartTime = Date.now();
    const authTimeout = Math.min(60000, maxWaitTime - (Date.now() - startTime)); // Up to 1 minute for auth test

    while (Date.now() - testStartTime < authTimeout) {
      try {
        const testResult = await new Promise((resolve) => {
          const sshCommand = `ssh -i "${keyFile}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o BatchMode=yes ${sshUser}@${publicIp} "echo 'SSH_OK'" 2>&1`;
          const test = spawn('sh', ['-c', sshCommand], {
            stdio: ['ignore', 'pipe', 'pipe']
          });

          let stdout = '';
          let stderr = '';

          test.stdout.on('data', (data) => {
            stdout += data.toString();
          });

          test.stderr.on('data', (data) => {
            stderr += data.toString();
          });

          test.on('close', (code) => {
            if (code === 0 && stdout.includes('SSH_OK')) {
              resolve({ success: true });
            } else {
              // Check for common errors that indicate SSH isn't ready yet
              const errorOutput = (stderr + stdout).toLowerCase();
              if (errorOutput.includes('connection refused') ||
                  errorOutput.includes('connection timed out') ||
                  errorOutput.includes('connection reset')) {
                resolve({ success: false, retry: true });
              } else {
                // Other errors (like auth failures) are real problems
                resolve({ success: false, retry: false, error: stderr || stdout });
              }
            }
          });

          test.on('error', () => {
            resolve({ success: false, retry: true });
          });
        });

        if (testResult.success) {
          console.log(`✅ SSH authentication successful`);
          return true;
        } else if (!testResult.retry) {
          // Real error, not just "not ready yet"
          console.log(`\n⚠️  SSH authentication test failed: ${testResult.error || 'Unknown error'}`);
          return false;
        }
      } catch (error) {
        // Continue waiting
      }

      process.stdout.write(`   Waiting for SSH service...\r`);
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    console.log(`\n⚠️  Timeout waiting for SSH service to be ready on ${publicIp}`);
    return false;
  }

  // If no key file provided, just return port status
  console.log(`✅ Port 22 is open (authentication not tested - no key file provided)`);
  return true;
}

/**
 * Stop EC2 instance (hibernate)
 */
async function stopInstance(instanceId = AWS_INSTANCE_ID) {
  if (!instanceId) {
    console.error('❌ Error: AWS_INSTANCE_ID environment variable is not set');
    return { success: false, error: 'AWS_INSTANCE_ID not set' };
  }

  try {
    // Check current state first
    const currentState = await getInstanceState(instanceId);
    console.log(`\n🔍 Current instance state: ${currentState || 'unknown'}`);

    if (currentState === 'stopped' || currentState === 'stopping') {
      console.log(`✅ Instance ${instanceId} is already ${currentState}`);
      return { success: true, alreadyStopped: true, state: currentState };
    }

    if (currentState === 'terminated') {
      console.log(`⚠️  Instance ${instanceId} is already terminated`);
      return { success: true, alreadyStopped: true, state: 'terminated' };
    }

    // Try hibernation first, fall back to regular stop if not supported
    console.log(`💤 Attempting to hibernate EC2 instance: ${instanceId}...`);

    try {
      const command = new StopInstancesCommand({
        InstanceIds: [instanceId],
        Hibernate: true
      });

      const response = await ec2Client.send(command);

      if (response.StoppingInstances && response.StoppingInstances.length > 0) {
        const instance = response.StoppingInstances[0];
        console.log(`✅ Instance hibernate initiated. Current state: ${instance.CurrentState.Name}`);

        // Wait for instance to be stopped if configured
        if (AWS_WAIT_FOR_STOPPED) {
          const reachedStopped = await waitForInstanceState(instanceId, 'stopped');
          if (reachedStopped) {
            return { success: true, state: 'stopped', hibernated: true, instanceId: instanceId };
          }
        }

        return { success: true, state: instance.CurrentState.Name, hibernated: true, instanceId: instanceId };
      }

      return { success: false, error: 'No instance in response' };
    } catch (hibernateError) {
      // If hibernation fails (not supported), fall back to regular stop
      if (hibernateError.message && hibernateError.message.includes('hibernation')) {
        console.log(`⚠️  Hibernation not supported, falling back to regular stop...`);

        const stopCommand = new StopInstancesCommand({
          InstanceIds: [instanceId]
        });

        const stopResponse = await ec2Client.send(stopCommand);

        if (stopResponse.StoppingInstances && stopResponse.StoppingInstances.length > 0) {
          const instance = stopResponse.StoppingInstances[0];
          console.log(`✅ Instance stop initiated. Current state: ${instance.CurrentState.Name}`);

          // Wait for instance to be stopped if configured
          if (AWS_WAIT_FOR_STOPPED) {
            const reachedStopped = await waitForInstanceState(instanceId, 'stopped');
            if (reachedStopped) {
              return { success: true, state: 'stopped', hibernated: false, instanceId: instanceId };
            }
          }

          return { success: true, state: instance.CurrentState.Name, hibernated: false, instanceId: instanceId };
        }

        return { success: false, error: 'No instance in response' };
      }

      // Re-throw if it's a different error
      throw hibernateError;
    }
  } catch (error) {
    console.error(`❌ Error stopping instance: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * High-level function: Ensure instance is ready and return connection info
 * Handles starting instance, waiting for SSH, etc.
 */
async function ensureInstanceReady(instanceId, publicIp = null, keyFile = null) {
  if (!instanceId) {
    return { success: false, error: 'AWS_INSTANCE_ID not set' };
  }

  console.log('\n☁️  AWS EC2 Instance Management');
  console.log(`   Instance ID: ${instanceId}`);
  console.log(`   Region: ${AWS_REGION}`);

  // Check current state
  const currentState = await getInstanceState(instanceId);
  let wasAlreadyRunning = false;

  if (currentState === 'running') {
    console.log('✅ Instance is already running');
    wasAlreadyRunning = true;

    // Get public IP if not provided
    if (!publicIp) {
      publicIp = await getInstancePublicIp(instanceId);
      if (!publicIp) {
        return { success: false, error: 'Could not get public IP address of running instance' };
      }
    }
    console.log(`   Public IP: ${publicIp}`);
  } else {
    // Start the instance
    console.log(`🚀 Starting instance (current state: ${currentState || 'unknown'})...`);
    const startResult = await startInstance(instanceId);

    if (!startResult.success) {
      return { success: false, error: `Failed to start instance: ${startResult.error}` };
    }

    // Get public IP (with retry logic - may take a few seconds to assign)
    if (!startResult.publicIp) {
      console.log(`   ⏳ Waiting for public IP assignment...`);
    }
    publicIp = startResult.publicIp || await getInstancePublicIp(instanceId);
    if (!publicIp) {
      // Provide helpful error message
      console.error(`\n❌ Could not get public IP address after starting instance`);
      console.error(`   This may happen if:`);
      console.error(`   - Instance is in a VPC subnet without auto-assign public IP enabled`);
      console.error(`   - Instance needs an Elastic IP address`);
      console.error(`   - Network interface configuration issue`);
      console.error(`   💡 Check your EC2 instance's subnet settings or assign an Elastic IP`);
      return { success: false, error: 'Could not get public IP address after starting instance' };
    }
    console.log(`   Public IP: ${publicIp}`);

    // Wait for SSH to be ready (with authentication test if key file provided)
    const sshReady = await waitForSSH(publicIp, 120000, keyFile);
    if (!sshReady) {
      return { success: false, error: 'SSH not ready after timeout' };
    }
  }

  return {
    success: true,
    publicIp,
    instanceId,
    wasAlreadyRunning
  };
}

/**
 * Execute command on AWS instance via SSH with real-time output streaming
 */
async function executeCommand(publicIp, command, keyFile, timeoutMs = 3600000) {
  if (!keyFile) {
    return { success: false, error: 'AWS_KEY_FILE is required for SSH access' };
  }

  const { spawn } = require('child_process');

  const sshUser = process.env.AWS_SSH_USER || 'ec2-user';
  const sshCommand = `ssh -i "${keyFile}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 ${sshUser}@${publicIp} "${command}"`;

  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', sshCommand], {
      env: { ...process.env },
      stdio: ['inherit', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timeoutId = null;
    let lastActivityTime = Date.now();

    // Set overall timeout (default 1 hour for long-running extractions)
    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        if (!child.killed) {
          console.error(`\n⚠️  Command timeout after ${timeoutMs / 1000}s, killing process...`);
          child.kill('SIGTERM');
          setTimeout(() => {
            if (!child.killed) {
              child.kill('SIGKILL');
            }
          }, 5000);
          resolve({
            success: false,
            error: `Command timed out after ${timeoutMs / 1000} seconds`,
            stdout,
            stderr,
            exitCode: -1
          });
        }
      }, timeoutMs);
    }

    // Track activity to detect hangs
    const activityCheck = setInterval(() => {
      const timeSinceActivity = Date.now() - lastActivityTime;
      // If no activity for 10 minutes, consider it hung
      if (timeSinceActivity > 600000) {
        console.error(`\n⚠️  No activity for ${Math.round(timeSinceActivity / 1000)}s, command may be hung`);
      }
    }, 60000); // Check every minute

    // Stream stdout in real-time
    child.stdout.on('data', (data) => {
      const output = data.toString();
      stdout += output;
      lastActivityTime = Date.now();
      process.stdout.write(output); // Write to console immediately
    });

    // Stream stderr in real-time
    child.stderr.on('data', (data) => {
      const output = data.toString();
      stderr += output;
      lastActivityTime = Date.now();
      process.stderr.write(output); // Write to console immediately
    });

    child.on('close', (code) => {
      if (timeoutId) clearTimeout(timeoutId);
      clearInterval(activityCheck);
      resolve({
        success: code === 0,
        stdout,
        stderr,
        exitCode: code
      });
    });

    child.on('error', (error) => {
      if (timeoutId) clearTimeout(timeoutId);
      clearInterval(activityCheck);
      resolve({
        success: false,
        error: error.message,
        stdout,
        stderr
      });
    });
  });
}

/**
 * Cleanup: Stop instance when extraction completes
 * @param {string} instanceId - The instance ID to stop
 * @param {boolean} wasAlreadyRunning - Whether instance was already running (for logging)
 * @param {boolean} forceStop - If true, stop instance even if it was already running (default: true)
 */
async function cleanup(instanceId, wasAlreadyRunning, forceStop = true) {
  if (!forceStop && wasAlreadyRunning) {
    console.log('\n☁️  Instance was already running - keeping it running');
    return { success: true, message: 'Instance kept running' };
  }

  if (wasAlreadyRunning) {
    console.log('\n☁️  Hibernating AWS EC2 instance (extraction completed)...');
  } else {
    console.log('\n☁️  Hibernating AWS EC2 instance (we started it)...');
  }

  const stopResult = await stopInstance(instanceId);

  if (stopResult.success) {
    console.log('✅ AWS instance hibernated successfully');
    return { success: true };
  } else {
    console.error(`❌ Failed to hibernate AWS instance: ${stopResult.error}`);
    console.error('   Please hibernate the instance manually to avoid charges!');
    return { success: false, error: stopResult.error };
  }
}

/**
 * Simple HTTP health check for noVNC
 */
async function checkNoVncHealth(publicIp, port = 80, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const url = `http://${publicIp}:${port}`;

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return { success: res.ok, status: res.status };
  } catch (error) {
    clearTimeout(timeout);
    return { success: false, error: error.message };
  }
}

module.exports = {
  // Low-level functions
  startInstance,
  stopInstance,
  getInstanceState,
  getInstanceDetails,
  waitForInstanceState,
  getInstancePublicIp,
  waitForSSH,
  // High-level functions
  ensureInstanceReady,
  executeCommand,
  cleanup,
  checkNoVncHealth
};
