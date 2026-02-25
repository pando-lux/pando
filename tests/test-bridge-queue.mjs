/**
 * BridgeQueue unit tests — Phase 25
 *
 * Tests:
 * 1. Basic enqueue/dequeue
 * 2. Priority ordering (critical > normal > low)
 * 3. FIFO within same priority
 * 4. Manager busy/idle tracking
 * 5. Event emissions (newItem, managerIdle)
 * 6. Multi-manager isolation
 * 7. Empty queue returns null
 * 8. Queue status reporting
 */

import { BridgeQueue } from '../packages/node/dist/bridge-queue.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

// ── Test 1: Basic enqueue/dequeue ──────────────────────────────────────────
console.log('\n═══ Test 1: Basic enqueue/dequeue ═══');
{
  const bq = new BridgeQueue();
  const item = bq.enqueue('mgr-1', {
    type: 'task_completed',
    source: 'scheduler',
    payload: { taskId: 'abc123' },
    priority: 'normal',
  });

  assert(item.id !== undefined, 'Item gets a UUID');
  assert(item.managerId === 'mgr-1', 'Item has correct managerId');
  assert(item.type === 'task_completed', 'Item has correct type');
  assert(item.timestamp > 0, 'Item has timestamp');
  assert(bq.length('mgr-1') === 1, 'Queue length is 1');

  const dequeued = bq.dequeue('mgr-1');
  assert(dequeued !== null, 'Dequeue returns item');
  assert(dequeued.id === item.id, 'Dequeued item matches enqueued');
  assert(bq.length('mgr-1') === 0, 'Queue empty after dequeue');

  const empty = bq.dequeue('mgr-1');
  assert(empty === null, 'Dequeue from empty returns null');
}

// ── Test 2: Priority ordering ──────────────────────────────────────────────
console.log('\n═══ Test 2: Priority ordering ═══');
{
  const bq = new BridgeQueue();

  bq.enqueue('mgr-1', { type: 'task_completed', source: 'a', payload: { order: 1 }, priority: 'low' });
  bq.enqueue('mgr-1', { type: 'health_alert', source: 'b', payload: { order: 2 }, priority: 'critical' });
  bq.enqueue('mgr-1', { type: 'user_request', source: 'c', payload: { order: 3 }, priority: 'normal' });

  const first = bq.dequeue('mgr-1');
  assert(first.priority === 'critical', 'Critical comes first');
  assert(first.payload.order === 2, 'Critical item is order 2');

  const second = bq.dequeue('mgr-1');
  assert(second.priority === 'normal', 'Normal comes second');

  const third = bq.dequeue('mgr-1');
  assert(third.priority === 'low', 'Low comes third');
}

// ── Test 3: FIFO within same priority ──────────────────────────────────────
console.log('\n═══ Test 3: FIFO within same priority ═══');
{
  const bq = new BridgeQueue();

  bq.enqueue('mgr-1', { type: 'task_completed', source: 'a', payload: { seq: 1 }, priority: 'normal' });
  bq.enqueue('mgr-1', { type: 'task_completed', source: 'b', payload: { seq: 2 }, priority: 'normal' });
  bq.enqueue('mgr-1', { type: 'task_completed', source: 'c', payload: { seq: 3 }, priority: 'normal' });

  assert(bq.dequeue('mgr-1').payload.seq === 1, 'First in, first out (seq 1)');
  assert(bq.dequeue('mgr-1').payload.seq === 2, 'Second (seq 2)');
  assert(bq.dequeue('mgr-1').payload.seq === 3, 'Third (seq 3)');
}

// ── Test 4: Manager busy/idle tracking ─────────────────────────────────────
console.log('\n═══ Test 4: Manager busy/idle tracking ═══');
{
  const bq = new BridgeQueue();

  assert(bq.isManagerBusy('mgr-1') === false, 'Manager starts idle');

  bq.setManagerBusy('mgr-1', true);
  assert(bq.isManagerBusy('mgr-1') === true, 'Manager marked busy');

  bq.setManagerBusy('mgr-1', false);
  assert(bq.isManagerBusy('mgr-1') === false, 'Manager marked idle');
}

