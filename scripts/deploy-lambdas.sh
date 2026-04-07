#!/bin/bash
# Deploy all Lambda functions
# Each Lambda gets its own zip with shared/ copied into the package

set -e

LAMBDA_DIR="$(cd "$(dirname "$0")/../lambda" && pwd)"
SHARED_DIR="$LAMBDA_DIR/shared"

FUNCTIONS=(
  "ec2-manager-assign"
  "ec2-manager-scaler"
  "ec2-manager-health"
  "ec2-manager-callback"
  "extraction-manager"
)

echo "Deploying Lambda functions..."

for fn in "${FUNCTIONS[@]}"; do
  FN_DIR="$LAMBDA_DIR/$fn"
  BUILD_DIR="/tmp/lambda-build-$fn"

  echo "  Building $fn..."

  # Clean build directory
  rm -rf "$BUILD_DIR"
  mkdir -p "$BUILD_DIR"

  # Copy function code
  cp "$FN_DIR/index.js" "$BUILD_DIR/"
  cp "$FN_DIR/package.json" "$BUILD_DIR/" 2>/dev/null || true

  # Copy shared modules
  cp -r "$SHARED_DIR" "$BUILD_DIR/shared"

  # Install dependencies
  cd "$BUILD_DIR"
  if [ -f "package.json" ]; then
    npm install --production --silent
  fi

  # Create deployment package
  zip -r "/tmp/$fn.zip" . -x "*.DS_Store" > /dev/null

  # Deploy to AWS Lambda
  echo "  Deploying $fn to AWS Lambda..."
  aws lambda update-function-code \
    --function-name "$fn" \
    --zip-file "fileb:///tmp/$fn.zip" \
    --region "${AWS_REGION:-us-east-1}" \
    > /dev/null

  echo "  ✓ $fn deployed"

  # Cleanup
  rm -rf "$BUILD_DIR" "/tmp/$fn.zip"
done

echo "All Lambda functions deployed successfully."
