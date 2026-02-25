#!/usr/bin/env node

/**
 * TUI Test Driver — Programmatic control of the Pando TUI via node-pty.
 *
 * Spawns a real PTY running the TUI, handles onboarding automatically,
 * then executes test steps (send commands, wait for output, capture results).
 *
 * Usage:
 *   node tests/tui-driver.mjs                          # Run all test scenarios
 *   node tests/tui-driver.mjs --scenario contribute    # Run specific scenario
 *   node tests/tui-driver.mjs --scenario resources
 *   node tests/tui-driver.mjs --scenario help
 *   node tests/tui-driver.mjs --interactive            # Manual: type commands, see output
 *
 * Options:
 *   --api-port <n>     API port for test node (default: 4200)
 *   --port <n>         P2P port (default: 0 = random)
 *   --data-dir <path>  Data directory (default: ~/.pando-test)
 *   --no-bootstrap     Don't connect to network (isolated test)
 *   --timeout <ms>     Default wait timeout (default: 30000)
 *   --verbose          Print all PTY output in real-time
 *
 * Architecture (borrowed from ORC):
 *   - node-pty spawns a real pseudo-terminal
 *   - ptyProcess.write() sends keystrokes
 *   - ptyProcess.onData() captures output
 *   - RingBuffer stores scrollback for pattern matching
 *   - ANSI codes stripped for assertions, kept for display
 */

import * as pty from 'node-pty';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';

// ── ANSI Stripping ──

function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
            .replace(/\x1b\][^\x07]*\x07/g, '')     // OSC sequences
            .replace(/\x1b\[[\?]?[0-9;]*[hlJK]/g, '') // mode sets, clears
            .replace(/[\x00-\x09\x0b-\x0c\x0e-\x1f]/g, ''); // control chars (keep \n \r)
}

// ── Ring Buffer (from ORC pattern) ──

class RingBuffer {
  constructor(maxBytes = 256 * 1024) {
    this.maxBytes = maxBytes;
    this.buffer = '';
  }

  append(data) {
    this.buffer += data;
    if (this.buffer.length > this.maxBytes) {
      this.buffer = this.buffer.slice(-this.maxBytes);
    }
  }

  /** Get all content, ANSI stripped */
  getText() {
    return stripAnsi(this.buffer);
  }

  /** Get raw content with ANSI codes */
  getRaw() {
    return this.buffer;
  }

  /** Get last N lines, ANSI stripped */
  getLastLines(n = 50) {
    const text = this.getText();
    const lines = text.split('\n');
    return lines.slice(-n).join('\n');
  }

  /** Check if pattern exists anywhere in buffer (stripped) */
  contains(pattern) {
    if (typeof pattern === 'string') {
      return this.getText().includes(pattern);
    }
    return pattern.test(this.getText());
  }

  /** Clear buffer */
  clear() {
    this.buffer = '';
  }
}

// ── TUI Driver ──

class TuiDriver {
  constructor(options = {}) {
    this.apiPort = options.apiPort || 4200;
    this.p2pPort = options.port || 0;
    this.dataDir = options.dataDir || join(homedir(), '.pando-test');
    this.noBootstrap = options.noBootstrap || false;
    this.timeout = options.timeout || 30000;
    this.verbose = options.verbose || false;
    this.projectRoot = options.projectRoot || resolve(join(import.meta.url.replace('file:///', ''), '..', '..'));

    this.ringBuffer = new RingBuffer();
    this.ptyProcess = null;
    this.exited = false;
    this.exitCode = null;
  }