// ── Test 5: Event emissions ────────────────────────────────────────────────
console.log('\n═══ Test 5: Event emissions ═══');
{
  const bq = new BridgeQueue();
  let newItemFired = false;
  let idleFired = false;
  let idleManagerId = '';

  bq.on('newItem', (managerId) => {
    newItemFired = true;
  });

  bq.on('managerIdle', (managerId) => {
    idleFired = true;
    idleManagerId = managerId;
  });

  bq.enqueue('mgr-1', { type: 'task_completed', source: 'test', payload: {}, priority: 'normal' });
  assert(newItemFired, 'newItem event fires on enqueue');

  bq.setManagerBusy('mgr-1', true);
  bq.setManagerBusy('mgr-1', false);
  assert(idleFired, 'managerIdle event fires when set to idle');
  assert(idleManagerId === 'mgr-1', 'managerIdle has correct managerId');
}

// ── Test 6: Multi-manager isolation ────────────────────────────────────────
console.log('\n═══ Test 6: Multi-manager isolation ═══');
{
  const bq = new BridgeQueue();

  bq.enqueue('mgr-A', { type: 'task_completed', source: 'a', payload: { mgr: 'A' }, priority: 'normal' });
  bq.enqueue('mgr-B', { type: 'user_request', source: 'b', payload: { mgr: 'B' }, priority: 'normal' });
  bq.enqueue('mgr-A', { type: 'health_alert', source: 'c', payload: { mgr: 'A2' }, priority: 'normal' });

  assert(bq.length('mgr-A') === 2, 'Manager A has 2 items');
  assert(bq.length('mgr-B') === 1, 'Manager B has 1 item');

  const aItem = bq.dequeue('mgr-A');
  assert(aItem.payload.mgr === 'A', 'Manager A gets its own items');
  assert(bq.length('mgr-A') === 1, 'Manager A has 1 left');
  assert(bq.length('mgr-B') === 1, 'Manager B unaffected');
}

// ── Test 7: Empty queue and peek ───────────────────────────────────────────
console.log('\n═══ Test 7: Empty queue and peek ═══');
{
  const bq = new BridgeQueue();

  assert(bq.isEmpty('nonexistent') === true, 'Unknown manager queue is empty');
  assert(bq.dequeue('nonexistent') === null, 'Dequeue from unknown returns null');
  assert(bq.peek('nonexistent') === null, 'Peek from unknown returns null');

  bq.enqueue('mgr-1', { type: 'task_completed', source: 'test', payload: { x: 1 }, priority: 'normal' });

  const peeked = bq.peek('mgr-1');
  assert(peeked !== null, 'Peek returns item');
  assert(bq.length('mgr-1') === 1, 'Peek does not remove item');
}

// ── Test 8: Queue status reporting ─────────────────────────────────────────
console.log('\n═══ Test 8: Queue status reporting ═══');
{
  const bq = new BridgeQueue();

  bq.enqueue('mgr-1', { type: 'task_completed', source: 'test', payload: {}, priority: 'normal' });
  bq.enqueue('mgr-1', { type: 'user_request', source: 'test', payload: {}, priority: 'critical' });
  bq.setManagerBusy('mgr-1', true);

  const status = bq.getQueueStatus('mgr-1');
  assert(status.length === 2, 'Status reports correct length');
  assert(status.busy === true, 'Status reports busy');
  assert(status.items.length === 2, 'Status includes all items');

  const allStatuses = bq.getAllStatuses();
  assert(allStatuses['mgr-1'] !== undefined, 'getAllStatuses includes manager');
  assert(allStatuses['mgr-1'].length === 2, 'getAllStatuses has correct length');
  assert(allStatuses['mgr-1'].busy === true, 'getAllStatuses has correct busy');
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('ALL TESTS PASSED ✓');
}
