#!/bin/bash
# deploy-v2.sh — Deploy v2-architecture branch to all 5 nodes
# Run this after: npm run build passes on v2-architecture branch
# Usage: bash scripts/deploy-v2.sh [--node ec2-1|ec2-2|ls-1|ls-2|win] [--all]

set -e

TOKEN="bd5b00bab232c33c259c2603a9991925287cf43fb1f9519c4f00c04501532127"
SSH_KEY="/c/Users/jaira/.ssh/prax-lightsail-key.pem"

EC2_1_HOST="ubuntu@54.82.241.132"
EC2_2_HOST="ubuntu@34.201.82.126"
LS_1_HOST="ubuntu@54.145.144.221"
LS_2_HOST="ubuntu@3.237.175.38"

EC2_1_API="http://54.82.241.132:4000"
EC2_2_API="http://34.201.82.126:4000"
LS_1_API="http://54.145.144.221:4000"
LS_2_API="http://3.237.175.38:4000"
WIN_API="http://100.87.67.78:4100"

PANDO_DIR="/opt/pando"

smoke_test() {
  local api=$1
  local name=$2
  echo "  Smoke test $name ($api)..."
  local status=$(curl -sf "$api/status" -H "Authorization: Bearer $TOKEN" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('peerId','?')[:12]+'... peers='+str(len(d.get('peers',[]))))" 2>/dev/null || echo "FAILED")
  echo "  $name: $status"
}

deploy_node() {
  local host=$1
  local api=$2
  local name=$3
  echo ""
  echo "=== Deploying to $name ($host) ==="

  # Trigger upgrade via /upgrade endpoint (git pull + build + restart)
  local result=$(curl -sf -X POST "$api/upgrade" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"branch": "v2-architecture", "force": true}' 2>/dev/null || echo '{"error":"unreachable"}')

  echo "  Upgrade initiated: $result"
  echo "  Waiting 120s for node to restart..."
  sleep 120

  # Retry up to 3 times
  for i in 1 2 3; do
    if curl -sf "$api/status" -H "Authorization: Bearer $TOKEN" > /dev/null 2>&1; then
      smoke_test "$api" "$name"
      return 0
    fi
    echo "  Attempt $i: Node not up yet, waiting 30s..."
    sleep 30
  done

  echo "  ERROR: $name failed to come back online after upgrade"
  return 1
}

echo "=== Pando v2-architecture Deployment ==="
echo "Branch: v2-architecture"
echo "Time: $(date)"
echo ""

# Pre-flight: verify build passed
if [ ! -f "packages/node/dist/index.js" ]; then
  echo "ERROR: dist/ not found. Run 'npm run build' first."
  exit 1
fi

echo "Pre-flight: Checking all nodes are reachable..."
for node_api in "$EC2_1_API" "$EC2_2_API" "$LS_1_API" "$LS_2_API" "$WIN_API"; do
  if curl -sf "$node_api/status" -H "Authorization: Bearer $TOKEN" > /dev/null 2>&1; then
    echo "  $node_api: REACHABLE"
  else
    echo "  $node_api: UNREACHABLE (will skip)"
  fi
done

if [[ "$1" == "--all" || "$#" -eq 0 ]]; then
  # Deploy in order: trusted nodes first, then relay nodes
  deploy_node "$EC2_1_HOST" "$EC2_1_API" "EC2-1 (trusted)"
  deploy_node "$EC2_2_HOST" "$EC2_2_API" "EC2-2 (trusted)"
  deploy_node "$LS_1_HOST" "$LS_1_API" "LS-1 (relay)"
  deploy_node "$LS_2_HOST" "$LS_2_API" "LS-2 (untrusted)"
  echo ""
  echo "  NOTE: Windows node (100.87.67.78:4100) must be deployed manually"
  echo "  SSH not available. Pull and build manually on Windows."
fi

echo ""
echo "=== Final Status Check (all nodes) ==="
smoke_test "$EC2_1_API" "EC2-1"
smoke_test "$EC2_2_API" "EC2-2"
smoke_test "$LS_1_API" "LS-1"
smoke_test "$LS_2_API" "LS-2"
smoke_test "$WIN_API" "Windows"

echo ""
echo "=== Deployment Complete ==="
echo "See genome/v2-execution-log.md for the phase log."
