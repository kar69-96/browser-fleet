#!/usr/bin/env node
/**
 * Deploy and Run Streaming Cookie Extraction on AWS EC2
 * Configures security groups, installs dependencies, and runs the streaming script
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Load .env file if it exists
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

const { ensureInstanceReady, executeCommand, getInstanceDetails } = require('./utils/aws-ec2-manager.js');
const { EC2Client, DescribeInstancesCommand, AuthorizeSecurityGroupIngressCommand, DescribeSecurityGroupsCommand } = require('@aws-sdk/client-ec2');

// Configuration - all from environment variables (no hardcoded values)
const AWS_INSTANCE_ID = process.env.AWS_INSTANCE_ID;
const AWS_KEY_FILE = process.env.AWS_KEY_FILE;
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const STREAMING_PORT = parseInt(process.env.STREAMING_PORT) || 3002;
const AWS_SSH_USER = process.env.AWS_SSH_USER || 'ec2-user';
const REMOTE_DEPLOY_DIR = process.env.REMOTE_DEPLOY_DIR || '~/streaming-server';

const ec2Client = new EC2Client({ region: AWS_REGION });

/**
 * Get security group IDs for an instance
 */
async function getInstanceSecurityGroups(instanceId) {
  try {
    const command = new DescribeInstancesCommand({
      InstanceIds: [instanceId]
    });
    const response = await ec2Client.send(command);

    if (response.Reservations && response.Reservations.length > 0) {
      const instance = response.Reservations[0].Instances[0];
      return instance.SecurityGroups.map(sg => sg.GroupId);
    }

    return [];
  } catch (error) {
    console.error(`❌ Error getting security groups: ${error.message}`);
    return [];
  }
}

/**
 * Check if security group allows port
 */
async function checkSecurityGroupPort(sgId, port) {
  try {
    const command = new DescribeSecurityGroupsCommand({
      GroupIds: [sgId]
    });
    const response = await ec2Client.send(command);

    if (response.SecurityGroups && response.SecurityGroups.length > 0) {
      const sg = response.SecurityGroups[0];
      const hasRule = sg.IpPermissions.some(perm =>
        perm.FromPort <= port && perm.ToPort >= port && perm.IpProtocol === 'tcp'
      );
      return hasRule;
    }

    return false;
  } catch (error) {
    console.error(`❌ Error checking security group: ${error.message}`);
    return false;
  }
}

/**
 * Configure security group to allow streaming port
 */
async function configureSecurityGroup(instanceId, port) {
  console.log(`\n🔒 Configuring security groups for port ${port}...`);

  const securityGroupIds = await getInstanceSecurityGroups(instanceId);

  if (securityGroupIds.length === 0) {
    console.error('❌ No security groups found for instance');
    return { success: false, error: 'No security groups found' };
  }

  console.log(`   Found ${securityGroupIds.length} security group(s)`);

  for (const sgId of securityGroupIds) {
    console.log(`   Checking security group: ${sgId}`);

    const hasPort = await checkSecurityGroupPort(sgId, port);

    if (hasPort) {
      console.log(`   ✅ Port ${port} already allowed in ${sgId}`);
      continue;
    }

    console.log(`   ⚙️  Adding rule to allow port ${port}...`);

    try {
      const command = new AuthorizeSecurityGroupIngressCommand({
        GroupId: sgId,
        IpPermissions: [{
          IpProtocol: 'tcp',
          FromPort: port,
          ToPort: port,
          IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'Streaming server access' }]
        }]
      });

      await ec2Client.send(command);
      console.log(`   ✅ Port ${port} added to ${sgId}`);
    } catch (error) {
      if (error.name === 'InvalidPermission.Duplicate') {
        console.log(`   ⚠️  Port ${port} rule already exists`);
      } else {
        console.error(`   ❌ Error adding port rule: ${error.message}`);
        return { success: false, error: error.message };
      }
    }
  }

  return { success: true };
}

/**
 * Install dependencies on EC2 instance
 */
