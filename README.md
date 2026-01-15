# Canvas AWS Infrastructure

AWS infrastructure for Canvas LMS data extraction with EC2 instance management, CloudWatch monitoring, and browser-based authentication streaming.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    AWS EC2 (r7i.2xlarge)                        │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                   Extraction Pipeline                    │   │
│  │  ┌──────────┐  ┌─────────────┐  ┌───────────────────┐  │   │
│  │  │ MAPPING  │→ │ EXTRACTION  │→ │    DOWNLOADS      │  │   │
│  │  │ 30-60s   │  │   2-10min   │  │     1-30min       │  │   │
│  │  │ ~500MB   │  │   2-4GB     │  │     1-2GB         │  │   │
│  │  └──────────┘  └─────────────┘  └───────────────────┘  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────┐  ┌─────────────────────────────────────┐  │
│  │ CloudWatch Logs │  │        CloudWatch Metrics           │  │
│  │  Real-time      │  │  CPU, Memory, Network               │  │
│  └─────────────────┘  └─────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
         ↑
         │ Socket.IO (Port 3002)
         │
┌────────┴────────┐
│  Local Browser  │
│  Authentication │
└─────────────────┘
```

## Resource Requirements

### Instance Sizing

| Instance Type | vCPUs | RAM | Concurrent Requests | Parallel Courses | Total Capacity |
|--------------|-------|-----|---------------------|------------------|----------------|
| Local (dev)  | 4     | 8GB | 40-50               | 5                | ~250           |
| t3.large     | 2     | 8GB | 50-60               | 8                | ~480           |
| **r7i.2xlarge** | 8  | 64GB| 80-100              | 20               | **~2000**      |
| r7i.4xlarge  | 16    | 128GB| 150-200            | 40               | ~8000          |

### Per-Phase Resource Usage

| Phase | Duration | Memory | Requests/Course | Notes |
|-------|----------|--------|-----------------|-------|
| MAPPING | 30-60s | ~500MB | 100-200 | URL discovery |
| EXTRACTION | 2-10min | 2-4GB | 500-2000 | Content extraction |
| DOWNLOADS | 1-30min | 1-2GB | Variable | File downloads |
| UPDATE | 10-30s | 200-500MB | 50-100 | Incremental sync |

## Installation

```bash
npm install
cp .env.example .env
# Edit .env with your AWS credentials and configuration
```

## Usage

### Full Extraction (AWS)

```bash
# Start EC2 instance, run extraction, collect metrics, hibernate
npm run extract
```

### Deploy Streaming Server

```bash
# Deploy browser streaming auth to EC2
npm run deploy-streaming
```

### Manual Operations

```bash
# Run crawler locally
npm run crawl

# Run incremental update
npm run update

# Force stop EC2 instance
npm run stop-instance
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AWS_INSTANCE_ID` | EC2 instance ID | Required |
| `AWS_KEY_FILE` | Path to SSH key | Required |
| `AWS_REGION` | AWS region | us-east-1 |
| `MAX_CONCURRENCY` | Concurrent requests | Auto-detected |
| `PARALLEL_COURSES` | Parallel course processing | 20 (AWS) / 5 (local) |
| `STREAMING_PORT` | Auth streaming port | 3002 |

### Concurrency Auto-Detection

Concurrency is automatically optimized based on instance type:

```javascript
const MAX_CONCURRENCY = isAWS
  ? (isMultiCourse ? 100 : 80)   // r7i.2xlarge optimized
  : (isMultiCourse ? 50 : 40);   // Local development
```

## Project Structure

```
├── src/
│   ├── core/
│   │   └── extract-cookies-streaming.js  # Browser auth streaming
│   ├── crawler/
│   │   └── canvas-crawler.js             # Phased extraction crawler
│   └── utils/
│       └── cookie-helpers.js             # Cookie path utilities
├── scripts/
│   ├── utils/
│   │   └── update.js                     # Incremental update checker
│   └── aws/
│       ├── run-aws-extraction.js         # AWS orchestrator
│       ├── deploy-streaming.js           # Deploy streaming server
│       ├── force-stop-instance.js        # Emergency stop
│       └── utils/
│           ├── aws-ec2-manager.js        # EC2 management (760 lines)
│           ├── cloudwatch-logs.js        # Log streaming
│           └── cloudwatch-metrics.js     # Metrics collection
```

## AWS EC2 Management

The `aws-ec2-manager.js` module provides:

- Instance lifecycle: start, stop, hibernate
- SSH command execution with retry logic
- Security group configuration
- Public IP retrieval
- Instance state monitoring

## CloudWatch Integration

### Metrics Collected
- CPU utilization (avg, max, min)
- Memory utilization (requires CloudWatch agent)
- Network I/O

### Log Streaming
- Real-time log streaming to CloudWatch Logs
- Automatic log group/stream creation
- Periodic flush with configurable interval

## Browser Authentication

The streaming server enables browser-based authentication:

1. Deploy streaming server to EC2
2. Connect from local browser via Socket.IO
3. Complete authentication in browser
4. Cookies transferred to EC2 for extraction

```bash
# Deploy and access at http://<ec2-ip>:3002
npm run deploy-streaming
```

## License

MIT
