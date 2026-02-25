#!/bin/bash
# Pando Supervisor — The ONE script that keeps everything alive.
# Managed by launchd (KeepAlive=true). If this exits, launchd restarts it.
# Replaces: co-ceo-watchdog.sh, qa-monitor.sh
#
# What it monitors (every 60s):
#   - Mac node (restart if down)
#   - Gateway (rebuild production + restart if down)
#   - Windows node (SSH restart if down)
#   - Agents (re-enable if disabled, restart node if stalled)
#
# What it runs periodically:
#   - E2E tests every 15 min → creates fix tasks on failure
#   - Log trimming every 100 cycles

LOG="$HOME/Desktop/pando_admin/scripts/supervisor.log"
PANDO_DIR="$HOME/Desktop/pando"
ADMIN_DIR="$HOME/Desktop/pando_admin"
MAC_API="http://localhost:4000"
WIN_API="http://100.87.67.78:4100"
GATEWAY_URL="http://localhost:3000"
GATEWAY_DIR="$PANDO_DIR/packages/gateway"
SSH_CMD="ssh -o IdentitiesOnly=yes -o ConnectTimeout=10 -o BatchMode=yes -i $HOME/.ssh/id_ed25519 pando@100.87.67.78"
export GATEWAY_PUBLIC_URL="https://gateway-one-mu.vercel.app"
NODE_BIN="$HOME/.nvm/versions/node/v20.19.6/bin/node"
NPM_BIN="$HOME/.nvm/versions/node/v20.19.6/bin/npm"
NPX_BIN="$HOME/.nvm/versions/node/v20.19.6/bin/npx"

# Track stall detection
LAST_MAC_WAKE_COUNT=""
LAST_WIN_WAKE_COUNT=""
MAC_STALL_TICKS=0
WIN_STALL_TICKS=0
CYCLE=0

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG"
}

# --- Mac Node ---
ensure_mac_node() {
  local resp
  resp=$(curl -s --max-time 5 "$MAC_API/status" 2>/dev/null)
  if [ -n "$resp" ]; then
    return 0
  fi

  log "ALERT: Mac node DOWN. Restarting..."
  # Kill any zombie node process
  pkill -9 -f "tui.js" 2>/dev/null
  sleep 2

  cd "$PANDO_DIR"
  nohup "$NODE_BIN" packages/node/dist/tui.js --port 4001 --api-port 4000 > /dev/null 2>&1 &
  log "FIX: Mac node started (PID $!). Waiting 12s..."
  sleep 12

  local verify
  verify=$(curl -s --max-time 5 "$MAC_API/status" 2>/dev/null)
  if [ -n "$verify" ]; then
    log "FIX: Mac node is BACK UP"
  else
    log "ERROR: Mac node failed to restart"
  fi
}

# --- Gateway ---
ensure_gateway() {
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$GATEWAY_URL" 2>/dev/null)
  if [ "$code" = "200" ] || [ "$code" = "304" ]; then
    return 0
  fi

  log "ALERT: Gateway DOWN (HTTP $code). Rebuilding production..."
  # Kill any existing gateway process
  pkill -f "next start" 2>/dev/null
  pkill -f "next dev.*3000" 2>/dev/null
  sleep 2

  # Build production if needed (BUILD_ID missing or stale)
  if [ ! -f "$GATEWAY_DIR/.next/BUILD_ID" ]; then
    log "FIX: No production build found. Building..."
    cd "$GATEWAY_DIR"
    "$NPX_BIN" next build >> "$LOG" 2>&1
    if [ $? -ne 0 ]; then
      log "ERROR: Gateway production build FAILED"
      return 1
    fi
    log "FIX: Gateway production build complete"
  fi

  # Start in production mode
  cd "$GATEWAY_DIR"
  nohup "$NPX_BIN" next start -p 3000 > /dev/null 2>&1 &
  log "FIX: Gateway started in PRODUCTION mode (PID $!)"
  sleep 5

  local verify_code
  verify_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$GATEWAY_URL" 2>/dev/null)
  if [ "$verify_code" = "200" ] || [ "$verify_code" = "304" ]; then
    log "FIX: Gateway is BACK UP (production mode)"
  else
    log "ERROR: Gateway failed to start (HTTP $verify_code)"
  fi
}

# --- Windows Node ---
check_windows() {
  local resp
  resp=$(curl -s --max-time 10 "$WIN_API/status" 2>/dev/null)
  if [ -n "$resp" ]; then
    return 0
  fi

  log "ALERT: Windows node DOWN. Sending SSH restart..."
  $SSH_CMD 'schtasks /delete /tn "PandoNode" /f 2>NUL & schtasks /create /tn "PandoNode" /tr "cmd /k cd /d C:\pando && node packages\node\dist\tui.js --port 4001 --api-port 4100 --bootstrap /ip4/100.69.190.122/tcp/4001/p2p/12D3KooWCFawRRdpL9w1kehZdAK7JGQqEqUfKKV72f7qEEtmwj7K" /sc once /st 00:00 /it /f && schtasks /run /tn "PandoNode"' 2>/dev/null
  log "FIX: Windows restart command sent"
}

