#!/usr/bin/env node
/**
 * CloudWatch Logs Integration
 * Sends logs to CloudWatch Logs and provides real-time log streaming
 */

const { CloudWatchLogsClient, CreateLogGroupCommand, CreateLogStreamCommand, PutLogEventsCommand, DescribeLogStreamsCommand, GetLogEventsCommand } = require('@aws-sdk/client-cloudwatch-logs');

// Configuration from environment variables
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const LOG_GROUP_NAME = process.env.CLOUDWATCH_LOG_GROUP || '/aws/canvas-wrapper/updates';
const LOG_STREAM_PREFIX = process.env.CLOUDWATCH_LOG_STREAM_PREFIX || 'update-run';

// Initialize CloudWatch Logs client
const cloudWatchLogsClient = new CloudWatchLogsClient({ region: AWS_REGION });

/**
 * Ensure log group exists
 */
async function ensureLogGroup() {
  try {
    await cloudWatchLogsClient.send(new CreateLogGroupCommand({
      logGroupName: LOG_GROUP_NAME
    }));
    console.log(`✅ CloudWatch log group created: ${LOG_GROUP_NAME}`);
  } catch (error) {
    if (error.name === 'ResourceAlreadyExistsException') {
      // Log group already exists, that's fine
      return;
    }
    throw error;
  }
}

/**
 * Create or get log stream
 */
async function createLogStream(streamName) {
  const fullStreamName = `${LOG_STREAM_PREFIX}-${streamName}`;

  try {
    await cloudWatchLogsClient.send(new CreateLogStreamCommand({
      logGroupName: LOG_GROUP_NAME,
      logStreamName: fullStreamName
    }));
    return fullStreamName;
  } catch (error) {
    if (error.name === 'ResourceAlreadyExistsException') {
      // Stream already exists, that's fine
      return fullStreamName;
    }
    throw error;
  }
}

/**
 * Send log events to CloudWatch
 */
class CloudWatchLogger {
  constructor(streamName) {
    this.streamName = null;
    this.logGroupName = LOG_GROUP_NAME;
    this.logEvents = [];
    this.sequenceToken = null;
    this.flushInterval = null;
    this.streamNamePromise = null;
  }

  async initialize(streamName) {
    await ensureLogGroup();
    this.streamName = await createLogStream(streamName);

    // Start periodic flush
    this.flushInterval = setInterval(() => {
      this.flush().catch(err => {
        console.error('Error flushing CloudWatch logs:', err.message);
      });
    }, 5000); // Flush every 5 seconds

    return this.streamName;
  }

  async log(message, level = 'INFO') {
    const timestamp = Date.now();

    this.logEvents.push({
      timestamp,
      message: `[${level}] ${message}`
    });

    // Auto-flush if buffer gets large
    if (this.logEvents.length >= 10) {
      await this.flush();
    }
  }

  async flush() {
    if (!this.streamName || this.logEvents.length === 0) {
      return;
    }

    try {
      const events = this.logEvents.map(event => ({
        timestamp: event.timestamp,
        message: event.message
      }));

      const params = {
        logGroupName: this.logGroupName,
        logStreamName: this.streamName,
        logEvents: events
      };

      if (this.sequenceToken) {
        params.sequenceToken = this.sequenceToken;
      }

      const response = await cloudWatchLogsClient.send(new PutLogEventsCommand(params));

      if (response.nextSequenceToken) {
        this.sequenceToken = response.nextSequenceToken;
      }

      // Clear flushed events
      this.logEvents = [];
    } catch (error) {
      // Don't throw, just log to console
      console.error('Error sending logs to CloudWatch:', error.message);
    }
  }

  async close() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }

    // Final flush
    await this.flush();
  }
}

/**
 * Stream logs from CloudWatch in real-time
 */
async function streamLogs(streamName, startTime = null, follow = true) {
  const fullStreamName = `${LOG_STREAM_PREFIX}-${streamName}`;

  if (!startTime) {
    startTime = Date.now() - 60000; // Start from 1 minute ago
  }

  let nextToken = null;
  let lastSeenTime = startTime;

  while (true) {
    try {
      const params = {
        logGroupName: LOG_GROUP_NAME,
        logStreamName: fullStreamName,
        startTime: lastSeenTime,
        limit: 100
      };

      if (nextToken) {
        params.nextToken = nextToken;
      }

      const response = await cloudWatchLogsClient.send(new GetLogEventsCommand(params));

      if (response.events && response.events.length > 0) {
        for (const event of response.events) {
          console.log(event.message);
          lastSeenTime = Math.max(lastSeenTime, event.timestamp + 1);
        }
        nextToken = response.nextForwardToken;
      } else if (!follow) {
        // No more events and not following, exit
        break;
      }

      if (follow) {
        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, 2000)); // Poll every 2 seconds
      } else {
        break;
      }
    } catch (error) {
      if (error.name === 'ResourceNotFoundException') {
        console.error(`Log stream not found: ${fullStreamName}`);
        console.error('Waiting for logs to appear...');
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }
      console.error('Error streaming logs:', error.message);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

/**
 * List recent log streams
 */
async function listLogStreams(limit = 10) {
  try {
    const response = await cloudWatchLogsClient.send(new DescribeLogStreamsCommand({
      logGroupName: LOG_GROUP_NAME,
      orderBy: 'LastEventTime',
      descending: true,
      limit
    }));

    return response.logStreams || [];
  } catch (error) {
    if (error.name === 'ResourceNotFoundException') {
      return [];
    }
    throw error;
  }
}

module.exports = {
  CloudWatchLogger,
  streamLogs,
  listLogStreams,
  ensureLogGroup,
  LOG_GROUP_NAME,
  LOG_STREAM_PREFIX
};
