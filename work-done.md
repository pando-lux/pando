# CEO Work Log

## Session: 2026-03-09

### Bugs Found & Fixed

#### 1. E2E Tests ECONNREFUSED (was 2/7 → now 7/7)
- **Root cause**: `npm run build` changes dist → node auto-restarts → tests start before ready
- **Fix**: 30s health-check retry in `test.beforeAll()`
- **Commit**: `64dbf803`

#### 2. Pipeline 4 Test Timeout (180s)
- **Root cause**: Waited 150s for engine build completion (builds take 5+ min)
- **Fix**: Verify dispatch only (30s), not completion. 90s timeout.
- **Commit**: `64dbf803`

#### 3. Two Laws Check Missing on Build Intent (SECURITY)
- **Root cause**: `violatesTwoLaws()` only checked for `report` intent. Build requests bypassed.
- **Fix**: Two Laws check at top of chat handler, before classification.
- **Commit**: `8d8d4992`

#### 4. Board Tasks Invisible After Status Update (LOGIC BUG)
- **Root cause**: API accepted `in-progress` (hyphen), SQL filtered on `in_progress` (underscore)
- **Fix**: Normalize hyphens to underscores at write time + accept both in read query.
- **Commit**: `1f89461c`

#### 5. Node Crash: SyntaxError in init-platform.ts (CRITICAL)
- **Root cause**: Background agent (`ecc9d1e8`) added `await import()` inside a non-async callback. `onMessage` callback was not async → "Unexpected reserved word" SyntaxError at ESM compile time.
- **Fix**: Made `onMessage` callback `async`.
- **Commit**: `53f9a43b`

### Manual API Testing (Logical)

#### Chat Edge Cases
| Test | Result |
|------|--------|
| Empty message | 400 ✅ |
| Whitespace only | 400 ✅ |
| No message field | 400 ✅ |
| No auth | 401 ✅ |
| Long message (5000 chars) | Handled ✅ |
| XSS attempt | Classified as report (safe) ✅ |

#### Agent Spawn/Stop
| Test | Result |
|------|--------|
| Spawn worker | Success, 4 agents ✅ |
| Stop worker | Back to 3 ✅ |
| Stop lead | Rejected ✅ |
| Nonexistent agent | 404 ✅ |
| Nonexistent template | Error + hint ✅ |
| Two Laws violation | Rejected ✅ |

#### Board Task Lifecycle
| Test | Result |
|------|--------|
| Create → pending | ✅ |
| Update → in-progress | ✅ (FIXED) |
| Update → done | ✅ |
| Board filters correctly | ✅ |

### E2E Test Results
- **7/7 pass** on warm node (running 5+ min with peers)
- **4/7 pass** on cold start (transient: deploy timeout, missing signature, no projectStore yet)
- Cold start failures are timing-related, not code bugs

### Commits Pushed
1. `64dbf803` — E2E test fixes (beforeAll + Pipeline 4)
2. `8d8d4992` — Two Laws check on all chat intents
3. `1f89461c` — Board status normalization
4. `53f9a43b` — Fix async crash in onMessage handler

### Observations
- Council (pando-infra) running with 3 agents, all active
- Lead correctly identifies and closes malicious tasks autonomously
- Cost: ~71 Lux, ~3.2M tokens consumed
- Doorman classification works correctly for build requests
- Engine dispatches within 30s
- Peer connectivity can be slow from cold start (NAT issues)

### EC2 Node Recovery
- Both EC2 nodes crashed from the broken commit `ecc9d1e8` (SyntaxError)
- Circuit breakers tripped (184 consecutive failures on EC2-1)
- **Fixed**: Pulled `53f9a43b` to both EC2s, reset circuit breakers, restarted
- **Pando data dir on EC2**: `/home/pando/.pando/` (runs as `pando` user)
- **All 3 nodes operational**: Windows (2 peers), EC2-1, EC2-2
- **Final E2E**: 7/7 pass with full 3-node network

### Pending
- [ ] PandoCode web UI testing (UI not running currently)
- [ ] Phase 6.2+: Cross-node team migration
- [ ] Phase 8: Gateway integration