  /** Spawn the TUI in a real PTY */
  async start() {
    // Ensure data dir exists
    mkdirSync(this.dataDir, { recursive: true });

    // Build args
    const args = [
      join(this.projectRoot, 'packages', 'node', 'dist', 'tui.js'),
      '--api-port', String(this.apiPort),
      '--no-scheduler',
    ];
    if (this.p2pPort) {
      args.push('--port', String(this.p2pPort));
    }
    args.push('--data-dir', this.dataDir);
    if (this.noBootstrap) {
      args.push('--no-bootstrap');
    }

    const shell = process.platform === 'win32'
      ? 'node.exe'
      : 'node';

    if (this.verbose) {
      console.log(`[driver] Spawning: ${shell} ${args.join(' ')}`);
      console.log(`[driver] Data dir: ${this.dataDir}`);
      console.log(`[driver] API port: ${this.apiPort}`);
    }

    this.ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: this.projectRoot,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
      },
    });

    this.ptyProcess.onData((data) => {
      this.ringBuffer.append(data);
      if (this.verbose) {
        process.stdout.write(data);
      }
    });

    this.ptyProcess.onExit(({ exitCode }) => {
      this.exited = true;
      this.exitCode = exitCode;
      if (this.verbose) {
        console.log(`\n[driver] PTY exited with code ${exitCode}`);
      }
    });
  }

  /** Write raw data to PTY stdin */
  write(data) {
    if (this.exited) throw new Error('PTY has exited');
    this.ptyProcess.write(data);
  }

  /** Send a line (text + Enter) */
  sendLine(text) {
    this.write(text + '\r');
  }

  /** Send arrow key */
  sendArrowUp() { this.write('\x1b[A'); }
  sendArrowDown() { this.write('\x1b[B'); }
  sendArrowLeft() { this.write('\x1b[D'); }
  sendArrowRight() { this.write('\x1b[C'); }

  /** Send Enter */
  sendEnter() { this.write('\r'); }

  /** Send Ctrl+C */
  sendCtrlC() { this.write('\x03'); }

  /**
   * Wait for a pattern to appear in the output buffer.
   * @param {string|RegExp} pattern - Text or regex to match
   * @param {number} timeoutMs - Max wait time
   * @returns {Promise<string>} - The matched text
   */
  async waitFor(pattern, timeoutMs) {
    const timeout = timeoutMs || this.timeout;
    const startTime = Date.now();
    const pollInterval = 200;

    while (Date.now() - startTime < timeout) {
      if (this.exited) {
        throw new Error(`PTY exited (code ${this.exitCode}) while waiting for: ${pattern}`);
      }
      if (this.ringBuffer.contains(pattern)) {
        return this.ringBuffer.getText();
      }
      await sleep(pollInterval);
    }

    // Timeout — dump last output for debugging
    const lastOutput = this.ringBuffer.getLastLines(30);
    throw new Error(
      `Timeout (${timeout}ms) waiting for: ${pattern}\n` +
      `--- Last output ---\n${lastOutput}\n--- End ---`
    );
  }

  /**
   * Wait for pattern, then clear buffer so subsequent waits
   * only match NEW output.
   */
  async waitForThenClear(pattern, timeoutMs) {
    const result = await this.waitFor(pattern, timeoutMs);
    this.ringBuffer.clear();
    return result;
  }

  /** Get the current buffer content (ANSI stripped) */
  getOutput(lastN = 50) {
    return this.ringBuffer.getLastLines(lastN);
  }

  /** Get full raw output */
  getRawOutput() {
    return this.ringBuffer.getRaw();
  }

  /** Gracefully quit the TUI */
  async quit() {
    if (this.exited) return;
    this.sendLine('/quit');
    try {
      await this.waitFor('Shutting down', 10000);
    } catch {
      // Force kill if quit doesn't work
    }
    await sleep(2000);
    if (!this.exited) {
      this.ptyProcess.kill();
    }
  }

  /** Kill immediately */
  kill() {
    if (!this.exited && this.ptyProcess) {
      this.ptyProcess.kill();
    }
  }
}

// ── Helpers ──

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Pre-create a test identity so onboarding is skipped.
 * Creates an unencrypted identity + session.json in the test data dir.
 */
async function ensureTestIdentity(dataDir) {
  const sessionPath = join(dataDir, 'session.json');
  if (existsSync(sessionPath)) {
    const session = JSON.parse(readFileSync(sessionPath, 'utf-8'));
    console.log(`[driver] Reusing test identity: ${session.peerId.slice(0, 16)}...`);
    return session;
  }

  // Generate a fresh identity using shared crypto
  console.log('[driver] Creating test identity...');

  // We can't easily import the TS modules, so we'll let the TUI create one
  // on first run and handle the onboarding flow automatically
  return null;
}

// ── Onboarding Automation ──

/**
 * Handle the TUI onboarding flow automatically.
 * Phase 55+: TUI has zero-prompt startup. Identity is auto-created or auto-loaded.
 * The only possible interactive prompt is a password for an already-encrypted identity.
 */
async function handleOnboarding(driver) {
  console.log('[driver] Handling onboarding...');
  const output = driver.ringBuffer.getText();

  if (output.includes('Enter password')) {
    // Encrypted identity — can't auto-handle
    throw new Error('Test identity is encrypted. Use --data-dir with an unencrypted identity or wipe the test data dir.');
  }

  if (output.includes('Creating node identity')) {
    console.log('[driver] First run — identity auto-created (zero prompts)');
    return;
  }

  if (output.includes('Loading identity')) {
    console.log('[driver] Existing identity auto-loaded (zero prompts)');
    return;
  }

  if (output.includes('Node ready')) {
    console.log('[driver] Node already ready');
    return;
  }

  // Fallback: wait a bit more for any of the expected patterns
  try {
    await driver.waitFor(/Loading identity|Creating node identity|Node ready/, 15000);
    console.log('[driver] Startup detected');
  } catch (err) {
    console.log('[driver] WARNING: Could not detect startup state');
    console.log('[driver] Last output:', driver.getOutput(15));
    throw new Error('Onboarding automation failed: ' + err.message);
  }
}

