#!/bin/bash
# Pando Node Launcher (macOS)
# Double-click this file to start a Pando node.
# Auto-installs and builds on first run.
# Restarts automatically on upgrade (exit code 75) or crash.

# Ensure common CLI locations are on PATH — double-click launchers and nohup
# often start with a minimal environment that omits ~/.local/bin (Claude CLI),
# /opt/homebrew/bin (Apple Silicon Homebrew), and /usr/local/bin.
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

# Set gateway URL for deployed apps (URL injection at deploy time)
export HUB_PUBLIC_URL="${HUB_PUBLIC_URL:-https://gateway-one-mu.vercel.app}"

cd "$(dirname "$0")"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "First run — installing dependencies..."
  npm install
fi

# Restart loop
while true; do
  node packages/node/dist/tui.js --port 4001 --api-port 4000
  EXIT_CODE=$?
  if [ $EXIT_CODE -eq 0 ]; then
    echo "Clean shutdown. Exiting."
    break
  elif [ $EXIT_CODE -eq 75 ]; then
    echo "Upgrade complete. Restarting..."
    sleep 2
  else
    echo "Crashed (exit $EXIT_CODE). Restarting in 5s..."
    sleep 5
  fi
done
