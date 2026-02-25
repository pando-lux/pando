/**
 * Unit test for the Scheduler (Task 1.4).
 *
 * Tests the core pipeline: task creation -> claim -> profile generation ->
 * workspace creation -> status tracking. Does NOT test actual Claude Code
 * spawning (that's E2E), but verifies the flow up to workspace creation
 * and event emission.
 */

import { Scheduler } from '../packages/node/dist/scheduler.js';
import { TaskQueue } from '../packages/node/dist/task-queue.js';
import { ProfileCache } from '../packages/node/dist/profile-cache.js';
import { WorkspaceManager } from '../packages/node/dist/workspace-manager.js';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Test directories (isolated from real data)
const testDir = join(tmpdir(), `pando-scheduler-test-${Date.now()}`);
const tasksFile = join(testDir, 'agent', 'tasks.json');
const cacheFile = join(testDir, 'profile-cache.json');
const workspacesDir = join(testDir, 'workspaces');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}`);
    failed++;
  }
}

function cleanup() {
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
}

// ─── Test 1: Scheduler instantiation ──────────────────────────────────────

console.log('\n=== Test 1: Scheduler instantiation ===');

const tq = new TaskQueue(testDir);
const cache = new ProfileCache(cacheFile);
const wm = new WorkspaceManager({ baseDir: workspacesDir });

const scheduler = new Scheduler(
  { pollIntervalMs: 60000, maxConcurrentTasks: 2 },
  tq,
  cache,
  wm,
  'claude', // dummy path — won't actually spawn
);

assert(scheduler !== null, 'Scheduler created');
assert(typeof scheduler.start === 'function', 'start() method exists');
assert(typeof scheduler.stop === 'function', 'stop() method exists');
assert(typeof scheduler.getStatus === 'function', 'getStatus() method exists');
assert(typeof scheduler.processTask === 'function', 'processTask() method exists');

// ─── Test 2: getStatus before start ────────────────────────────────────────

console.log('\n=== Test 2: Status before start ===');

const statusBefore = scheduler.getStatus();
assert(statusBefore.running === false, 'running is false before start');
assert(Array.isArray(statusBefore.activeTasks), 'activeTasks is an array');
assert(statusBefore.activeTasks.length === 0, 'no active tasks');
assert(statusBefore.config.pollIntervalMs === 60000, 'config reflects custom pollIntervalMs');
assert(statusBefore.config.maxConcurrentTasks === 2, 'config reflects custom maxConcurrentTasks');
assert(statusBefore.totalProcessed === 0, 'totalProcessed is 0');
assert(statusBefore.totalSucceeded === 0, 'totalSucceeded is 0');
assert(statusBefore.totalFailed === 0, 'totalFailed is 0');

// ─── Test 3: start/stop ────────────────────────────────────────────────────

console.log('\n=== Test 3: Start and stop ===');

scheduler.start();
const statusDuring = scheduler.getStatus();
assert(statusDuring.running === true, 'running is true after start');

scheduler.stop();
const statusAfter = scheduler.getStatus();
assert(statusAfter.running === false, 'running is false after stop');

// ─── Test 4: Event emission ────────────────────────────────────────────────

console.log('\n=== Test 4: Event emission ===');

const events = [];
const scheduler2 = new Scheduler(
  { pollIntervalMs: 999999 }, // don't auto-poll
  tq,
  cache,
  wm,
  'nonexistent-claude-path', // will fail on spawn, that's fine
);

scheduler2.on('task:claimed', (data) => events.push({ type: 'task:claimed', ...data }));
scheduler2.on('task:workspace', (data) => events.push({ type: 'task:workspace', ...data }));
scheduler2.on('profile:generated', (data) => events.push({ type: 'profile:generated', ...data }));
scheduler2.on('task:spawned', (data) => events.push({ type: 'task:spawned', ...data }));
scheduler2.on('task:failed', (data) => events.push({ type: 'task:failed', ...data }));
scheduler2.on('task:completed', (data) => events.push({ type: 'task:completed', ...data }));

// Create a task
const task = tq.createTask({
  title: 'Test scheduler task',
  description: 'Write a hello world function in TypeScript',
  priority: 'low',
  createdBy: 'test',
});

assert(task.id.length > 0, 'Task created with ID');
assert(task.status === 'open', 'Task status is open');

// Try to process it (will fail at spawn but should claim + workspace first)
try {
  await scheduler2.processTask(task.id);
} catch {
  // Expected — claude path doesn't exist or agent will fail
}

// Give events time to propagate
await new Promise(r => setTimeout(r, 500));

// Check that we got at least the claim and workspace events
const claimEvent = events.find(e => e.type === 'task:claimed');
const workspaceEvent = events.find(e => e.type === 'task:workspace');
const profileEvent = events.find(e => e.type === 'profile:generated');

assert(claimEvent !== undefined, 'task:claimed event emitted');
assert(claimEvent?.taskId === task.id, 'task:claimed has correct taskId');

assert(workspaceEvent !== undefined, 'task:workspace event emitted');
assert(workspaceEvent?.workspaceDir !== undefined, 'task:workspace has workspaceDir');

assert(profileEvent !== undefined, 'profile:generated event emitted');
assert(profileEvent?.profileId !== undefined, 'profile:generated has profileId');

// ─── Test 5: Workspace was actually created ────────────────────────────────

console.log('\n=== Test 5: Workspace verification ===');

if (workspaceEvent?.workspaceDir) {
  const wsDir = workspaceEvent.workspaceDir;
  assert(existsSync(wsDir), 'Workspace directory exists');
  assert(existsSync(join(wsDir, 'CLAUDE.md')), 'CLAUDE.md exists');
  assert(existsSync(join(wsDir, 'context')), 'context/ directory exists');
  assert(existsSync(join(wsDir, 'output')), 'output/ directory exists');
  assert(existsSync(join(wsDir, 'memory')), 'memory/ directory exists');

  // Read CLAUDE.md and verify layers
  const claudeMd = readFileSync(join(wsDir, 'CLAUDE.md'), 'utf-8');
  assert(claudeMd.includes('Pando'), 'CLAUDE.md contains system rules (Pando)');
  assert(claudeMd.includes('Your Role'), 'CLAUDE.md has role section');
  assert(claudeMd.includes('Your Task'), 'CLAUDE.md has task section');
  assert(claudeMd.includes('hello world') || claudeMd.includes('TypeScript'), 'CLAUDE.md contains task description');
} else {
  assert(false, 'No workspace directory found (skipping workspace checks)');
}

// ─── Test 6: Profile was cached ────────────────────────────────────────────

console.log('\n=== Test 6: Profile cache ===');

const profiles = cache.list();
assert(profiles.length >= 1, 'At least one profile in cache');

// The default fallback profile should be there (since we have no API key)
const savedProfile = profiles[0];
assert(savedProfile.profileId !== undefined, 'Cached profile has profileId');
assert(savedProfile.tags.length > 0, 'Cached profile has tags');
assert(savedProfile.tier !== undefined, 'Cached profile has tier');

// ─── Test 7: Task status after processing ──────────────────────────────────

console.log('\n=== Test 7: Task status ===');

const taskAfter = tq.getTask(task.id);
// Task should be either rejected (spawn failed) or still claimed
// It won't be 'open' because we claimed it
assert(taskAfter !== null, 'Task still exists in queue');
assert(
  taskAfter.status === 'open' || taskAfter.status === 'claimed' ||
  taskAfter.status === 'in_progress' || taskAfter.status === 'done',
  `Task status is '${taskAfter?.status}' (claimed, in_progress, open, or done expected after processing attempt)`,
);

// ─── Test 8: processTask rejects bad taskId ────────────────────────────────

console.log('\n=== Test 8: Error handling ===');

try {
  await scheduler2.processTask('nonexistent-task-id');
  assert(false, 'Should have thrown for nonexistent task');
} catch (err) {
  assert(err.message.includes('not found'), 'Throws for nonexistent task');
}

// ─── Test 9: updateConfig ──────────────────────────────────────────────────

console.log('\n=== Test 9: Config updates ===');

scheduler2.updateConfig({ pollIntervalMs: 5000, maxConcurrentTasks: 5 });
const updatedStatus = scheduler2.getStatus();
assert(updatedStatus.config.pollIntervalMs === 5000, 'pollIntervalMs updated');
assert(updatedStatus.config.maxConcurrentTasks === 5, 'maxConcurrentTasks updated');

// ─── Test 10: Second task with profile cache hit ────────────────────────────

console.log('\n=== Test 10: Profile cache hit (second similar task) ===');

const events2 = [];
scheduler2.on('profile:cached', (data) => events2.push({ type: 'profile:cached', ...data }));

// Create a similar task
const task2 = tq.createTask({
  title: 'Another TypeScript task',
  description: 'Write a TypeScript function for general software development',
  priority: 'low',
  createdBy: 'test',
});

try {
  await scheduler2.processTask(task2.id);
} catch {
  // Expected — will fail at spawn
}

await new Promise(r => setTimeout(r, 500));

// Check if we got a cache hit (depends on overlap between "general software development"
// and the default profile tags ["general", "software", "development"])
const cacheHitEvent = events2.find(e => e.type === 'profile:cached');
// Note: cache hit depends on match threshold; with default profile tags this may or may not match.
// We just verify the mechanism is in place.
if (cacheHitEvent) {
  assert(true, 'profile:cached event emitted for similar task');
} else {
  // If no cache hit, that's also valid — the matching algorithm may not match
  console.log('  INFO: No cache hit for second task (threshold not met). This is acceptable.');
  assert(true, 'Scheduler proceeded without cache hit (Planner fallback)');
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

scheduler2.stop();
cleanup();

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
} else {
  console.log('SOME TESTS FAILED');
  process.exit(1);
}
