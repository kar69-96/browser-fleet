# Canvas AWS Infrastructure

AWS infrastructure for Canvas LMS data extraction with EC2 instance management, CloudWatch monitoring, and browser-based authentication streaming.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         AWS Multi-Instance Architecture                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │                    t3.medium (Auth & Updates)                       │     │
│  │  ┌─────────────────────────┐  ┌──────────────────────────────┐    │     │
│  │  │   Browser Auth Server   │  │     Incremental Updates      │    │     │
│  │  │   Socket.IO Streaming   │  │     Change Detection         │    │     │
│  │  │   Cookie Transfer       │  │     Delta Sync               │    │     │
│  │  └─────────────────────────┘  └──────────────────────────────┘    │     │
│  │                          Always available, low cost                │     │
│  └────────────────────────────────────────────────────────────────────┘     │
│                                      │                                       │
│                                      │ Cookies                               │
│                                      ▼                                       │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │                  r7i.2xlarge (Initial Extraction)                   │     │
│  │  ┌──────────┐  ┌─────────────┐  ┌───────────────────┐             │     │
│  │  │ MAPPING  │→ │ EXTRACTION  │→ │    DOWNLOADS      │             │     │
│  │  │ 30-60s   │  │   2-10min   │  │     1-30min       │             │     │
│  │  │ ~500MB   │  │   2-4GB     │  │     1-2GB         │             │     │
│  │  └──────────┘  └─────────────┘  └───────────────────┘             │     │
│  │                    Spun up on-demand, hibernates when idle         │     │
│  └────────────────────────────────────────────────────────────────────┘     │
│                                                                              │
│  ┌─────────────────┐  ┌─────────────────────────────────────┐              │
│  │ CloudWatch Logs │  │        CloudWatch Metrics           │              │
│  │  Real-time      │  │  CPU, Memory, Network               │              │
│  └─────────────────┘  └─────────────────────────────────────┘              │
└─────────────────────────────────────────────────────────────────────────────┘
         ↑
         │ Socket.IO (Port 3002)
         │
┌────────┴────────┐
│  Local Browser  │
│  Authentication │
└─────────────────┘
```

## Instance Roles

| Instance | Type | Role | Availability | Cost Model |
|----------|------|------|--------------|------------|
| **Auth Server** | t3.medium | Browser auth streaming, cookie management | Always on | ~$30/month |
| **Update Server** | t3.medium | Incremental updates, change detection | Always on | Shared with auth |
| **Extraction Server** | r7i.2xlarge | Full initial extraction, bulk downloads | On-demand | ~$0.53/hour |

## Resource Requirements

### Instance Sizing

| Instance Type | vCPUs | RAM | Concurrent Requests | Parallel Courses | Use Case |
|--------------|-------|-----|---------------------|------------------|----------|
| **t3.medium** | 2 | 4GB | 20-30 | 3-5 | Auth + Updates |
| t3.large | 2 | 8GB | 50-60 | 8 | Light extraction |
| **r7i.2xlarge** | 8 | 64GB | 80-100 | 20 | Initial extraction |
| r7i.4xlarge | 16 | 128GB | 150-200 | 40 | Heavy extraction |

### Per-Phase Resource Usage

| Phase | Instance | Duration | Memory | Requests/Course |
|-------|----------|----------|--------|-----------------|
| AUTH | t3.medium | 1-2min | ~200MB | N/A |
| UPDATE | t3.medium | 10-30s | 200-500MB | 50-100 |
| MAPPING | r7i.2xlarge | 30-60s | ~500MB | 100-200 |
| EXTRACTION | r7i.2xlarge | 2-10min | 2-4GB | 500-2000 |
| DOWNLOADS | r7i.2xlarge | 1-30min | 1-2GB | Variable |

## Installation

```bash
npm install
cp .env.example .env
# Edit .env with your AWS credentials and configuration
```

## Usage

### Browser Authentication (t3.medium)

```bash
# Deploy streaming auth server to t3.medium
npm run deploy-streaming
# Access at http://<t3-medium-ip>:3002
```

### Incremental Updates (t3.medium)

```bash
# Run incremental update check and sync
npm run update
```

### Full Initial Extraction (r7i.2xlarge)

```bash
# Start r7i.2xlarge, run full extraction, collect metrics, hibernate
npm run extract
```

### Manual Operations

```bash
# Run crawler locally
npm run crawl

# Force stop EC2 instance
npm run stop-instance
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AWS_INSTANCE_ID` | EC2 instance ID (extraction) | Required |
| `AWS_AUTH_INSTANCE_ID` | EC2 instance ID (auth/updates) | Required |
| `AWS_KEY_FILE` | Path to SSH key | Required |
| `AWS_REGION` | AWS region | us-east-1 |
| `MAX_CONCURRENCY` | Concurrent requests | Auto-detected |
| `PARALLEL_COURSES` | Parallel course processing | 20 (r7i) / 5 (t3) |
| `STREAMING_PORT` | Auth streaming port | 3002 |

### Concurrency Auto-Detection

Concurrency is automatically optimized based on instance type:

```javascript
// r7i.2xlarge - Full extraction
const MAX_CONCURRENCY = isMultiCourse ? 100 : 80;
const MAX_PARALLEL_COURSES = 20;

// t3.medium - Updates only
const MAX_CONCURRENCY = isMultiCourse ? 30 : 20;
const MAX_PARALLEL_COURSES = 5;
```

## Workflow

### Initial Setup
1. Deploy auth streaming server to t3.medium (always on)
2. Authenticate via browser → cookies stored on t3.medium
3. Spin up r7i.2xlarge for initial extraction
4. Transfer cookies from t3.medium → r7i.2xlarge
5. Run full extraction pipeline
6. Hibernate r7i.2xlarge when complete

### Daily Updates
1. t3.medium runs incremental update check
2. Change detection compares against last sync
3. Only modified content is re-extracted
4. No need to spin up r7i.2xlarge for updates

### Re-Authentication
1. When cookies expire, user re-authenticates via t3.medium
2. New cookies automatically available for both instances

## Project Structure

```
├── src/
│   ├── core/
│   │   └── extract-cookies-streaming.js  # Browser auth streaming (t3.medium)
│   ├── crawler/
│   │   └── canvas-crawler.js             # Phased extraction (r7i.2xlarge)
│   └── utils/
│       └── cookie-helpers.js             # Cookie path utilities
├── scripts/
│   ├── utils/
│   │   └── update.js                     # Incremental updates (t3.medium)
│   └── aws/
│       ├── run-aws-extraction.js         # AWS orchestrator
│       ├── deploy-streaming.js           # Deploy auth server
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

## Cost Optimization

| Component | Strategy | Estimated Cost |
|-----------|----------|----------------|
| t3.medium (auth/updates) | Always on | ~$30/month |
| r7i.2xlarge (extraction) | On-demand + hibernate | ~$5-20/month |
| CloudWatch | Minimal logging | ~$1-5/month |
| **Total** | | **~$36-55/month** |

## License

MIT
