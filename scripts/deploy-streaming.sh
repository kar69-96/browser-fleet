#!/bin/bash
# Deploy streaming server to EC2 instance
# Copies streaming-server/ and config/ to the target instance

set -e

INSTANCE_ID="${1:?Usage: deploy-streaming.sh <instance-id> <key-file>}"
KEY_FILE="${2:?Usage: deploy-streaming.sh <instance-id> <key-file>}"
REGION="${AWS_REGION:-us-east-1}"

echo "Getting instance public IP..."
IP=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --region "$REGION" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text)

if [ "$IP" = "None" ] || [ -z "$IP" ]; then
  echo "ERROR: Instance $INSTANCE_ID has no public IP. Is it running?"
  exit 1
fi

echo "Deploying to $IP..."

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_DIR="/home/ec2-user/app"

# Copy streaming server and config
scp -i "$KEY_FILE" -r \
  "$PROJECT_DIR/streaming-server/" \
  "$PROJECT_DIR/config/" \
  "$PROJECT_DIR/package.json" \
  "ec2-user@$IP:$REMOTE_DIR/"

# Install dependencies and restart
ssh -i "$KEY_FILE" "ec2-user@$IP" << 'EOF'
  cd /home/ec2-user/app
  npm install --production
  pm2 restart streaming-auth || pm2 start streaming-server/server.js --name streaming-auth
  echo "Streaming server deployed and restarted"
EOF

echo "Deployment complete."
