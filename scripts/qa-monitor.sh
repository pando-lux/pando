#!/bin/bash
# DEPRECATED — replaced by pando-supervisor.sh (managed by launchd)
# This script is kept for reference only. Do not run it.
#
# QA Monitor — Continuous agent health and progress verification
# Runs every 2 minutes, checks both nodes, reports issues
# Launch: nohup bash ~/Desktop/pando_admin/scripts/qa-monitor.sh > /tmp/qa-monitor.log 2>&1 &

MAC_API="http://localhost:4000"
WIN_API="http://100.87.67.78:4100"
LOG="/tmp/qa-monitor.log"
CYCLE=0

log() { echo "[QA $(date '+%H:%M:%S')] $1"; }

check_node() {
  local name=$1 api=$2
  local status=$(curl -s --max-time 5 "$api/status" 2>/dev/null)
  if [ -z "$status" ]; then
    log "CRITICAL: $name node NOT RESPONDING at $api"
    return 1
  fi
  local peers=$(echo "$status" | python3 -c "import sys,json; print(json.load(sys.stdin).get('peers',0))" 2>/dev/null)
  log "$name: online, peers=$peers"
  return 0
}

check_agent() {
  local name=$1 api=$2
  local agent=$(curl -s --max-time 5 "$api/agent/status" 2>/dev/null)
  if [ -z "$agent" ]; then
    log "WARNING: $name agent status unavailable"
    return 1
  fi
  local enabled=$(echo "$agent" | python3 -c "import sys,json; print(json.load(sys.stdin).get('enabled',False))" 2>/dev/null)
  local awake=$(echo "$agent" | python3 -c "import sys,json; print(json.load(sys.stdin).get('currentlyAwake',False))" 2>/dev/null)
  local wake=$(echo "$agent" | python3 -c "import sys,json; print(json.load(sys.stdin).get('wakeUpCount',0))" 2>/dev/null)
  local pending=$(echo "$agent" | python3 -c "import sys,json; print(json.load(sys.stdin).get('pendingApproval','None'))" 2>/dev/null)
  local session=$(echo "$agent" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sessionType','quick'))" 2>/dev/null)

  log "$name agent: enabled=$enabled, awake=$awake, wake=$wake, session=$session"

  if [ "$enabled" = "False" ]; then
    log "WARNING: $name agent DISABLED. Re-enabling..."
    curl -s -X POST "$api/agent/enable" > /dev/null 2>&1
    log "$name agent re-enabled"
  fi

  if [ "$pending" != "None" ] && [ "$pending" != "null" ]; then
    log "ACTION: $name has pending approval: $pending"
  fi
  return 0
}

check_task_queue() {
  local tasks=$(curl -s --max-time 5 "$MAC_API/tasks/stats" 2>/dev/null)
  if [ -z "$tasks" ]; then
    log "WARNING: Task queue not available"
    return
  fi
  log "Task queue: $(echo "$tasks" | python3 -c "import sys,json; d=json.load(sys.stdin).get('stats',{}); print(', '.join(f'{k}={v}' for k,v in d.items()))" 2>/dev/null)"
}

check_api_health() {
  local api=$1 name=$2
  local endpoints=("/status" "/agent/status" "/tasks" "/peers")
  local failures=0
  for ep in "${endpoints[@]}"; do
    local code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$api$ep" 2>/dev/null)
    if [ "$code" != "200" ]; then
      log "FAIL: $name $ep returned $code"
      failures=$((failures+1))
    fi
  done
  if [ $failures -eq 0 ]; then
    log "$name API: all endpoints healthy"
  else
    log "WARNING: $name has $failures failing endpoints"
  fi
}

check_builder_progress() {
  # Check if builder has claimed a task from the queue
  local tasks=$(curl -s --max-time 5 "$WIN_API/tasks?status=claimed" 2>/dev/null)
  local claimed=$(echo "$tasks" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('tasks',[])))" 2>/dev/null)

  if [ "$claimed" = "0" ]; then
    log "INFO: Builder has no claimed tasks. Checking if there are open tasks..."
    local open=$(curl -s --max-time 5 "$WIN_API/tasks?status=open" 2>/dev/null | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('tasks',[])))" 2>/dev/null)
    if [ "$open" != "0" ]; then
      log "INFO: $open open tasks available for builder to claim"
    fi
  else
    log "Builder: $claimed task(s) claimed and in progress"
  fi
}

log "=== QA Monitor Started ==="
log "Monitoring Mac ($MAC_API) and Windows ($WIN_API)"

while true; do
  CYCLE=$((CYCLE+1))
  log ""
  log "========== QA Cycle #$CYCLE =========="

  # Node health
  check_node "Mac" "$MAC_API"
  mac_ok=$?
  check_node "Windows" "$WIN_API"
  win_ok=$?

  # Agent status
  if [ $mac_ok -eq 0 ]; then
    check_agent "Mac CEO" "$MAC_API"
    check_api_health "$MAC_API" "Mac"
  fi

  if [ $win_ok -eq 0 ]; then
    check_agent "Windows Builder" "$WIN_API"
    check_api_health "$WIN_API" "Windows"
    check_builder_progress
  fi

  # Task queue
  check_task_queue

  log "========== QA Cycle #$CYCLE Complete =========="

  # Sleep 2 minutes
  sleep 120
done
