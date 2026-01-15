#!/usr/bin/env node
/**
 * AWS Extraction Orchestrator
 * Manages full extraction workflow on EC2 instances
 *
 * Workflow:
 * 1. Start/resume EC2 instance (from hibernation)
 * 2. Wait for SSH to be ready
 * 3. Execute extraction on remote instance
 * 4. Collect CloudWatch metrics
 * 5. Hibernate instance to save costs
 */

const path = require('path');
const fs = require('fs');

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

const { ensureInstanceReady, executeCommand, cleanup } = require('./utils/aws-ec2-manager');
const { collectMetrics } = require('./utils/cloudwatch-metrics');

// Configuration
const AWS_INSTANCE_ID = process.env.AWS_INSTANCE_ID;
const AWS_KEY_FILE = process.env.AWS_KEY_FILE;
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

// Extraction configuration
const EXTRACTION_TIMEOUT_MS = parseInt(process.env.EXTRACTION_TIMEOUT_MS) || 3600000; // 1 hour default
const EXTRACTION_SCRIPT = process.env.EXTRACTION_SCRIPT || 'node src/crawler/canvas-crawler.js';
const REMOTE_WORKING_DIR = process.env.REMOTE_WORKING_DIR || '~/extraction';

/**
 * Run extraction on AWS EC2 instance
 */
async function runAWSExtraction(options = {}) {
  console.log('🚀 AWS Extraction Orchestrator');
  console.log('='.repeat(60));
  console.log(`   Instance ID: ${AWS_INSTANCE_ID || 'NOT SET'}`);
  console.log(`   Region: ${AWS_REGION}`);
  console.log(`   Key file: ${AWS_KEY_FILE || 'NOT SET'}`);
  console.log(`   Timeout: ${EXTRACTION_TIMEOUT_MS / 1000}s`);
  console.log('='.repeat(60));

  if (!AWS_INSTANCE_ID) {
    console.error('❌ AWS_INSTANCE_ID environment variable is required');
    process.exit(1);
  }

  if (!AWS_KEY_FILE) {
    console.error('❌ AWS_KEY_FILE environment variable is required');
    process.exit(1);
  }

  const startTime = new Date();

  // Step 1: Start/resume EC2 instance
  console.log('\n☁️  Step 1: Starting EC2 instance...');
  const instanceResult = await ensureInstanceReady(AWS_INSTANCE_ID, null, AWS_KEY_FILE);

  if (!instanceResult.success) {
    console.error(`❌ Failed to start instance: ${instanceResult.error}`);
    process.exit(1);
  }

  const { publicIp, wasAlreadyRunning } = instanceResult;
  console.log(`   ✅ Instance ready at ${publicIp}`);
  console.log(`   Was already running: ${wasAlreadyRunning}`);

  let extractionSuccess = false;
  let extractionResult = null;

  try {
    // Step 2: Run extraction on remote instance
    console.log('\n📦 Step 2: Running extraction...');
    console.log(`   Remote working directory: ${REMOTE_WORKING_DIR}`);
    console.log(`   Extraction script: ${EXTRACTION_SCRIPT}`);
    console.log(`   Timeout: ${EXTRACTION_TIMEOUT_MS / 1000 / 60} minutes`);

    const extractionCommand = `cd ${REMOTE_WORKING_DIR} && ${EXTRACTION_SCRIPT}`;
    extractionResult = await executeCommand(publicIp, extractionCommand, AWS_KEY_FILE, EXTRACTION_TIMEOUT_MS);

    if (extractionResult.success) {
      console.log('\n   ✅ Extraction completed successfully');
      extractionSuccess = true;
    } else {
      console.error(`\n   ❌ Extraction failed: ${extractionResult.error || 'Unknown error'}`);
      console.error(`   Exit code: ${extractionResult.exitCode}`);
    }

    // Step 3: Collect CloudWatch metrics
    console.log('\n📊 Step 3: Collecting CloudWatch metrics...');
    const endTime = new Date();
    const metrics = await collectMetrics(AWS_INSTANCE_ID, startTime, endTime);

    console.log('\n   Performance Summary:');
    if (metrics.cpu.average !== null) {
      console.log(`   CPU Average: ${metrics.cpu.average.toFixed(1)}%`);
      console.log(`   CPU Maximum: ${metrics.cpu.maximum.toFixed(1)}%`);
    } else {
      console.log('   CPU: No data available (CloudWatch delay)');
    }

    if (metrics.memory.available) {
      console.log(`   Memory Average: ${metrics.memory.average?.toFixed(1)}%`);
      console.log(`   Memory Maximum: ${metrics.memory.maximum?.toFixed(1)}%`);
    } else {
      console.log('   Memory: CloudWatch agent not installed');
    }

    if (metrics.network.networkIn.total > 0) {
      console.log(`   Network In: ${(metrics.network.networkIn.total / 1024 / 1024).toFixed(1)} MB`);
      console.log(`   Network Out: ${(metrics.network.networkOut.total / 1024 / 1024).toFixed(1)} MB`);
    }

    const totalTimeMinutes = (endTime - startTime) / 1000 / 60;
    console.log(`   Total runtime: ${totalTimeMinutes.toFixed(1)} minutes`);

    return {
      success: extractionSuccess,
      metrics,
      runtime: totalTimeMinutes,
      instanceId: AWS_INSTANCE_ID,
      publicIp
    };

  } finally {
    // Step 4: Hibernate instance to save costs
    console.log('\n💤 Step 4: Hibernating instance...');
    const cleanupResult = await cleanup(AWS_INSTANCE_ID, wasAlreadyRunning);

    if (cleanupResult.success) {
      console.log('   ✅ Instance hibernated successfully');
    } else {
      console.error(`   ⚠️  Failed to hibernate: ${cleanupResult.error}`);
      console.error('   ⚠️  Please hibernate the instance manually to avoid charges!');
    }
  }
}

