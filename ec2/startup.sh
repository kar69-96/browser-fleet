#!/bin/bash
# EC2 Instance Startup Script for Streaming Authentication
# This script is run as user data when the instance starts

set -e

# Log everything to user-data.log and console
exec > >(tee /var/log/user-data.log | logger -t user-data -s 2>/dev/console) 2>&1

echo "=========================================="
echo "Streaming Auth Instance Startup"
echo "$(date)"
echo "=========================================="

# Configuration (set via environment or defaults)
API_BASE_URL="${API_BASE_URL:?API_BASE_URL is required}"
STREAMING_PORT="${STREAMING_PORT:-3002}"
APP_DIR="${APP_DIR:-/home/ec2-user/app}"
CLOUDFLARE_TUNNEL_TOKEN="${CLOUDFLARE_TUNNEL_TOKEN:-}"  # Named tunnel token for stable URL

# Get instance ID from EC2 metadata
INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
echo "Instance ID: $INSTANCE_ID"

# Get region from metadata
REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region)
echo "Region: $REGION"

# Function to signal failure
signal_failure() {
  echo "ERROR: $1"
  # Could optionally notify via SNS or CloudWatch
  exit 1
}

# =============================================================================
# Step 1: Start Cloudflare Tunnel
# =============================================================================
echo "Starting Cloudflare tunnel..."

# Kill any existing cloudflared process
pkill cloudflared || true

# Check if named tunnel token is configured
if [ -n "$CLOUDFLARE_TUNNEL_TOKEN" ]; then
  echo "Using named Cloudflare tunnel (stable URL via token)"

  # Start cloudflared with named tunnel token
  nohup cloudflared tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN" \
    > /var/log/cloudflared.log 2>&1 &

  CLOUDFLARED_PID=$!
  echo "Named tunnel started with PID: $CLOUDFLARED_PID"

  # Named tunnel has a fixed URL
  TUNNEL_URL="${CLOUDFLARE_TUNNEL_URL:?CLOUDFLARE_TUNNEL_URL is required when using named tunnel}"

  # Wait for tunnel to establish connection
  echo "Waiting for named tunnel connection..."
  sleep 10

  # Verify tunnel is connected by checking for connection message in log
  for i in {1..30}; do
    if grep -q "Registered tunnel" /var/log/cloudflared.log 2>/dev/null || \
       grep -q "connection registered" /var/log/cloudflared.log 2>/dev/null || \
       grep -q "Connected" /var/log/cloudflared.log 2>/dev/null; then
      echo "Named tunnel connected successfully"
      break
    fi
    echo "  Waiting for tunnel connection... attempt $i/30"
    sleep 2
  done
else
  echo "Using quick tunnel (random trycloudflare.com URL)"

  # Start cloudflared with quick tunnel (trycloudflare.com)
  nohup cloudflared tunnel --url http://localhost:$STREAMING_PORT \
    --logfile /var/log/cloudflared.log \
    --loglevel info \
    > /var/log/cloudflared-stdout.log 2>&1 &

  CLOUDFLARED_PID=$!
  echo "Cloudflared started with PID: $CLOUDFLARED_PID"

  # Wait for tunnel URL to be available
  echo "Waiting for tunnel URL..."
  TUNNEL_URL=""
  for i in {1..60}; do
    TUNNEL_URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' /var/log/cloudflared.log 2>/dev/null | tail -1 || true)
    if [ -n "$TUNNEL_URL" ]; then
      echo "Tunnel URL obtained: $TUNNEL_URL"
      break
    fi
    echo "  Waiting for tunnel... attempt $i/60"
    sleep 2
  done

  if [ -z "$TUNNEL_URL" ]; then
    signal_failure "Failed to obtain tunnel URL after 2 minutes"
  fi
fi

echo "Tunnel URL: $TUNNEL_URL"

# =============================================================================
# Step 2: Start Streaming Server
# =============================================================================
echo "Starting streaming auth server..."

cd "$APP_DIR"

# Ensure dependencies are installed
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm ci --production
fi

# Set environment variables
export NODE_ENV=production
export STREAMING_PORT=$STREAMING_PORT
export INSTANCE_ID=$INSTANCE_ID
export TUNNEL_URL=$TUNNEL_URL

# Start with PM2
pm2 delete streaming-auth 2>/dev/null || true
pm2 start server.js \
  --name streaming-auth \
  --max-memory-restart 500M \
  --log /var/log/streaming-auth.log

# Wait for server to be ready
echo "Waiting for streaming server to be ready..."
for i in {1..30}; do
  if curl -s "http://localhost:$STREAMING_PORT/health" > /dev/null 2>&1; then
    echo "Streaming server is ready!"
    break
  fi
  echo "  Waiting for server... attempt $i/30"
  sleep 2
done

if ! curl -s "http://localhost:$STREAMING_PORT/health" > /dev/null 2>&1; then
  signal_failure "Streaming server failed to start"
fi

# =============================================================================
# Step 3: Pre-warm Chromium
# =============================================================================
echo "Pre-warming Chromium browser..."

node -e "
const { chromium } = require('playwright-core');
(async () => {
  console.log('Launching Chromium...');
  const browser = await chromium.launch({ headless: true });
  console.log('Browser launched successfully');
  await browser.close();
  console.log('Browser pre-warm complete');
})().catch(err => {
  console.error('Pre-warm failed:', err.message);
  process.exit(0); // Don't fail on pre-warm error
});
"

# =============================================================================
# Step 4: Register with EC2 Manager
# =============================================================================
echo "Registering with EC2 Manager..."

# Call the callback endpoint
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_BASE_URL/api/internal/instance-ready" \
  -H "Content-Type: application/json" \
  -H "X-Internal-Key: ${INTERNAL_API_KEY:-}" \
  -d "{\"instanceId\": \"$INSTANCE_ID\", \"tunnelUrl\": \"$TUNNEL_URL\"}")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
  echo "Successfully registered with EC2 Manager"
  echo "Response: $BODY"
else
  echo "WARNING: Failed to register with EC2 Manager (HTTP $HTTP_CODE)"
  echo "Response: $BODY"
  # Don't fail - the health check will pick this up
fi

# =============================================================================
# Step 5: Setup Monitoring
# =============================================================================
echo "Setting up monitoring..."

# Create health check script
cat > /home/ec2-user/health-check.sh << 'HEALTHEOF'
#!/bin/bash
if curl -s "http://localhost:3002/health" > /dev/null 2>&1; then
  exit 0
else
  echo "$(date): Health check failed" >> /var/log/health-check.log
  exit 1
fi
HEALTHEOF
chmod +x /home/ec2-user/health-check.sh

# Add cron job for local health checks (every minute)
(crontab -l 2>/dev/null || true; echo "* * * * * /home/ec2-user/health-check.sh") | crontab -

# =============================================================================
# Complete
# =============================================================================
echo "=========================================="
echo "Instance setup complete!"
echo "Instance ID: $INSTANCE_ID"
echo "Tunnel URL: $TUNNEL_URL"
echo "Streaming Port: $STREAMING_PORT"
echo "=========================================="

# Save state for debugging
cat > /home/ec2-user/instance-info.json << EOF
{
  "instanceId": "$INSTANCE_ID",
  "tunnelUrl": "$TUNNEL_URL",
  "streamingPort": $STREAMING_PORT,
  "startedAt": "$(date -Iseconds)",
  "region": "$REGION"
}
EOF

echo "Instance info saved to /home/ec2-user/instance-info.json"