async function installDependencies(publicIp, keyFile) {
  console.log('\n📦 Installing dependencies on EC2 instance...');

  const installScript = `
set -e
echo "📦 Installing system dependencies..."

# Update package manager
if command -v yum &> /dev/null; then
  sudo yum update -y
  sudo yum install -y git curl wget
  # Install Node.js 18.x
  if ! command -v node &> /dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
    sudo yum install -y nodejs
  fi
  # Install Chrome/Chromium
  if ! command -v google-chrome &> /dev/null && ! command -v chromium &> /dev/null; then
    sudo yum install -y chromium
  fi
  # Install X11 and display server
  sudo yum install -y xorg-x11-server-Xvfb xorg-x11-xauth xorg-x11-apps
elif command -v apt-get &> /dev/null; then
  sudo apt-get update -y
  sudo apt-get install -y git curl wget
  # Install Node.js 18.x
  if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo bash -
    sudo apt-get install -y nodejs
  fi
  # Install Chrome
  if ! command -v google-chrome &> /dev/null && ! command -v chromium-browser &> /dev/null; then
    wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
    echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list
    sudo apt-get update -y
    sudo apt-get install -y google-chrome-stable
  fi
  # Install X11 and display server
  sudo apt-get install -y xvfb x11-apps x11-xserver-utils
fi

# Verify installations
echo "✅ Verifying installations..."
node --version || echo "⚠️  Node.js not found"
npm --version || echo "⚠️  npm not found"
google-chrome --version 2>/dev/null || chromium --version 2>/dev/null || echo "⚠️  Chrome/Chromium not found"
which Xvfb && echo "✅ Xvfb installed" || echo "⚠️  Xvfb not found"

echo "✅ System dependencies installed"
`.trim();

  const result = await executeCommand(publicIp, installScript, keyFile, 300000);

  if (!result.success) {
    console.error('❌ Failed to install system dependencies');
    console.error(result.stderr || result.error);
    return { success: false, error: result.error || result.stderr };
  }

  console.log('✅ System dependencies installed successfully');
  return { success: true };
}

/**
 * Deploy streaming script to EC2
 */
async function deployStreamingScript(publicIp, keyFile) {
  console.log('\n📤 Deploying streaming script to EC2...');

  const localScriptPath = path.join(__dirname, '..', '..', 'src', 'core', 'extract-cookies-streaming.js');
  const remoteScriptPath = `${REMOTE_DEPLOY_DIR}/extract-cookies-streaming.js`;

  // Check local script exists
  if (!fs.existsSync(localScriptPath)) {
    console.error(`❌ Local script not found: ${localScriptPath}`);
    return { success: false, error: 'Local script not found' };
  }

  // Create remote directory
  await executeCommand(publicIp, `mkdir -p ${REMOTE_DEPLOY_DIR}`, keyFile, 10000);

  // Copy script using rsync
  return new Promise((resolve, reject) => {
    const rsyncCommand = [
      '-avz',
      '--progress',
      '-e', `ssh -i "${keyFile}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`,
      localScriptPath,
      `${AWS_SSH_USER}@${publicIp}:${remoteScriptPath}`
    ];

    console.log(`   Copying to ${publicIp}:${remoteScriptPath}`);

    const rsync = spawn('rsync', rsyncCommand, { stdio: 'inherit' });

    rsync.on('close', (code) => {
      if (code === 0) {
        console.log('✅ Script deployed successfully');
        resolve({ success: true, remotePath: remoteScriptPath });
      } else {
        console.error(`❌ Deployment failed with exit code ${code}`);
        reject({ success: false, exitCode: code });
      }
    });

    rsync.on('error', (error) => {
      console.error(`❌ Deployment error: ${error.message}`);
      reject({ success: false, error: error.message });
    });
  });
}

/**
 * Install Node.js dependencies on EC2
 */
