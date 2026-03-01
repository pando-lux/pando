#!/bin/bash
# Pando CEO Session Monitor — runs every 5 min for 2 hours
LOG="/c/Users/jaira/Desktop/Pando/monitor-log.txt"
CHECKS=24
INTERVAL=300

echo "=== PANDO MONITOR STARTED $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" > "$LOG"

for i in $(seq 1 $CHECKS); do
  echo "" >> "$LOG"
  echo "--- CHECK #$i @ $(date -u +%Y-%m-%dT%H:%M:%SZ) ---" >> "$LOG"

  # 1. Windows node status
  WIN=$(curl -s --max-time 10 http://127.0.0.1:4100/v1/status 2>/dev/null)
  if [ -z "$WIN" ]; then
    echo "WINDOWS: DOWN" >> "$LOG"
  else
    echo "$WIN" | python -c "
import sys,json
try:
  d=json.load(sys.stdin)
  print(f'WINDOWS: UP | peers={d.get(\"peers\",0)} | uptime={d.get(\"uptime\",0)//60}min')
except: print('WINDOWS: PARSE ERROR')
" >> "$LOG" 2>&1
  fi

  # 2. Agent tree - active agents
  curl -s --max-time 10 http://127.0.0.1:4100/v1/agents/tree 2>/dev/null | python -c "
import sys,json
try:
  d=json.load(sys.stdin)
  agents = d if isinstance(d, list) else d.get('agents', d.get('tree', []))
  active = [a for a in agents if a.get('status') in ('active','idle')]
  failed = [a for a in agents if a.get('status') == 'failed']
  workers = [a for a in agents if a.get('role') not in ('council','observer','governance') and a.get('status') == 'active']
  print(f'AGENTS: {len(active)} active, {len(failed)} failed, {len(workers)} workers running')
  for a in active:
    aid = a.get('id','?')[:25]
    role = a.get('role','?')
    print(f'  {aid} | {role} | {a.get(\"status\",\"?\")}')
except: print('AGENTS: PARSE ERROR')
" >> "$LOG" 2>&1

  # 3. Directives
  curl -s --max-time 10 http://127.0.0.1:4100/v1/council/directives 2>/dev/null | python -c "
import sys,json
try:
  data=json.load(sys.stdin)
  dirs = data if isinstance(data, list) else data.get('directives', [])
  if dirs:
    print(f'DIRECTIVES: {len(dirs)} active')
    for d in dirs:
      did = d.get('id','?')
      status = d.get('status','?')
      seen = d.get('timesSeen', d.get('times_seen', 0))
      content = d.get('content','')[:80]
      print(f'  D#{did} [{status}] seen={seen}x: {content}')
  else:
    print('DIRECTIVES: none active')
except: print('DIRECTIVES: PARSE ERROR')
" >> "$LOG" 2>&1

  # 4. Recent tick log (last 3 ticks)
  python -c "
import sqlite3, os
db = sqlite3.connect(os.path.expanduser('~/.pando/agents.db'))
# Council ticks
rows = db.execute('''SELECT orchestrator_id, tick_number, tier, substr(actions_taken,1,120), created_at
    FROM tick_log ORDER BY created_at DESC LIMIT 3''').fetchall()
print('RECENT TICKS:')
for r in rows:
    oid = r[0][:20] if r[0] else '?'
    actions = r[3] or 'none'
    print(f'  {r[4]} | {oid} tick#{r[1]} T{r[2]} | {actions}')

# Observer last tick
obs = db.execute('''SELECT tick_number, tier, substr(actions_taken,1,120), created_at
    FROM tick_log WHERE orchestrator_id LIKE '%observer%'
    ORDER BY created_at DESC LIMIT 1''').fetchall()
if obs:
    print(f'OBSERVER LAST: tick#{obs[0][0]} T{obs[0][1]} @ {obs[0][3]} | {obs[0][2] or \"idle\"}')
else:
    print('OBSERVER LAST: no ticks')

db.close()
" >> "$LOG" 2>&1

  # 5. Git status - latest commit
  LATEST=$(cd /c/Users/jaira/Desktop/Pando && git log --oneline -1 2>/dev/null)
  echo "GIT HEAD: $LATEST" >> "$LOG"

  # 6. EC2 node commits (quick check, 5s timeout)
  for ip in 54.82.241.132 34.201.82.126; do
    commit=$(ssh -i ~/.ssh/prax-lightsail-key.pem -o StrictHostKeyChecking=no -o ConnectTimeout=5 ubuntu@$ip "cat /opt/pando/packages/node/dist/.build-commit 2>/dev/null" 2>/dev/null | head -c 8)
    echo "EC2 $ip: ${commit:-UNREACHABLE}" >> "$LOG"
  done

  # 7. Check for problems
  python -c "
import sqlite3, os, json
db = sqlite3.connect(os.path.expanduser('~/.pando/agents.db'))
problems = []

# Check if council is stale (no tick in 5 min)
last = db.execute('''SELECT created_at FROM tick_log WHERE orchestrator_id LIKE '%council%' ORDER BY created_at DESC LIMIT 1''').fetchone()
if last:
    from datetime import datetime
    last_t = datetime.fromisoformat(last[0].replace('Z','+00:00'))
    now = datetime.now(last_t.tzinfo)
    mins_ago = (now - last_t).total_seconds() / 60
    if mins_ago > 5:
        problems.append(f'CEO stale: last tick {mins_ago:.0f}min ago')

# Check for stuck workers (active > 30 min)
workers = db.execute('''SELECT id, role, created_at FROM agent_identity WHERE status = 'active' AND type = 'worker' ''').fetchall()
for w in workers:
    from datetime import datetime
    try:
        ct = datetime.fromisoformat(w[2].replace('Z','+00:00'))
        now = datetime.now(ct.tzinfo)
        mins = (now - ct).total_seconds() / 60
        if mins > 30:
            problems.append(f'Stuck worker: {w[0][:20]} role={w[1]} ({mins:.0f}min)')
    except: pass

if problems:
    print('PROBLEMS:')
    for p in problems:
        print(f'  !! {p}')
else:
    print('PROBLEMS: none detected')

db.close()
" >> "$LOG" 2>&1

  echo "--- END CHECK #$i ---" >> "$LOG"

  if [ $i -lt $CHECKS ]; then
    sleep $INTERVAL
  fi
done

echo "" >> "$LOG"
echo "=== MONITOR COMPLETE $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> "$LOG"