// ── Test Scenarios ──

async function testHelp(driver) {
  console.log('\n=== Test: /help ===');
  driver.ringBuffer.clear();
  driver.sendLine('/help');
  await driver.waitFor('/contribute', 5000);
  const output = driver.getOutput(80);

  const checks = [
    ['/status',     output.includes('/status')],
    ['/peers',      output.includes('/peers')],
    ['/balance',    output.includes('/balance')],
    ['/login',      output.includes('/login')],
    ['/contribute', output.includes('/contribute')],
    ['/resources',  output.includes('/resources')],
    ['/quit',       output.includes('/quit')],
    ['<service> <key> syntax', output.includes('<service>') && output.includes('<key>')],
  ];

  let passed = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${name}`);
    if (ok) passed++;
  }
  console.log(`  Result: ${passed}/${checks.length} passed`);
  return passed === checks.length;
}

async function testContribute(driver) {
  console.log('\n=== Test: /contribute ===');

  // Test 1: Unknown service → error
  driver.ringBuffer.clear();
  driver.sendLine('/contribute blahblah sk-fake123');
  await sleep(2000);
  let output = driver.getOutput(10);
  const unknownError = output.includes('Unknown service');
  console.log(`  ${unknownError ? 'PASS' : 'FAIL'}: Unknown service shows error`);

  // Test 2: Missing args → usage
  driver.ringBuffer.clear();
  driver.sendLine('/contribute');
  await sleep(2000);
  output = driver.getOutput(10);
  const usageShown = output.includes('Usage:') || output.includes('Services:');
  console.log(`  ${usageShown ? 'PASS' : 'FAIL'}: Missing args shows usage`);

  // Test 3: Valid contribute
  driver.ringBuffer.clear();
  driver.sendLine('/contribute openai sk-test-tuidriver-001');
  await sleep(3000);
  output = driver.getOutput(15);
  const contributed = output.includes('Resource contributed') || output.includes('contributed successfully');
  const showsService = output.includes('OpenAI');
  const showsType = output.includes('ai_api_key');
  console.log(`  ${contributed ? 'PASS' : 'FAIL'}: Contribute success message`);
  console.log(`  ${showsService ? 'PASS' : 'FAIL'}: Shows service name "OpenAI"`);
  console.log(`  ${showsType ? 'PASS' : 'FAIL'}: Shows type "ai_api_key"`);

  const passed = [unknownError, usageShown, contributed, showsService, showsType].filter(Boolean).length;
  console.log(`  Result: ${passed}/5 passed`);
  return passed === 5;
}

async function testResources(driver) {
  console.log('\n=== Test: /resources ===');
  driver.ringBuffer.clear();
  driver.sendLine('/resources');
  await sleep(3000);
  const output = driver.getOutput(30);

  const hasYourResources = output.includes('Your Resources');
  const hasNetworkResources = output.includes('Network Resources');
  // After contributing an OpenAI key, it should show "OpenAI" in the list
  const showsServiceName = output.includes('OpenAI');
  const hasTip = output.includes('/contribute') && output.includes('/revoke');

  console.log(`  ${hasYourResources ? 'PASS' : 'FAIL'}: Shows "Your Resources" section`);
  console.log(`  ${hasNetworkResources ? 'PASS' : 'FAIL'}: Shows "Network Resources" section`);
  console.log(`  ${showsServiceName ? 'PASS' : 'FAIL'}: Shows service name "OpenAI"`);
  console.log(`  ${hasTip ? 'PASS' : 'FAIL'}: Shows tip with /contribute and /revoke`);

  const passed = [hasYourResources, hasNetworkResources, showsServiceName, hasTip].filter(Boolean).length;
  console.log(`  Result: ${passed}/4 passed`);
  return passed === 4;
}

async function testStatus(driver) {
  console.log('\n=== Test: /status ===');
  driver.ringBuffer.clear();
  driver.sendLine('/status');
  await sleep(3000);
  const output = driver.getOutput(20);

  const hasPeerId = output.includes('12D3KooW') || output.includes('Peer ID');
  const hasBalance = output.includes('Lux') || output.includes('balance');
  const hasUptime = output.includes('uptime') || output.includes('Uptime');
  const hasOperator = output.includes('Operator');

  console.log(`  ${hasPeerId ? 'PASS' : 'FAIL'}: Shows peer ID`);
  console.log(`  ${hasBalance ? 'PASS' : 'FAIL'}: Shows balance`);
  console.log(`  ${hasUptime ? 'PASS' : 'FAIL'}: Shows uptime`);
  console.log(`  ${hasOperator ? 'PASS' : 'FAIL'}: Shows operator status`);

  const passed = [hasPeerId, hasBalance, hasUptime, hasOperator].filter(Boolean).length;
  console.log(`  Result: ${passed}/4 passed`);
  return passed === 4;
}

// ── Main ──

async function main() {
  const args = process.argv.slice(2);

  // Parse args
  const getFlag = (name) => {
    const idx = args.indexOf(name);
    return idx !== -1 ? args[idx + 1] : undefined;
  };
  const hasFlag = (name) => args.includes(name);

  const apiPort = parseInt(getFlag('--api-port') || '4200');
  const p2pPort = parseInt(getFlag('--port') || '0');
  const dataDir = getFlag('--data-dir') || join(homedir(), '.pando-test');
  const noBootstrap = hasFlag('--no-bootstrap');
  const timeout = parseInt(getFlag('--timeout') || '30000');
  const verbose = hasFlag('--verbose');
  const scenario = getFlag('--scenario');
  const interactive = hasFlag('--interactive');

  // Resolve project root (2 levels up from tests/)
  const projectRoot = resolve(join(import.meta.dirname, '..'));

  console.log('╔════════════════════════════════════════╗');
  console.log('║     Pando TUI Test Driver v1.0         ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`  API port:   ${apiPort}`);
  console.log(`  Data dir:   ${dataDir}`);
  console.log(`  Bootstrap:  ${noBootstrap ? 'disabled' : 'default (Lightsail)'}`);
  console.log(`  Scenario:   ${scenario || (interactive ? 'interactive' : 'all')}`);
  console.log('');

  // Pre-check: does the TUI binary exist?
  const tuiPath = join(projectRoot, 'packages', 'node', 'dist', 'tui.js');
  if (!existsSync(tuiPath)) {
    console.error(`ERROR: TUI not built. Run "npm run build" first.`);
    console.error(`Expected: ${tuiPath}`);
    process.exit(1);
  }

  const driver = new TuiDriver({
    apiPort,
    port: p2pPort,
    dataDir,
    noBootstrap,
    timeout,
    verbose,
    projectRoot,
  });

  // Start PTY
  await driver.start();

  // Handle onboarding automatically
  try {
    // Wait for something to appear
    await driver.waitFor(/Loading identity|Creating node identity|Node ready|Enter password/, 20000);
    await handleOnboarding(driver);
  } catch (err) {
    console.error(`[driver] Onboarding failed: ${err.message}`);
    driver.kill();
    process.exit(1);
  }

  // Wait for node to be ready
  try {
    await driver.waitFor('Node ready', 60000);
    console.log('[driver] Node is ready!\n');
  } catch (err) {
    console.error(`[driver] Node failed to start: ${err.message}`);
    driver.kill();
    process.exit(1);
  }

  // Give the prompt a moment to render
  await sleep(1000);

  if (interactive) {
    // Interactive mode: pipe stdin to PTY, PTY output to stdout
    console.log('[driver] Interactive mode — type commands below. Ctrl+C to exit.\n');
    driver.verbose = true; // Show all output

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (data) => {
      driver.write(data.toString());
    });

    driver.ptyProcess.onExit(() => {
      process.exit(0);
    });
    return; // Don't exit — wait for user
  }

  // Run scenarios
  const results = {};

  const scenarios = {
    help: testHelp,
    contribute: testContribute,
    resources: testResources,
    status: testStatus,
  };

  const toRun = scenario ? [scenario] : Object.keys(scenarios);

  for (const name of toRun) {
    if (!scenarios[name]) {
      console.error(`Unknown scenario: ${name}`);
      console.error(`Available: ${Object.keys(scenarios).join(', ')}`);
      await driver.quit();
      process.exit(1);
    }
    try {
      results[name] = await scenarios[name](driver);
    } catch (err) {
      console.error(`  ERROR in ${name}: ${err.message}`);
      results[name] = false;
    }
  }

  // Cleanup: revoke the test resource we created
  if (toRun.includes('contribute')) {
    driver.ringBuffer.clear();
    // List resources to find the ID
    driver.sendLine('/resources');
    await sleep(2000);
    const output = driver.getOutput(30);
    // Look for resource IDs in the output (format: [<id>])
    const idMatch = output.match(/\[([a-f0-9-]{36})\]/);
    if (idMatch) {
      driver.sendLine(`/revoke ${idMatch[1]}`);
      await sleep(2000);
      console.log(`\n[driver] Cleaned up test resource: ${idMatch[1]}`);
    }
  }

  // Summary
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║           Test Results                 ║');
  console.log('╠════════════════════════════════════════╣');
  let allPassed = true;
  for (const [name, passed] of Object.entries(results)) {
    const icon = passed ? 'PASS' : 'FAIL';
    console.log(`║  ${icon}  ${name.padEnd(32)} ║`);
    if (!passed) allPassed = false;
  }
  console.log('╚════════════════════════════════════════╝');

  // Quit TUI
  await driver.quit();
  await sleep(1000);

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
