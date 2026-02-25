#!/bin/bash
# Start two Pando nodes on localhost for development/testing.
# Node 1: P2P 5001, API 5100, data ~/.pando-node1
# Node 2: P2P 5002, API 5200, data ~/.pando-node2
#
# Usage:
#   ./scripts/start-multi.sh            - start both nodes (keep running)
#   ./scripts/start-multi.sh --test     - start, verify P2P, exit
#   ./scripts/start-multi.sh --fresh    - wipe data dirs first

cd "$(dirname "$0")/.."
exec node scripts/launch-nodes.js "$@"
