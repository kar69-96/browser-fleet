#!/usr/bin/env node
/**
 * CloudWatch Metrics Collector
 * Collects CPU and memory utilization metrics from AWS CloudWatch
 */

const { CloudWatchClient, GetMetricStatisticsCommand } = require('@aws-sdk/client-cloudwatch');

// Configuration from environment variables
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

// Initialize CloudWatch client
const cloudWatchClient = new CloudWatchClient({ region: AWS_REGION });

/**
 * Get CPU utilization from CloudWatch
 * @param {string} instanceId - EC2 instance ID
 * @param {Date} startTime - Start time for metrics
 * @param {Date} endTime - End time for metrics
 * @returns {Promise<Object>} - CPU utilization metrics
 */
async function getCPUUtilization(instanceId, startTime, endTime) {
  try {
    const command = new GetMetricStatisticsCommand({
      Namespace: 'AWS/EC2',
      MetricName: 'CPUUtilization',
      Dimensions: [
        {
          Name: 'InstanceId',
          Value: instanceId
        }
      ],
      StartTime: startTime,
      EndTime: endTime,
      Period: 60, // 1 minute periods
      Statistics: ['Average', 'Maximum', 'Minimum']
    });

    const response = await cloudWatchClient.send(command);

    if (!response.Datapoints || response.Datapoints.length === 0) {
      return {
        average: null,
        maximum: null,
        minimum: null,
        samples: 0,
        datapoints: []
      };
    }

    // Sort datapoints by timestamp
    const datapoints = response.Datapoints.sort((a, b) => a.Timestamp - b.Timestamp);

    // Calculate statistics
    const averages = datapoints.map(d => d.Average).filter(v => v !== null && v !== undefined);
    const maximums = datapoints.map(d => d.Maximum).filter(v => v !== null && v !== undefined);
    const minimums = datapoints.map(d => d.Minimum).filter(v => v !== null && v !== undefined);

    return {
      average: averages.length > 0 ? averages.reduce((a, b) => a + b, 0) / averages.length : null,
      maximum: maximums.length > 0 ? Math.max(...maximums) : null,
      minimum: minimums.length > 0 ? Math.min(...minimums) : null,
      samples: datapoints.length,
      datapoints: datapoints.map(d => ({
        timestamp: d.Timestamp.toISOString(),
        average: d.Average,
        maximum: d.Maximum,
        minimum: d.Minimum
      }))
    };
  } catch (error) {
    console.error(`❌ Error getting CPU utilization: ${error.message}`);
    return {
      average: null,
      maximum: null,
      minimum: null,
      samples: 0,
      error: error.message,
      datapoints: []
    };
  }
}

/**
 * Get memory utilization from CloudWatch (if available)
 * Note: EC2 doesn't provide memory metrics by default, but we can try to get them
 * @param {string} instanceId - EC2 instance ID
 * @param {Date} startTime - Start time for metrics
 * @param {Date} endTime - End time for metrics
 * @returns {Promise<Object>} - Memory utilization metrics (may be empty if not available)
 */
async function getMemoryUtilization(instanceId, startTime, endTime) {
  try {
    // Try to get memory metrics (requires CloudWatch agent to be installed)
    // Try multiple metric names as CloudWatch agent may use different names
    const metricNames = ['mem_used_percent', 'MemoryUtilization', 'mem_used'];

    for (const metricName of metricNames) {
      try {
        const command = new GetMetricStatisticsCommand({
          Namespace: 'CWAgent',
          MetricName: metricName,
          Dimensions: [
            {
              Name: 'InstanceId',
              Value: instanceId
            }
          ],
          StartTime: startTime,
          EndTime: endTime,
          Period: 60,
          Statistics: ['Average', 'Maximum', 'Minimum']
        });

        const response = await cloudWatchClient.send(command);

        if (response.Datapoints && response.Datapoints.length > 0) {
          // Found metrics with this name, process and return
          const datapoints = response.Datapoints.sort((a, b) => a.Timestamp - b.Timestamp);
          const averages = datapoints.map(d => d.Average).filter(v => v !== null && v !== undefined);
          const maximums = datapoints.map(d => d.Maximum).filter(v => v !== null && v !== undefined);
          const minimums = datapoints.map(d => d.Minimum).filter(v => v !== null && v !== undefined);

          return {
            average: averages.length > 0 ? averages.reduce((a, b) => a + b, 0) / averages.length : null,
            maximum: maximums.length > 0 ? Math.max(...maximums) : null,
            minimum: minimums.length > 0 ? Math.min(...minimums) : null,
            samples: datapoints.length,
            available: true,
            metricName: metricName, // Track which metric name worked
            datapoints: datapoints.map(d => ({
              timestamp: d.Timestamp.toISOString(),
              average: d.Average,
              maximum: d.Maximum,
              minimum: d.Minimum
            }))
          };
        }
      } catch (err) {
        // Try next metric name
        continue;
      }
    }

    // No metrics found with any name
    return {
      average: null,
      maximum: null,
      minimum: null,
      samples: 0,
      available: false,
      datapoints: []
    };
  } catch (error) {
    // Memory metrics not available (expected if CloudWatch agent not installed)
    return {
      average: null,
      maximum: null,
      minimum: null,
      samples: 0,
      available: false,
      error: error.message,
      datapoints: []
    };
  }
}