/**
 * Run update check on AWS EC2 instance
 */
async function runAWSUpdate(options = {}) {
  console.log('🔄 AWS Update Check Orchestrator');
  console.log('='.repeat(60));

  if (!AWS_INSTANCE_ID || !AWS_KEY_FILE) {
    console.error('❌ AWS_INSTANCE_ID and AWS_KEY_FILE environment variables are required');
    process.exit(1);
  }

  const startTime = new Date();

  // Start instance
  const instanceResult = await ensureInstanceReady(AWS_INSTANCE_ID, null, AWS_KEY_FILE);
  if (!instanceResult.success) {
    console.error(`❌ Failed to start instance: ${instanceResult.error}`);
    process.exit(1);
  }

  const { publicIp, wasAlreadyRunning } = instanceResult;

  try {
    // Run update check
    const updateCommand = `cd ${REMOTE_WORKING_DIR} && node scripts/utils/update.js`;
    const updateTimeout = 30 * 60 * 1000; // 30 minutes for updates

    const result = await executeCommand(publicIp, updateCommand, AWS_KEY_FILE, updateTimeout);

    if (result.success) {
      console.log('\n✅ Update check completed successfully');
    } else {
      console.error(`\n❌ Update check failed: ${result.error}`);
    }

    // Collect metrics
    const metrics = await collectMetrics(AWS_INSTANCE_ID, startTime, new Date());

    return { success: result.success, metrics };

  } finally {
    // Hibernate
    await cleanup(AWS_INSTANCE_ID, wasAlreadyRunning);
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  const isUpdate = args.includes('--update') || args.includes('-u');

  try {
    let result;

    if (isUpdate) {
      result = await runAWSUpdate();
    } else {
      result = await runAWSExtraction();
    }

    console.log('\n' + '='.repeat(60));
    if (result.success) {
      console.log('✅ AWS operation completed successfully');
      process.exit(0);
    } else {
      console.log('❌ AWS operation failed');
      process.exit(1);
    }
  } catch (error) {
    console.error('\n❌ Fatal error:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  runAWSExtraction,
  runAWSUpdate
};