# --- Agent Health ---
check_agents() {
  # Mac agent
  local mac_agent
  mac_agent=$(curl -s --max-time 5 "$MAC_API/agent/status" 2>/dev/null)
  if [ -n "$mac_agent" ]; then
    local mac_enabled
    mac_enabled=$(echo "$mac_agent" | python3 -c "import sys,json; print(json.load(sys.stdin).get('enabled',False))" 2>/dev/null)
    local mac_wake
    mac_wake=$(echo "$mac_agent" | python3 -c "import sys,json; print(json.load(sys.stdin).get('wakeUpCount',0))" 2>/dev/null)

    if [ "$mac_enabled" = "False" ]; then
      log "FIX: Mac agent disabled. Re-enabling..."
      curl -s -X POST "$MAC_API/agent/enable" > /dev/null 2>&1
    fi

    # Stall detection: if wakeUpCount unchanged for 10 ticks (10 min), restart
    if [ "$mac_wake" = "$LAST_MAC_WAKE_COUNT" ] && [ -n "$LAST_MAC_WAKE_COUNT" ]; then
      MAC_STALL_TICKS=$((MAC_STALL_TICKS + 1))
      if [ $MAC_STALL_TICKS -ge 10 ]; then
        log "ALERT: Mac agent stalled ($MAC_STALL_TICKS ticks, wake=$mac_wake). Restarting node..."
        pkill -9 -f "tui.js" 2>/dev/null
        MAC_STALL_TICKS=0
        sleep 3
        ensure_mac_node
      fi
    else
      MAC_STALL_TICKS=0
    fi
    LAST_MAC_WAKE_COUNT="$mac_wake"
  fi

  # Windows agent
  local win_agent
  win_agent=$(curl -s --max-time 5 "$WIN_API/agent/status" 2>/dev/null)
  if [ -n "$win_agent" ]; then
    local win_enabled
    win_enabled=$(echo "$win_agent" | python3 -c "import sys,json; print(json.load(sys.stdin).get('enabled',False))" 2>/dev/null)
    local win_wake
    win_wake=$(echo "$win_agent" | python3 -c "import sys,json; print(json.load(sys.stdin).get('wakeUpCount',0))" 2>/dev/null)
    local win_pending
    win_pending=$(echo "$win_agent" | python3 -c "import sys,json; print(json.load(sys.stdin).get('pendingApproval','None'))" 2>/dev/null)

    if [ "$win_enabled" = "False" ]; then
      log "FIX: Windows agent disabled. Re-enabling..."
      curl -s -X POST "$WIN_API/agent/enable" > /dev/null 2>&1
    fi

    # Pending approval — force CEO wake
    if [ "$win_pending" != "None" ] && [ "$win_pending" != "null" ] && [ "$win_pending" != "None" ]; then
      log "FIX: Windows has pending approval. Forcing CEO wake..."
      curl -s -X POST "$MAC_API/agent/wake" > /dev/null 2>&1
    fi

    # Stall detection
    if [ "$win_wake" = "$LAST_WIN_WAKE_COUNT" ] && [ -n "$LAST_WIN_WAKE_COUNT" ]; then
      WIN_STALL_TICKS=$((WIN_STALL_TICKS + 1))
      if [ $WIN_STALL_TICKS -ge 10 ]; then
        log "ALERT: Windows agent stalled ($WIN_STALL_TICKS ticks). SSH restart..."
        WIN_STALL_TICKS=0
        check_windows
      fi
    else
      WIN_STALL_TICKS=0
    fi
    LAST_WIN_WAKE_COUNT="$win_wake"
  fi
}

# --- E2E Tests (every 15 min = every 15 cycles) ---
run_e2e() {
  log "E2E: Running tests..."
  local output
  output=$("$NODE_BIN" "$ADMIN_DIR/tests/e2e-user-flow.mjs" 2>&1)
  local exit_code=$?

  if [ $exit_code -eq 0 ]; then
    log "E2E: ALL TESTS PASSED"
  else
    log "E2E: TESTS FAILED (exit $exit_code)"
    # Extract failure summary (last 10 lines)
    local summary
    summary=$(echo "$output" | tail -10)
    log "E2E FAILURE: $summary"

    # Create a fix task via the Mac API
    local task_payload
    task_payload=$(cat <<'PAYLOAD'
{"title":"E2E test failure — auto-detected by supervisor","description":"E2E tests failed. Check supervisor.log for details. Run: node ~/Desktop/pando_admin/tests/e2e-user-flow.mjs to reproduce.","priority":"high","createdBy":"supervisor"}
PAYLOAD
)
    curl -s -X POST "$MAC_API/tasks" \
      -H "Content-Type: application/json" \
      -d "$task_payload" > /dev/null 2>&1
    log "E2E: Created HIGH priority fix task"
  fi
}

# --- Log Trimming (every 100 cycles) ---
trim_log() {
  local lines
  lines=$(wc -l < "$LOG" 2>/dev/null || echo 0)
  if [ "$lines" -gt 5000 ]; then
    tail -5000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
    log "LOG: Trimmed to 5000 lines (was $lines)"
  fi
}

# ==================== MAIN LOOP ====================
log "============================================"
log "PANDO SUPERVISOR STARTED"
log "Cycle interval: 60s"
log "Mac API: $MAC_API | Win API: $WIN_API"
log "Gateway: $GATEWAY_URL"
log "Node: $NODE_BIN"
log "============================================"

while true; do
  CYCLE=$((CYCLE + 1))

  # Core health checks — every cycle (60s)
  ensure_mac_node
  ensure_gateway
  check_windows
  check_agents

  # E2E tests — every 15 cycles (15 min)
  if [ $((CYCLE % 15)) -eq 0 ]; then
    run_e2e
  fi

  # Log trimming — every 100 cycles
  if [ $((CYCLE % 100)) -eq 0 ]; then
    trim_log
  fi

  # Brief status every 10 cycles
  if [ $((CYCLE % 10)) -eq 0 ]; then
    log "STATUS: Cycle $CYCLE — all checks complete"
  fi

  sleep 60
done