async function installNodeDependencies(publicIp, keyFile) {
  console.log('\n📦 Installing Node.js dependencies...');

  const localPackagePath = path.join(__dirname, '..', '..', 'package.json');
  const remotePackagePath = `${REMOTE_DEPLOY_DIR}/package.json`;

  // Copy package.json
  await new Promise((resolve, reject) => {
    const rsync = spawn('rsync', [
      '-avz',
      '-e', `ssh -i "${keyFile}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`,
      localPackagePath,
      `${AWS_SSH_USER}@${publicIp}:${remotePackagePath}`
    ], { stdio: 'inherit' });

    rsync.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Failed to copy package.json: ${code}`));
    });
  });

  // Install dependencies
  const installCommand = `
cd ${REMOTE_DEPLOY_DIR}
npm install --production --no-audit --no-fund
`.trim();

  const result = await executeCommand(publicIp, installCommand, keyFile, 300000);

  if (!result.success) {
    console.error('❌ Failed to install Node.js dependencies');
    console.error(result.stderr || result.error);
    return { success: false, error: result.error || result.stderr };
  }

  console.log('✅ Node.js dependencies installed');
  return { success: true };
}

/**
 * Setup display server and run streaming script
 */
async function runStreamingScript(publicIp, keyFile, port) {
  console.log('\n🚀 Starting streaming server on EC2...');

  const runScript = `
cd ${REMOTE_DEPLOY_DIR}

# Set display
export DISPLAY=:99

# Start Xvfb in background if not running
if ! pgrep -x Xvfb > /dev/null; then
  echo "Starting Xvfb..."
  Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
  sleep 2
fi

# Set environment
export DISPLAY=:99
export STREAMING_PORT=${port}

# Run streaming script
echo "Starting streaming server on port ${port}..."
nohup node extract-cookies-streaming.js > streaming.log 2>&1 &

# Wait for server to start
sleep 3

# Check if process is running
if pgrep -f "extract-cookies-streaming" > /dev/null; then
  echo "✅ Streaming server started"
  echo "Server accessible at: http://${publicIp}:${port}"
else
  echo "❌ Failed to start streaming server"
  echo "Check logs: tail -f ${REMOTE_DEPLOY_DIR}/streaming.log"
  exit 1
fi
`.trim();

  const result = await executeCommand(publicIp, runScript, keyFile, 30000);

  if (!result.success) {
    console.error('❌ Failed to start streaming server');
    console.error(result.stderr || result.error);
    return { success: false, error: result.error || result.stderr };
  }

  console.log('✅ Streaming server started');
  console.log(`\n🌐 Access the streaming interface at: http://${publicIp}:${port}`);
  console.log(`📋 To check logs: ssh -i ${keyFile} ${AWS_SSH_USER}@${publicIp} "tail -f ${REMOTE_DEPLOY_DIR}/streaming.log"`);
  console.log(`🛑 To stop: ssh -i ${keyFile} ${AWS_SSH_USER}@${publicIp} "pkill -f extract-cookies-streaming"`);

  return { success: true, url: `http://${publicIp}:${port}` };
}

/**
 * Main deployment function
 */
async function main() {
  console.log('🚀 Deploying Streaming Cookie Extraction to AWS EC2');
  console.log('='.repeat(60));
  console.log(`   Instance ID: ${AWS_INSTANCE_ID || 'NOT SET'}`);
  console.log(`   Region: ${AWS_REGION}`);
  console.log(`   Streaming Port: ${STREAMING_PORT}`);
  console.log(`   Key File: ${AWS_KEY_FILE || 'NOT SET'}`);
  console.log('='.repeat(60));

  // Validate required environment variables
  if (!AWS_INSTANCE_ID) {
    console.error('\n❌ Error: AWS_INSTANCE_ID environment variable is required');
    process.exit(1);
  }

  if (!AWS_KEY_FILE) {
    console.error('\n❌ Error: AWS_KEY_FILE environment variable is required');
    process.exit(1);
  }

  if (!fs.existsSync(AWS_KEY_FILE)) {
    console.error(`\n❌ Error: AWS key file not found: ${AWS_KEY_FILE}`);
    process.exit(1);
  }

  // Ensure instance is ready
  console.log('\n🔍 Ensuring EC2 instance is ready...');
  const instanceResult = await ensureInstanceReady(AWS_INSTANCE_ID, null, AWS_KEY_FILE);

  if (!instanceResult.success) {
    console.error('❌ Failed to start instance:', instanceResult.error);
    process.exit(1);
  }

  const publicIp = instanceResult.publicIp;
  console.log(`✅ Instance ready at: ${publicIp}`);

  // Configure security groups
  const sgResult = await configureSecurityGroup(AWS_INSTANCE_ID, STREAMING_PORT);
  if (!sgResult.success) {
    console.error('⚠️  Failed to configure security groups');
    console.error('   You may need to manually add port', STREAMING_PORT, 'to your security group');
  }

  // Install system dependencies
  const depsResult = await installDependencies(publicIp, AWS_KEY_FILE);
  if (!depsResult.success) {
    console.error('❌ Failed to install dependencies');
    process.exit(1);
  }

  // Deploy script
  const deployResult = await deployStreamingScript(publicIp, AWS_KEY_FILE);
  if (!deployResult.success) {
    console.error('❌ Failed to deploy script');
    process.exit(1);
  }

  // Install Node.js dependencies
  const nodeDepsResult = await installNodeDependencies(publicIp, AWS_KEY_FILE);
  if (!nodeDepsResult.success) {
    console.error('❌ Failed to install Node.js dependencies');
    process.exit(1);
  }

  // Run streaming script
  const runResult = await runStreamingScript(publicIp, AWS_KEY_FILE, STREAMING_PORT);
  if (!runResult.success) {
    console.error('❌ Failed to start streaming server');
    process.exit(1);
  }

  console.log('\n' + '='.repeat(60));
  console.log('✅ Deployment complete!');
  console.log('='.repeat(60));
  console.log(`   Instance: ${AWS_INSTANCE_ID}`);
  console.log(`   Public IP: ${publicIp}`);
  console.log(`   Streaming URL: ${runResult.url}`);
}

main().catch((error) => {
  console.error('❌ Deployment failed:', error.message);
  process.exit(1);
});
