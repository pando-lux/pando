#!/bin/bash
# Pando Instance Security Monitor — Phase 64
# Runs as root on EC2 compute instances.
# Detects unauthorized access. Wipes credentials and shuts down on intrusion.
#
# This script is also embedded in cloud-instance-manager.ts (user-data bootstrap).
# This standalone copy is for reference and testing.

echo "[pando-monitor] Security monitor started at $(date -u)"

PANDO_PID=""

while true; do
  # Find pando node PID if not cached or if process died
  if [ -z "$PANDO_PID" ] || ! kill -0 "$PANDO_PID" 2>/dev/null; then
    PANDO_PID=$(pgrep -f "pando.*cli.js" || echo "")
  fi

  ALARM=0

  # Check 1: Any logged-in users?
  LOGINS=$(who 2>/dev/null | wc -l)
  if [ "$LOGINS" -gt 0 ]; then
    logger "PANDO TRIPWIRE: Active login session detected ($LOGINS users)"
    ALARM=1
  fi

  # Check 2: sshd somehow running?
  if pgrep -x sshd > /dev/null 2>&1; then
    logger "PANDO TRIPWIRE: sshd process detected"
    ALARM=1
  fi

  # Check 3: SSM agent running?
  if pgrep -f "amazon-ssm-agent" > /dev/null 2>&1; then
    logger "PANDO TRIPWIRE: SSM agent detected"
    ALARM=1
  fi

  # Check 4: Debugger attached to pando process?
  if [ -n "$PANDO_PID" ] && [ -f "/proc/$PANDO_PID/status" ]; then
    TRACER=$(grep "^TracerPid:" /proc/$PANDO_PID/status 2>/dev/null | awk '{print $2}')
    if [ -n "$TRACER" ] && [ "$TRACER" != "0" ]; then
      logger "PANDO TRIPWIRE: Debugger attached (TracerPid=$TRACER)"
      ALARM=1
    fi
  fi

  # Check 5: Unexpected root shell or su/sudo activity
  if pgrep -u 0 -x "bash|sh|zsh|dash" > /dev/null 2>&1; then
    # Filter out our own monitor script's shell
    ROOT_SHELLS=$(pgrep -u 0 -x "bash|sh|zsh|dash" | grep -v "$$" | wc -l)
    if [ "$ROOT_SHELLS" -gt 1 ]; then
      logger "PANDO TRIPWIRE: Unexpected root shells ($ROOT_SHELLS)"
      ALARM=1
    fi
  fi

  if [ "$ALARM" -eq 1 ]; then
    logger "PANDO TRIPWIRE: === INTRUSION DETECTED — WIPING ==="

    # Kill all pando/node/nginx processes
    killall -9 node nginx 2>/dev/null || true

    # Wipe credential data
    rm -rf /home/pando/.pando/resource_registry* 2>/dev/null || true
    rm -rf /home/pando/.pando/ledger.db* 2>/dev/null || true
    rm -rf /home/pando/.pando/identity.json 2>/dev/null || true
    rm -rf /home/pando/.pando/identities 2>/dev/null || true
    rm -rf /home/pando/.pando/session.json 2>/dev/null || true
    rm -rf /home/pando/.pando/api-token 2>/dev/null || true

    # Overwrite with zeros (paranoid wipe)
    dd if=/dev/zero of=/home/pando/.pando/wipe bs=1M count=10 2>/dev/null || true
    rm -f /home/pando/.pando/wipe

    logger "PANDO TRIPWIRE: Wipe complete. Shutting down."
    shutdown -h now
    exit 1
  fi

  sleep 1
done