/**
 * Get network metrics from CloudWatch
 * @param {string} instanceId - EC2 instance ID
 * @param {Date} startTime - Start time for metrics
 * @param {Date} endTime - End time for metrics
 * @returns {Promise<Object>} - Network metrics
 */
async function getNetworkMetrics(instanceId, startTime, endTime) {
  try {
    const [networkIn, networkOut] = await Promise.all([
      cloudWatchClient.send(new GetMetricStatisticsCommand({
        Namespace: 'AWS/EC2',
        MetricName: 'NetworkIn',
        Dimensions: [{ Name: 'InstanceId', Value: instanceId }],
        StartTime: startTime,
        EndTime: endTime,
        Period: 60,
        Statistics: ['Sum']
      })),
      cloudWatchClient.send(new GetMetricStatisticsCommand({
        Namespace: 'AWS/EC2',
        MetricName: 'NetworkOut',
        Dimensions: [{ Name: 'InstanceId', Value: instanceId }],
        StartTime: startTime,
        EndTime: endTime,
        Period: 60,
        Statistics: ['Sum']
      }))
    ]);

    return {
      networkIn: {
        total: networkIn.Datapoints?.reduce((sum, d) => sum + (d.Sum || 0), 0) || 0,
        average: networkIn.Datapoints?.length > 0
          ? networkIn.Datapoints.reduce((sum, d) => sum + (d.Sum || 0), 0) / networkIn.Datapoints.length
          : 0,
        samples: networkIn.Datapoints?.length || 0
      },
      networkOut: {
        total: networkOut.Datapoints?.reduce((sum, d) => sum + (d.Sum || 0), 0) || 0,
        average: networkOut.Datapoints?.length > 0
          ? networkOut.Datapoints.reduce((sum, d) => sum + (d.Sum || 0), 0) / networkOut.Datapoints.length
          : 0,
        samples: networkOut.Datapoints?.length || 0
      }
    };
  } catch (error) {
    console.error(`❌ Error getting network metrics: ${error.message}`);
    return {
      networkIn: { total: 0, average: 0, samples: 0, error: error.message },
      networkOut: { total: 0, average: 0, samples: 0, error: error.message }
    };
  }
}

/**
 * Collect all CloudWatch metrics for an instance during a time period
 * @param {string} instanceId - EC2 instance ID
 * @param {Date} startTime - Start time for metrics
 * @param {Date} endTime - End time for metrics
 * @returns {Promise<Object>} - All collected metrics
 */
async function collectMetrics(instanceId, startTime, endTime) {
  console.log(`\n📊 Collecting CloudWatch metrics for instance ${instanceId}...`);
  console.log(`   Time period: ${startTime.toISOString()} to ${endTime.toISOString()}`);

  const [cpuMetrics, memoryMetrics, networkMetrics] = await Promise.all([
    getCPUUtilization(instanceId, startTime, endTime),
    getMemoryUtilization(instanceId, startTime, endTime),
    getNetworkMetrics(instanceId, startTime, endTime)
  ]);

  return {
    cpu: cpuMetrics,
    memory: memoryMetrics,
    network: networkMetrics,
    collectionTime: new Date().toISOString(),
    timeRange: {
      start: startTime.toISOString(),
      end: endTime.toISOString()
    }
  };
}

module.exports = {
  getCPUUtilization,
  getMemoryUtilization,
  getNetworkMetrics,
  collectMetrics
};
