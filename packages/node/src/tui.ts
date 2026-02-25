#!/usr/bin/env node

/**
 * Pando Interactive Terminal
 *
 * Like Claude Code, but for the Pando network.
 * Run `pando` to start an interactive node.
 *
 * Commands:
 *   /status              Node status
 *   /peers               List connected peers
 *   /network             Network topology & balances
 *   /balance [peerId]    Check Lux balance
 *   /wallet              Wallet / ownership info
 *   /transfer <to> <amt> Send Lux to a peer (/send also works)
 *   /search <query>      AI search (or just type without /)
 *   /help                Show commands
 *   /quit                Graceful shutdown
 */

import './polyfills.js';
import * as readline from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PandoNode, detectClaudeCode } from './index.js';
import { parsePort } from './config.js';
import { FileLogger } from './logger.js';
import {
  generateIdentity,
  isEncryptedIdentity, decryptIdentity,
  saveSession, loadSession, clearSession,
  listIdentities, loadIdentityFile,
  saveIdentityToDir, saveIdentity,
} from '@pando/shared';
import type { NodeConfig, NodeIdentity, EncryptedSerializedIdentity } from '@pando/shared';
import { signTransaction } from '@pando/shared';

// ── ANSI helpers ──

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
  bgGreen: '\x1b[42m',
  bgBlue: '\x1b[44m',
  inverse: '\x1b[7m',
};

function colorize(text: string): string {
  // Lux amounts green
  text = text.replace(/(\+[\d.]+\s+Lux)/g, `${c.green}$1${c.reset}`);
  text = text.replace(/([\d.]+\s+Lux)/g, `${c.green}$1${c.reset}`);
  // Peer IDs cyan (truncated or full)
  text = text.replace(/(12D3KooW\S{4,})/g, `${c.cyan}$1${c.reset}`);
  // Sync messages blue
  if (text.includes('[sync]')) return `${c.blue}${text}${c.reset}`;
  // Status messages dim
  if (text.includes('[status]')) return `${c.dim}${text}${c.reset}`;
  return text;
}

function stripAnsiLength(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, '').length;
}

// ── Spinner helper ──

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface Spinner {
  stop: (finalMessage?: string) => void;
}

function createSpinner(label: string, writeAbove: (text: string) => void): Spinner {
  let frame = 0;
  const start = Date.now();
  let stopped = false;
  let lastLine = '';

  const render = () => {
    if (stopped) return;
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const ch = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    const line = `\r\x1b[2K  ${c.cyan}${ch}${c.reset} ${c.dim}${label}${c.reset} ${c.dim}(${elapsed}s)${c.reset}`;
    process.stdout.write(line);
    lastLine = line;
    frame++;
  };

  const interval = setInterval(render, 80);
  render();

  return {
    stop(finalMessage?: string) {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      // Clear spinner line
      process.stdout.write('\r\x1b[2K');
      if (finalMessage) {
        writeAbove(finalMessage);
      }
    },
  };
}

// ── Command definitions ──

interface CommandDef {
  name: string;
  alias?: string;
  args?: string;
  desc: string;
}

const COMMANDS: CommandDef[] = [
  { name: '/status',   alias: 's', desc: 'Node status' },
  { name: '/peers',    alias: 'p', desc: 'Connected peers' },
  { name: '/network',  alias: 'n', desc: 'Network topology & balances' },
  { name: '/balance',  alias: 'b', args: '[peerId]', desc: 'Check Lux balance' },
  { name: '/wallet',   alias: 'w', desc: 'Wallet & ownership info' },
  { name: '/transfer', alias: 't', args: '<peerId> <amount>', desc: 'Send Lux to a peer' },
  { name: '/send',     args: '<peerId> <amount>', desc: 'Send Lux (alias for /transfer)' },
  { name: '/connect',  alias: 'c', args: '<multiaddr>', desc: 'Connect to a peer' },
  { name: '/search',   args: '<query>', desc: 'AI search' },
  { name: '/proposals', desc: 'List governance proposals' },
  { name: '/propose',  args: '<title>', desc: 'Create a governance proposal' },
  { name: '/vote',     args: '<id> <approve|reject>', desc: 'Vote on a proposal' },
  { name: '/scheduler', desc: 'Show Scheduler status' },
  { name: '/submit',   args: '<description>', desc: 'Submit task to Scheduler' },
  { name: '/tasks',    desc: 'Show task queue' },
  { name: '/agents',   alias: 'a', desc: 'Show agent tree' },
  { name: '/chat',     args: '<message>', desc: 'Chat with the node manager' },
  { name: '/agent',    alias: 'tell', args: '<id> <message>', desc: 'Send message to an agent' },
  { name: '/monitor',  alias: 'm', desc: 'Health monitor status' },
  { name: '/upgrade',  alias: 'u', desc: 'Upgrade commands (propose, status, history, pull)' },
  { name: '/invite',   alias: 'i', desc: 'Share bootstrap command for new peers' },
  { name: '/resources', alias: 'r', desc: 'List your resources and network resources' },
  { name: '/contribute', args: '<service> [key]', desc: 'Contribute a resource (openai, anthropic, gemini, mongodb, aws, github, ec2, lambda, claude-code)' },
  { name: '/revoke',   args: '<id>', desc: 'Revoke a resource' },
  { name: '/register', args: '<user> <pass>', desc: 'Create account & link to this node' },
  { name: '/login',    args: '<user> <pass>', desc: 'Link your account to this node' },
  { name: '/logout',   desc: 'Clear identity session & unlink account' },
  { name: '/index',    args: '<directory>', desc: 'Add a directory to the local file index' },
  { name: '/unindex',  args: '<directory>', desc: 'Remove a directory from the local file index' },
  { name: '/local',    desc: 'Show indexed directories & file stats (Envelope 1)' },
  { name: '/memory',   args: '[forget <key>]', desc: 'Show user memory (or forget an entry)' },
  { name: '/help',     alias: 'h', desc: 'Show commands' },
  { name: '/quit',     alias: 'q', desc: 'Shutdown' },
];

// ── TUI Class ──

class PandoTUI {
  private node: PandoNode;
  private rl!: readline.Interface;
  private started = false;
  private shuttingDown = false;
  private originalLog: typeof console.log;
  private originalError: typeof console.error;
  private fileLogger!: FileLogger;

  // ── Autocomplete state ──
  private suggestions: CommandDef[] = [];
  private selectedIndex = 0;
  private suggestionsVisible = false;
  private renderedSuggestionLines = 0;

  // ── Custom command history ──
  private inputHistory: string[] = [];
  private historyPos = 0;
  private savedInput = ''; // saved partial input when navigating history

  constructor(config?: Partial<NodeConfig>) {
    this.originalLog = console.log.bind(console);
    this.originalError = console.error.bind(console);
    this.node = new PandoNode(config);
    this.fileLogger = new FileLogger(config?.dataDir);
  }

  async start(autoScheduler = false): Promise<void> {
    this.printBanner();

    // Set up readline with history disabled (we manage our own)
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `${c.green}pando${c.reset} ${c.dim}>${c.reset} `,
      terminal: true,
      historySize: 0,
      completer: () => [[], ''], // We handle Tab ourselves
    });

    // Handle onboarding before starting the node
    const identity = await this.onboard();

    // Intercept console so node logs appear cleanly above the prompt
    this.interceptConsole();

    // Start the node with the resolved identity
    await this.node.startWithIdentity(identity);
    this.started = true;

    // Phase 34: Set restart handler — TUI intercepts restarts so terminal stays open
    this.node.setRestartHandler((reason, changedFiles) => {
      this.handleRestart(reason, changedFiles);
    });

    // Phase 34: Wire P2P upgrade notifications
    this.node.onUpgradeAvailable((info) => {
      this.log('');
      this.log(`${c.yellow}${c.bold}Upgrade available${c.reset} from peer ${c.cyan}${info.peerId.slice(0, 12)}...${c.reset} (${info.version})`);
      this.log(`${c.dim}Run ${c.cyan}/upgrade${c.dim} to pull and restart.${c.reset}`);
      this.log('');
    });

    // Enable Phase 16 pipeline if --pipeline flag was passed
    const args = process.argv.slice(2);
    if (args.includes('--pipeline')) {
      this.log(`${c.dim}Enabling code pipeline (--pipeline flag)...${c.reset}`);
      this.node.enablePipeline();
    }

    // Auto-start scheduler if --scheduler flag was passed or Claude Code was auto-detected
    if (autoScheduler) {
      if (args.includes('--scheduler')) {
        this.log(`${c.dim}Auto-starting scheduler (--scheduler flag)...${c.reset}`);
      } else {
        this.log(`${c.dim}[scheduler] Auto-detected Claude Code — scheduler enabled. Use --no-scheduler to disable.${c.reset}`);
      }
      this.node.startScheduler();
    }

    // Auto-start health monitor if --scheduler or --monitor flag was passed
    if (autoScheduler || args.includes('--monitor')) {
      this.log(`${c.dim}Auto-starting health monitor...${c.reset}`);
      this.node.startMonitor();
    }

    // Set up keypress-driven autocomplete
    this.setupAutocomplete();

    // Phase 48: Startup identity message
    const shortId = identity.peerId.slice(8, 16); // first 8 chars after "12D3KooW"
    this.originalLog('');
    this.originalLog(`${c.green}${c.bold}Node #${shortId} running${c.reset} on port ${this.node.getApiPort()}`);

    this.originalLog('');
    this.originalLog(`${c.green}${c.bold}Node ready.${c.reset} Type ${c.cyan}/${c.reset} to see commands, or just type to search.`);
    this.originalLog('');

    this.attachRlListeners();
    this.rl.prompt();

    // Graceful shutdown
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  /**
   * Attach line/close listeners to the current readline instance.
   * Called from start() and after doLogout() recreates readline.
   */
  private attachRlListeners(): void {
    this.rl.on('line', async (input: string) => {
      const trimmed = input.trim();
      if (trimmed) {
        this.inputHistory.push(trimmed);
        this.historyPos = this.inputHistory.length;
        this.savedInput = '';
        await this.handleInput(trimmed);
      }
      if (!this.shuttingDown) {
        this.rl.prompt();
      }
    });

    this.rl.on('close', () => {
      if (!this.shuttingDown) {
        this.shutdown();
      }
    });
  }

  // ── Autocomplete ──

  private setupAutocomplete(): void {
    // Clear suggestions synchronously before readline processes Enter
    process.stdin.prependListener('keypress', (_str: string | undefined, key: readline.Key) => {
      if (!key || !this.started || this.shuttingDown) return;

      if (key.name === 'return' && this.suggestionsVisible) {
        this.clearSuggestionBox();
      }
    });

    // Main keypress handler — runs after readline has processed the key
    process.stdin.on('keypress', (_str: string | undefined, key: readline.Key) => {
      if (!key || !this.started || this.shuttingDown) return;

      const keyName = key.name;

      // Use setImmediate so readline has finished processing this key
      setImmediate(() => {
        const line = (this.rl as any).line as string || '';

        // ── Arrow keys when suggestions visible: navigate ──
        if (this.suggestionsVisible && this.suggestions.length > 0) {
          if (keyName === 'up') {
            this.selectedIndex = (this.selectedIndex - 1 + this.suggestions.length) % this.suggestions.length;
            this.replaceLine(this.suggestions[this.selectedIndex].name);
            this.renderSuggestionBox();
            return;
          }
          if (keyName === 'down') {
            this.selectedIndex = (this.selectedIndex + 1) % this.suggestions.length;
            this.replaceLine(this.suggestions[this.selectedIndex].name);
            this.renderSuggestionBox();
            return;
          }
          if (keyName === 'tab') {
            const selected = this.suggestions[this.selectedIndex];
            const suffix = selected.args ? ' ' : '';
            this.replaceLine(selected.name + suffix);
            this.clearSuggestionBox();
            return;
          }
          if (keyName === 'escape') {
            this.clearSuggestionBox();
            return;
          }
        }

        // ── Arrow keys when NO suggestions: command history ──
        if (!this.suggestionsVisible) {
          if (keyName === 'up' && this.inputHistory.length > 0) {
            if (this.historyPos === this.inputHistory.length) {
              this.savedInput = line;
            }
            this.historyPos = Math.max(0, this.historyPos - 1);
            this.replaceLine(this.inputHistory[this.historyPos]);
            return;
          }
          if (keyName === 'down') {
            this.historyPos = Math.min(this.inputHistory.length, this.historyPos + 1);
            if (this.historyPos === this.inputHistory.length) {
              this.replaceLine(this.savedInput);
            } else {
              this.replaceLine(this.inputHistory[this.historyPos]);
            }
            return;
          }
        }

        // ── Update suggestion list based on current input ──
        if (line.startsWith('/') && !line.includes(' ')) {
          const query = line.slice(1).toLowerCase();
          const matches = COMMANDS.filter(cmd => {
            const name = cmd.name.slice(1);
            return name.startsWith(query) || (cmd.alias && cmd.alias.startsWith(query));
          });

          if (matches.length > 0 && matches.length < COMMANDS.length) {
            // Only show suggestions when filtering (not bare /)
            this.suggestions = matches.slice(0, 6);
            this.selectedIndex = Math.min(this.selectedIndex, this.suggestions.length - 1);
            this.renderSuggestionBox();
          } else if (matches.length === COMMANDS.length && query === '') {
            // Bare "/" — show all but capped
            this.suggestions = matches.slice(0, 6);
            this.selectedIndex = 0;
            this.renderSuggestionBox();
          } else {
            if (this.suggestionsVisible) this.clearSuggestionBox();
          }
        } else {
          if (this.suggestionsVisible) this.clearSuggestionBox();
        }
      });
    });
  }

  /**
   * Replace the readline input with new text.
   */
  private replaceLine(text: string): void {
    (this.rl as any).line = text;
    (this.rl as any).cursor = text.length;
    process.stdout.write(`\r\x1b[2K`);
    process.stdout.write(this.rl.getPrompt() + text);
  }

  /**
   * Position cursor on the prompt line at the end of input.
   */
  private cursorToPromptEnd(): void {
    const line = (this.rl as any).line as string || '';
    const col = stripAnsiLength(this.rl.getPrompt()) + line.length + 1;
    process.stdout.write(`\x1b[${col}G`);
  }

  /**
   * Render the suggestion dropdown below the prompt.
   * Uses explicit line counting + relative cursor movement (no save/restore).
   */
  private renderSuggestionBox(): void {
    const count = this.suggestions.length;
    if (count === 0) return;

    // Hide cursor to prevent flicker
    process.stdout.write('\x1b[?25l');

    // Move below the prompt line
    const prevRendered = this.renderedSuggestionLines;
    const totalToClear = Math.max(count, prevRendered);

    process.stdout.write('\n');

    for (let i = 0; i < count; i++) {
      const cmd = this.suggestions[i];
      const isSelected = i === this.selectedIndex;
      const marker = isSelected ? `${c.cyan}\u25b8` : ' ';
      const nameStyle = isSelected ? `${c.cyan}${c.bold}` : c.dim;
      const alias = cmd.alias ? ` ${c.dim}/${cmd.alias}` : '';

      process.stdout.write(`\r\x1b[2K  ${marker}${c.reset} ${nameStyle}${cmd.name}${c.reset}${alias}${c.reset}  ${c.dim}${cmd.desc}${c.reset}`);

      if (i < totalToClear - 1) {
        process.stdout.write('\n');
      }
    }

    // Clear any leftover lines from previous render
    for (let i = count; i < totalToClear; i++) {
      process.stdout.write(`\r\x1b[2K`);
      if (i < totalToClear - 1) {
        process.stdout.write('\n');
      }
    }

    // Move cursor back up to the prompt line
    // We moved down 1 (\n after prompt) + totalToClear - 1 (\n between lines) = totalToClear lines below prompt
    process.stdout.write(`\x1b[${totalToClear}A`);

    // Position cursor at end of input on prompt line
    this.cursorToPromptEnd();

    // Show cursor
    process.stdout.write('\x1b[?25h');

    this.renderedSuggestionLines = count;
    this.suggestionsVisible = true;
  }

  /**
   * Clear the suggestion dropdown.
   */
  private clearSuggestionBox(): void {
    if (this.renderedSuggestionLines === 0) {
      this.suggestionsVisible = false;
      this.suggestions = [];
      this.selectedIndex = 0;
      return;
    }

    // Hide cursor
    process.stdout.write('\x1b[?25l');

    // Move down and clear each suggestion line
    const linesToClear = this.renderedSuggestionLines;
    process.stdout.write('\n');
    for (let i = 0; i < linesToClear; i++) {
      process.stdout.write(`\r\x1b[2K`);
      if (i < linesToClear - 1) {
        process.stdout.write('\n');
      }
    }

    // Move back up to prompt line
    process.stdout.write(`\x1b[${linesToClear}A`);

    // Position cursor at end of input
    this.cursorToPromptEnd();

    // Show cursor
    process.stdout.write('\x1b[?25h');

    this.renderedSuggestionLines = 0;
    this.suggestionsVisible = false;
    this.suggestions = [];
    this.selectedIndex = 0;
  }

  private interceptConsole(): void {
    console.log = (...args: any[]) => {
      const msg = args.map(String).join(' ');
      this.fileLogger.log(msg);
      this.writeAbovePrompt(colorize(msg));
    };
    console.error = (...args: any[]) => {
      const msg = args.map(String).join(' ');
      this.fileLogger.error(msg);
      this.writeAbovePrompt(`${c.red}${msg}${c.reset}`);
    };
  }

  // ── Onboarding ──

  /**
   * Onboarding flow:
   * 1. Check session.json — if valid, resume without password
   * 2. List identities — if any, show chooser
   * 3. If none, show create/import menu
   */
  private async onboard(): Promise<NodeIdentity> {
    const dataDir = this.node.getDataDir();

    // 1. Check for active session (already logged in)
    const session = await loadSession(dataDir);
    if (session) {
      this.originalLog(`${c.dim}Loading identity${c.reset} ${c.cyan}${session.peerId}${c.reset}`);
      return session;
    }

    // 2. Scan for existing identities
    const identities = listIdentities(dataDir);

    if (identities.length === 0) {
      // No identities — create one silently
      this.originalLog(`${c.dim}Creating node identity...${c.reset}`);
      const identity = await generateIdentity();
      await saveIdentityToDir(identity, dataDir);
      await saveIdentity(identity, dataDir); // legacy compat
      await saveSession(identity, dataDir);
      this.originalLog(`  ${c.dim}Peer ID:${c.reset} ${c.cyan}${identity.peerId}${c.reset}`);
      return identity;
    }

    // Pick the identity to use: prefer session.json reference (already checked above),
    // then most recent file. No chooser menu.
    const picked = identities[identities.length - 1]; // most recent
    const raw = await loadIdentityFile(picked.filePath);

    if (isEncryptedIdentity(raw)) {
      // Encrypted — password prompt is the only valid prompt
      // loginWithPassword handles saveSession internally
      return this.loginWithPassword(raw);
    }

    // Unencrypted — load silently
    const { fromString } = await import('uint8arrays');
    const identity: NodeIdentity = {
      peerId: raw.peerId,
      publicKey: fromString(raw.publicKey, 'base64'),
      privateKey: fromString(raw.privateKey, 'base64'),
      createdAt: raw.createdAt,
    };

    this.originalLog(`${c.dim}Loading identity${c.reset} ${c.cyan}${identity.peerId}${c.reset}`);
    await saveSession(identity, dataDir);
    return identity;
  }

  /**
   * Login with password — decrypt encrypted identity.
   * Loops until correct password or Ctrl+C.
   */
  private async loginWithPassword(data: EncryptedSerializedIdentity): Promise<NodeIdentity> {
    this.originalLog(`${c.dim}Identity:${c.reset} ${c.cyan}${data.peerId}${c.reset} ${c.dim}(encrypted)${c.reset}`);
    this.originalLog('');

    while (true) {
      try {
        const password = await this.askPassword(`  ${c.green}Password:${c.reset} `);
        if (!password) {
          this.originalLog(`  ${c.red}Password cannot be empty.${c.reset}`);
          continue;
        }

        try {
          const identity = decryptIdentity(data, password);
          this.originalLog(`  ${c.green}${c.bold}Unlocked.${c.reset}`);
          this.originalLog('');
          await saveSession(identity, this.node.getDataDir());
          return identity;
        } catch {
          this.originalLog(`  ${c.red}Wrong password. Try again.${c.reset}`);
        }
      } catch {
        // Ctrl+C during password entry — exit
        this.originalLog(`${c.dim}Cancelled.${c.reset}`);
        process.exit(0);
      }
    }
  }

  /**
   * Ask for a password with masked input (shows * for each character).
   * Handles backspace, Ctrl+C, and Enter.
   *
   * Mutes readline's output to prevent double-echo (M*a*s*) — readline stays
   * alive but can't write to stdout, so only our explicit '*' chars appear.
   */
  private askPassword(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // Mute readline output so it can't echo characters
      const realOutput = (this.rl as any).output;
      const nullWrite = { write: () => true, ...realOutput };
      (this.rl as any).output = nullWrite;
      this.rl.pause();

      process.stdout.write(prompt);

      let password = '';
      process.stdin.setRawMode(true);
      process.stdin.resume();

      const onData = (buf: Buffer) => {
        const ch = buf.toString('utf8');
        for (const char of ch) {
          const code = char.charCodeAt(0);

          if (char === '\r' || char === '\n') {
            process.stdout.write('\n');
            cleanup();
            resolve(password);
            return;
          }
          if (code === 3) {
            // Ctrl+C
            process.stdout.write('\n');
            cleanup();
            reject(new Error('Cancelled'));
            return;
          }
          if (code === 127 || code === 8) {
            // Backspace
            if (password.length > 0) {
              password = password.slice(0, -1);
              process.stdout.write('\b \b');
            }
          } else if (code >= 32) {
            password += char;
            process.stdout.write('*');
          }
        }
      };

      const cleanup = () => {
        process.stdin.removeListener('data', onData);
        process.stdin.setRawMode(false);
        // Restore readline output and resume
        (this.rl as any).output = realOutput;
        this.rl.resume();
      };

      process.stdin.on('data', onData);
    });
  }

  private writeAbovePrompt(text: string): void {
    // If suggestions are showing, clear them first
    if (this.suggestionsVisible) {
      this.clearSuggestionBox();
    }

    // Clear prompt line, write text, re-display prompt
    process.stdout.write('\r\x1b[2K');
    this.originalLog(text);
    if (this.started && !this.shuttingDown) {
      this.rl.prompt(true);
      // Do NOT re-render suggestions after log output —
      // they'll naturally reappear on next keypress if input still matches.
    }
  }

  private log(text: string): void {
    this.writeAbovePrompt(text);
  }

  private printBanner(): void {
    const lines = [
      '',
      `${c.green}${c.bold}  \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557${c.reset}`,
      `${c.green}${c.bold}  \u2551         Pando Node v0.2.0         \u2551${c.reset}`,
      `${c.green}${c.bold}  \u2551         The Open Network          \u2551${c.reset}`,
      `${c.green}${c.bold}  \u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d${c.reset}`,
      '',
    ];
    lines.forEach(l => this.originalLog(l));
  }

  // ── Input handling ──

  private async handleInput(input: string): Promise<void> {
    if (input.startsWith('/')) {
      const [cmd, ...args] = input.slice(1).split(/\s+/);
      await this.handleCommand(cmd.toLowerCase(), args);
    } else {
      // Free text → AI search
      await this.doSearch(input);
    }
  }

  private async handleCommand(cmd: string, args: string[]): Promise<void> {
    switch (cmd) {
      case 'help':
      case 'h':
        this.showHelp();
        break;
      case 'status':
      case 's':
        this.showStatus();
        break;
      case 'peers':
      case 'p':
        this.showPeers();
        break;
      case 'balance':
      case 'b':
        this.showBalance(args[0]);
        break;
      case 'wallet':
      case 'w':
        await this.showWallet();
        break;
      case 'network':
      case 'n':
        this.showNetwork();
        break;
      case 'transfer':
      case 'send':
      case 't':
        await this.doTransfer(args);
        break;
      case 'connect':
      case 'c':
        await this.doConnect(args.join(' '));
        break;
      case 'search':
        await this.doSearch(args.join(' '));
        break;
      case 'agents':
      case 'a':
        await this.showAgents();
        break;
      case 'chat':
        await this.doChat(args.join(' '));
        break;
      case 'agent':
      case 'tell':
        await this.doAgentMessage(args[0], args.slice(1).join(' '));
        break;
      case 'proposals':
        this.showProposals();
        break;
      case 'propose':
        await this.doPropose(args.join(' '));
        break;
      case 'vote':
        await this.doVote(args[0], args[1], args.slice(2).join(' '));
        break;
      case 'scheduler':
        this.showSchedulerStatus();
        break;
      case 'submit':
        await this.doSubmitTask(args.join(' '));
        break;
      case 'tasks':
        this.showTasks();
        break;
      case 'monitor':
      case 'm':
        this.showMonitor();
        break;
      case 'upgrade':
      case 'u':
        await this.doUpgrade(args);
        break;
      case 'resources':
      case 'r':
        this.showResources();
        break;
      case 'contribute':
        await this.doContribute(args.join(' '));
        break;
      case 'revoke':
        await this.doRevoke(args.join(' '));
        break;
      case 'launch':
        await this.doLaunchInstance(args.join(' '));
        break;
      case 'instances':
        this.showInstances();
        break;
      case 'terminate':
        await this.doTerminateInstance(args.join(' '));
        break;
      case 'upgrade-instance':
        await this.doUpgradeInstance(args.join(' '));
        break;
      case 'invite':
      case 'i':
        this.showInvite();
        break;
      case 'login':
        await this.doLogin(args[0], args[1]);
        break;
      case 'register':
        await this.doRegister(args[0], args[1]);
        break;
      case 'logout':
        await this.doLogout();
        break;
      case 'index':
        await this.doLocalIndex(args.join(' '));
        break;
      case 'unindex':
        await this.doLocalUnindex(args.join(' '));
        break;
      case 'local':
        this.showLocalStatus();
        break;
      case 'memory':
        this.showMemory(args);
        break;
      case 'quit':
      case 'exit':
      case 'q':
        await this.shutdown();
        break;
      default:
        this.log(`${c.dim}Unknown command: /${cmd}. Type /help.${c.reset}`);
    }
  }

  // ── Commands ──

  private showHelp(): void {
    const lines = [
      '',
      `${c.bold}Commands:${c.reset}`,
      `  ${c.cyan}/status${c.reset}   ${c.dim}(/s)${c.reset}                     Node status`,
      `  ${c.cyan}/peers${c.reset}    ${c.dim}(/p)${c.reset}                     Connected peers`,
      `  ${c.cyan}/network${c.reset}  ${c.dim}(/n)${c.reset}                     Network topology & balances`,
      `  ${c.cyan}/balance${c.reset}  ${c.dim}(/b)${c.reset} ${c.dim}[peerId]${c.reset}           Lux balance`,
      `  ${c.cyan}/wallet${c.reset}   ${c.dim}(/w)${c.reset}                     Wallet & ownership info`,
      `  ${c.cyan}/transfer${c.reset} ${c.dim}(/t /send)${c.reset} ${c.dim}<peerId> <amt>${c.reset} Send Lux`,
      `  ${c.cyan}/connect${c.reset}  ${c.dim}(/c)${c.reset} ${c.dim}<multiaddr>${c.reset}       Connect to a peer`,
      `  ${c.cyan}/search${c.reset}   ${c.dim}<query>${c.reset}                  AI search`,
      '',
      `${c.bold}Governance:${c.reset}`,
      `  ${c.cyan}/proposals${c.reset}                           List governance proposals`,
      `  ${c.cyan}/propose${c.reset}  ${c.dim}<title>${c.reset}                 Create a proposal`,
      `  ${c.cyan}/vote${c.reset}     ${c.dim}<id> <approve|reject>${c.reset}   Cast a vote`,
      '',
      `${c.bold}Agent System:${c.reset}`,
      `  ${c.cyan}/agents${c.reset}   ${c.dim}(/a)${c.reset}                     Show agent tree`,
      `  ${c.cyan}/chat${c.reset}     ${c.dim}<message>${c.reset}               Chat with the node manager`,
      `  ${c.cyan}/agent${c.reset}    ${c.dim}(/tell)${c.reset} ${c.dim}<id> <message>${c.reset}  Send message to an agent`,
      '',
      `${c.bold}Scheduler:${c.reset}`,
      `  ${c.cyan}/scheduler${c.reset}                           Scheduler status`,
      `  ${c.cyan}/submit${c.reset}   ${c.dim}<description>${c.reset}            Submit task to Scheduler`,
      `  ${c.cyan}/tasks${c.reset}                               Show task queue`,
      `  ${c.cyan}/monitor${c.reset}  ${c.dim}(/m)${c.reset}                     Health monitor status`,
      '',
      `${c.bold}Resources:${c.reset}`,
      `  ${c.cyan}/resources${c.reset} ${c.dim}(/r)${c.reset}                    List your resources & network resources`,
      `  ${c.cyan}/contribute${c.reset} ${c.dim}<service> [key]${c.reset}        Contribute a resource`,
      `  ${c.cyan}/revoke${c.reset}    ${c.dim}<id>${c.reset}                    Revoke a resource`,
      `  ${c.cyan}/launch${c.reset}    ${c.dim}<resourceId> [type] [region]${c.reset}  Launch secure EC2 instance`,
      `  ${c.cyan}/instances${c.reset}                              List cloud instances`,
      `  ${c.cyan}/terminate${c.reset} ${c.dim}<instanceId>${c.reset}             Terminate a cloud instance`,
      `  ${c.cyan}/upgrade-instance${c.reset} ${c.dim}<instanceId>${c.reset}      Upgrade a cloud instance via P2P`,
      '',
      `  ${c.cyan}/invite${c.reset}   ${c.dim}(/i)${c.reset}                     Share bootstrap command for new peers`,
      `  ${c.cyan}/upgrade${c.reset}  ${c.dim}(/u)${c.reset}                     Check for updates & upgrade`,
      '',
      `  ${c.cyan}/register${c.reset} ${c.dim}<user> <pass>${c.reset}            Create account & link to this node`,
      `  ${c.cyan}/login${c.reset}    ${c.dim}<user> <pass>${c.reset}            Link existing account to this node`,
      `  ${c.cyan}/logout${c.reset}                              Unlink account & clear session`,
      '',
      `${c.bold}Local Environment (Envelope 1 — private, never synced):${c.reset}`,
      `  ${c.cyan}/index${c.reset}    ${c.dim}<directory>${c.reset}              Add directory to file index`,
      `  ${c.cyan}/unindex${c.reset}  ${c.dim}<directory>${c.reset}              Remove directory from file index`,
      `  ${c.cyan}/local${c.reset}                               Show indexed dirs & stats`,
      `  ${c.cyan}/memory${c.reset}   ${c.dim}[forget <key>]${c.reset}           Show user memory`,
      '',
      `  ${c.cyan}/quit${c.reset}     ${c.dim}(/q)${c.reset}                     Shutdown`,
      '',
      `  ${c.dim}Or just type anything to search the network.${c.reset}`,
      '',
    ];
    lines.forEach(l => this.log(l));
  }

  private showStatus(): void {
    const network = this.node.getNetwork();
    const ledger = this.node.getLedger();
    const identity = this.node.getIdentity();

    if (!network || !ledger || !identity) {
      this.log(`${c.red}Node not ready.${c.reset}`);
      return;
    }

    const stats = ledger.getNetworkStats();
    const balance = ledger.accounts.getBalance(identity.peerId);
    const uptime = Math.floor(process.uptime());
    const mins = Math.floor(uptime / 60);
    const secs = uptime % 60;

    const linkedUser = this.node.getLinkedUser();
    const operatorLine = linkedUser
      ? `  ${c.dim}Operator:${c.reset}  ${c.green}${linkedUser.username || linkedUser.peerId.slice(0, 20)}${c.reset} ${c.dim}(${linkedUser.peerId.slice(0, 16)}...)${c.reset}`
      : `  ${c.dim}Operator:${c.reset}  ${c.yellow}none${c.reset} ${c.dim}(rewards -> node address)${c.reset}`;

    const lines = [
      '',
      `${c.bold}Node Status${c.reset}`,
      `  ${c.dim}Peer ID:${c.reset}   ${c.cyan}${identity.peerId}${c.reset}`,
      operatorLine,
      `  ${c.dim}Peers:${c.reset}     ${network.getPeerCount()}`,
      `  ${c.dim}Balance:${c.reset}   ${c.green}${balance} Lux${c.reset}`,
      `  ${c.dim}Supply:${c.reset}    ${stats.totalSupply} Lux`,
      `  ${c.dim}Accounts:${c.reset}  ${stats.totalAccounts}`,
      `  ${c.dim}Relay fees:${c.reset} ${stats.totalRelayFees} Lux`,
      `  ${c.dim}Uptime:${c.reset}    ${mins}m ${secs}s`,
      '',
    ];
    lines.forEach(l => this.log(l));
  }

  private showPeers(): void {
    const network = this.node.getNetwork();
    if (!network) {
      this.log(`${c.red}Network not ready.${c.reset}`);
      return;
    }

    const peers = network.getPeers();
    if (peers.length === 0) {
      this.log(`${c.dim}No peers connected.${c.reset}`);
      return;
    }

    this.log('');
    this.log(`${c.bold}Connected Peers (${peers.length})${c.reset}`);
    for (const peer of peers) {
      const ago = Math.floor((Date.now() - peer.connectedAt) / 1000);
      const mins = Math.floor(ago / 60);
      this.log(`  ${c.cyan}${peer.peerId}${c.reset} ${c.dim}(${mins}m ago)${c.reset}`);
    }
    this.log('');
  }

  private showNetwork(): void {
    const network = this.node.getNetwork();
    const ledger = this.node.getLedger();
    const identity = this.node.getIdentity();
    if (!network || !ledger || !identity) {
      this.log(`${c.red}Node not ready.${c.reset}`);
      return;
    }

    const stats = ledger.getNetworkStats();
    const myBalance = ledger.accounts.getBalance(identity.peerId);
    const peers = network.getPeers();

    this.log('');
    this.log(`${c.bold}Network Topology${c.reset}`);
    this.log(`  ${c.dim}Supply: ${stats.totalSupply} Lux | Relay fees: ${stats.totalRelayFees} Lux | Accounts: ${stats.totalAccounts}${c.reset}`);
    this.log('');

    // This node
    this.log(`  ${c.green}\u25cf${c.reset} ${c.cyan}${identity.peerId}${c.reset} ${c.dim}(you)${c.reset}`);
    this.log(`    ${c.green}${myBalance} Lux${c.reset}`);

    // Connected peers
    for (const peer of peers) {
      const peerBalance = ledger.accounts.getBalance(peer.peerId);
      const connSecs = Math.floor((Date.now() - peer.connectedAt) / 1000);
      const mins = Math.floor(connSecs / 60);
      const secs = connSecs % 60;
      this.log(`  ${c.dim}\u2502${c.reset}`);
      this.log(`  ${c.blue}\u25cf${c.reset} ${c.cyan}${peer.peerId}${c.reset}`);
      this.log(`    ${c.green}${peerBalance} Lux${c.reset} ${c.dim}| connected ${mins}m ${secs}s${c.reset}`);
    }

    if (peers.length === 0) {
      this.log(`  ${c.dim}\u2502${c.reset}`);
      this.log(`  ${c.dim}\u25cb No peers connected${c.reset}`);
    }
    this.log('');
  }

  private showBalance(peerId?: string): void {
    const ledger = this.node.getLedger();
    const identity = this.node.getIdentity();
    if (!ledger || !identity) {
      this.log(`${c.red}Node not ready.${c.reset}`);
      return;
    }

    const target = peerId || identity.peerId;
    const balance = ledger.accounts.getBalance(target);
    const label = peerId ? `Balance for ${c.cyan}${peerId}${c.reset}` : 'Your balance';
    this.log(`${label}: ${c.green}${c.bold}${balance} Lux${c.reset}`);
  }

  private async showWallet(): Promise<void> {
    const identity = this.node.getIdentity();
    const ledger = this.node.getLedger();
    if (!identity || !ledger) {
      this.log(`${c.red}Node not ready.${c.reset}`);
      return;
    }

    const linkedUser = this.node.getLinkedUser();
    const walletPeerId = linkedUser ? linkedUser.peerId : identity.peerId;
    const walletBalance = ledger.accounts.getBalance(walletPeerId);
    const dataDir = this.node.getDataDir();

    // Find this identity's info
    const identities = listIdentities(dataDir);
    const myInfo = identities.find(i => i.peerId === identity.peerId);
    const encLabel = myInfo?.encrypted
      ? `${c.green}(encrypted)${c.reset}`
      : `${c.yellow}(not encrypted — use /logout to set password)${c.reset}`;

    const lines = [
      '',
      `${c.bold}Wallet${c.reset}`,
    ];

    if (linkedUser) {
      lines.push(`  ${c.dim}Account:${c.reset}            ${c.green}${c.bold}${linkedUser.username || 'linked'}${c.reset}`);
      lines.push(`  ${c.dim}User Peer ID:${c.reset}       ${c.cyan}${linkedUser.peerId}${c.reset}`);
      lines.push(`  ${c.dim}Balance:${c.reset}            ${c.green}${c.bold}${walletBalance} Lux${c.reset}`);
      lines.push(`  ${c.dim}Node Peer ID:${c.reset}       ${c.dim}${identity.peerId}${c.reset}`);
    } else {
      lines.push(`  ${c.dim}Peer ID (address):${c.reset}  ${c.cyan}${identity.peerId}${c.reset}`);
      lines.push(`  ${c.dim}Balance:${c.reset}            ${c.green}${c.bold}${walletBalance} Lux${c.reset}`);
      lines.push(`  ${c.dim}Account:${c.reset}            ${c.yellow}none — use /login to link${c.reset}`);
    }

    lines.push(`  ${c.dim}Data Directory:${c.reset}     ${dataDir}`);
    lines.push(`  ${c.dim}Identity:${c.reset}           ${encLabel}`);
    lines.push(`  ${c.dim}Identities:${c.reset}         ${identities.length} stored`);
    lines.push('');
    lines.push(`  ${c.yellow}Back up your identity file. Lose it + forget password = lose your Lux.${c.reset}`);
    lines.push('');

    lines.forEach(l => this.log(l));
  }

  private async doTransfer(args: string[]): Promise<void> {
    if (args.length < 2) {
      this.log(`${c.dim}Usage: /transfer <peerId> <amount>${c.reset}`);
      return;
    }

    const [to, amountStr] = args;
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) {
      this.log(`${c.red}Invalid amount: ${amountStr}${c.reset}`);
      return;
    }

    const ledger = this.node.getLedger();
    const identity = this.node.getIdentity();
    const sync = this.node.getSync();
    const network = this.node.getNetwork();

    if (!ledger || !identity || !sync) {
      this.log(`${c.red}Node not ready.${c.reset}`);
      return;
    }

    const spinner = createSpinner(`Sending ${amount} Lux...`, (t) => this.log(t));

    try {
      // Auto-register recipient if they're a connected peer
      if (!ledger.accounts.exists(to)) {
        const isPeer = network?.getPeers().some(p => p.peerId === to);
        if (isPeer) {
          ledger.registerNode(to, 'remote-peer');
        }
      }

      // Pick a relay: random connected peer (not sender, not recipient)
      // Falls back to recipient if no third-party peer is available
      const peers = network?.getPeers() || [];
      const thirdParty = peers.filter(p => p.peerId !== identity.peerId && p.peerId !== to);
      const relay = thirdParty.length > 0
        ? thirdParty[Math.floor(Math.random() * thirdParty.length)].peerId
        : (to !== identity.peerId ? to : undefined);

      // Ensure relay has a ledger account
      if (relay && !ledger.accounts.exists(relay)) {
        ledger.registerNode(relay, 'remote-peer');
      }

      const tx = ledger.transfer(identity.peerId, to, amount, relay);

      // Sign the transaction with our private key
      tx.signature = await signTransaction(tx, identity.privateKey);
      // Persist signature to ledger DB so local queries return signed records
      ledger.transactions.updateSignature(tx.id, tx.signature);

      await sync.broadcastTransaction(tx);

      spinner.stop();
      this.log('');
      this.log(`${c.green}${c.bold}Transfer successful!${c.reset}`);
      this.log(`  ${c.dim}Amount:${c.reset} ${c.green}${amount} Lux${c.reset}`);
      this.log(`  ${c.dim}To:${c.reset}     ${c.cyan}${to}${c.reset}`);
      if (tx.fee > 0 && tx.relay) {
        this.log(`  ${c.dim}Fee:${c.reset}    ${tx.fee} Lux → ${c.cyan}${tx.relay.slice(0, 16)}...${c.reset} ${c.dim}(relay)${c.reset}`);
      }
      this.log(`  ${c.dim}Tx:${c.reset}     ${tx.id.slice(0, 16)}...`);
      this.log('');
    } catch (err: any) {
      spinner.stop();
      this.log(`${c.red}Transfer failed: ${err.message}${c.reset}`);
    }
  }

  private async doConnect(addr: string): Promise<void> {
    if (!addr) {
      this.log(`${c.dim}Usage: /connect <multiaddr>${c.reset}`);
      this.log(`${c.dim}Example: /connect /ip4/100.64.0.1/tcp/4001/p2p/12D3KooW...${c.reset}`);
      return;
    }

    const network = this.node.getNetwork();
    if (!network) {
      this.log(`${c.red}Network not ready.${c.reset}`);
      return;
    }

    const spinner = createSpinner('Connecting...', (t) => this.log(t));

    try {
      const peerId = await network.dialPeer(addr);
      spinner.stop();
      this.log('');
      this.log(`${c.green}${c.bold}Connected!${c.reset}`);
      this.log(`  ${c.dim}Peer:${c.reset} ${c.cyan}${peerId}${c.reset}`);
      this.log('');
    } catch (err: any) {
      spinner.stop();
      this.log(`${c.red}Connection failed: ${err.message}${c.reset}`);
    }
  }

  private async doSearch(query: string): Promise<void> {
    if (!query) {
      this.log(`${c.dim}Usage: /search <query> or just type your question${c.reset}`);
      return;
    }

    const spinner = createSpinner('Searching...', (t) => this.log(t));

    try {
      const result = await this.node.search(query);
      spinner.stop();
      this.log('');
      this.log(`${c.bold}${result.answer}${c.reset}`);
      if (result.sources?.length) {
        this.log(`${c.dim}Sources: ${result.sources.join(', ')}${c.reset}`);
      }
      this.log(`${c.dim}Confidence: ${result.confidence} | By: ${result.respondedBy}${c.reset}`);
      this.log('');
    } catch (err: any) {
      spinner.stop();
      this.log(`${c.red}Search failed: ${err.message}${c.reset}`);
    }
  }

  // ── Governance Commands ──

  private showProposals(): void {
    const gov = this.node.getGovernance();
    if (!gov) {
      this.log(`${c.red}Governance not ready.${c.reset}`);
      return;
    }

    const proposals = gov.getProposals();
    if (proposals.length === 0) {
      this.log(`${c.dim}No proposals yet. Use /propose to create one.${c.reset}`);
      return;
    }

    this.log('');
    this.log(`${c.bold}Governance Proposals (${proposals.length})${c.reset}`);
    for (const p of proposals) {
      const statusColor = p.status === 'active' ? c.green : p.status === 'passed' ? c.cyan : c.red;
      const votes = gov.getVotes(p.id);
      const shortId = p.id.slice(0, 8);
      this.log(`  ${statusColor}[${p.status}]${c.reset} ${c.bold}${p.title}${c.reset} ${c.dim}(${shortId}... | ${votes.length} votes)${c.reset}`);
    }
    this.log('');
  }

  private async doPropose(title: string): Promise<void> {
    if (!title) {
      this.log(`${c.dim}Usage: /propose <title of proposal>${c.reset}`);
      return;
    }

    const gov = this.node.getGovernance();
    if (!gov) {
      this.log(`${c.red}Governance not ready.${c.reset}`);
      return;
    }

    const proposal = await gov.createProposal(title, title);
    this.log(`${c.green}Proposal created: "${proposal.title}"${c.reset}`);
    this.log(`  ${c.dim}ID: ${proposal.id.slice(0, 8)}... Voting ends: ${new Date(proposal.votingEndsAt).toISOString()}${c.reset}`);
  }

  private async doVote(proposalId: string, choice: string, reasoning: string): Promise<void> {
    if (!proposalId || !choice) {
      this.log(`${c.dim}Usage: /vote <proposalId> <approve|reject|abstain> [reasoning]${c.reset}`);
      return;
    }

    const gov = this.node.getGovernance();
    if (!gov) {
      this.log(`${c.red}Governance not ready.${c.reset}`);
      return;
    }

    // Match partial proposal ID
    const proposals = gov.getProposals();
    const match = proposals.find(p => p.id.startsWith(proposalId));
    if (!match) {
      this.log(`${c.red}Proposal not found: ${proposalId}${c.reset}`);
      return;
    }

    if (!['approve', 'reject', 'abstain'].includes(choice)) {
      this.log(`${c.red}Choice must be: approve, reject, or abstain${c.reset}`);
      return;
    }

    try {
      await gov.castVote(match.id, choice as any, reasoning || '');
      this.log(`${c.green}Vote cast: ${choice} on "${match.title}"${c.reset}`);
    } catch (err: any) {
      this.log(`${c.red}Vote failed: ${err.message}${c.reset}`);
    }
  }

  // ── Scheduler Commands ──

  private showSchedulerStatus(): void {
    const scheduler = this.node.getScheduler();
    if (!scheduler) {
      this.log('');
      this.log(`${c.bold}Scheduler${c.reset}: ${c.red}off${c.reset}`);
      this.log(`  ${c.dim}Scheduler auto-enables when Claude Code is in PATH. Install Claude Code or use ${c.cyan}--scheduler${c.dim} to force-enable.${c.reset}`);
      this.log('');
      return;
    }

    const status = scheduler.getStatus();
    const lines = [
      '',
      `${c.bold}Scheduler Status${c.reset}`,
      `  ${c.dim}Running:${c.reset}     ${status.running ? `${c.green}yes${c.reset}` : `${c.red}no${c.reset}`}`,
      `  ${c.dim}Active:${c.reset}      ${status.activeTasks.length} task${status.activeTasks.length !== 1 ? 's' : ''}`,
      `  ${c.dim}Processed:${c.reset}   ${status.totalProcessed} (${c.green}${status.totalSucceeded} ok${c.reset}, ${c.red}${status.totalFailed} failed${c.reset})`,
      `  ${c.dim}Max conc.:${c.reset}   ${status.config.maxConcurrentTasks}`,
      `  ${c.dim}Poll:${c.reset}        ${status.config.pollIntervalMs / 1000}s`,
    ];

    if (status.activeTasks.length > 0) {
      lines.push('');
      lines.push(`${c.bold}Active Tasks:${c.reset}`);
      for (const at of status.activeTasks) {
        const elapsed = Math.floor((Date.now() - at.startedAt) / 1000);
        lines.push(`  ${c.cyan}${at.taskId.slice(0, 8)}...${c.reset} ${c.dim}[${at.lifecycle}]${c.reset} ${(at as any).profile?.profileId || 'agent'} ${c.dim}(${elapsed}s)${c.reset}`);
      }
    }

    lines.push('');
    lines.forEach(l => this.log(l));
  }

  private async doSubmitTask(description: string): Promise<void> {
    if (!description) {
      this.log(`${c.dim}Usage: /submit <task description>${c.reset}`);
      return;
    }

    const scheduler = this.node.getScheduler();
    if (!scheduler) {
      this.log(`${c.red}Scheduler not running. Install Claude Code (auto-detects) or start with --scheduler.${c.reset}`);
      return;
    }

    // Use the node's active TaskQueue (has localPeerId + network for GossipSub)
    const tq = this.node.getActiveTaskQueue();
    if (!tq) {
      this.log('Task queue not available');
      return;
    }
    const title = description.slice(0, 50);
    const task = tq.createTask({
      title,
      description,
      priority: 'medium',
      createdBy: 'tui',
    });

    this.log('');
    this.log(`${c.green}${c.bold}Task submitted!${c.reset}`);
    this.log(`  ${c.dim}ID:${c.reset}    ${c.cyan}${task.id.slice(0, 8)}...${c.reset}`);
    this.log(`  ${c.dim}Title:${c.reset} ${title}`);
    this.log(`  ${c.dim}The Scheduler will pick this up on its next poll cycle.${c.reset}`);
    this.log('');
  }

  private async showTasks(): Promise<void> {
    // Read tasks from the TaskQueue
    const { TaskQueue } = await import('./platform/task-queue.js');
    const dataDir = this.node.getDataDir() || undefined;
    const tq = new TaskQueue(dataDir);
    const tasks = tq.getTasks({});

    if (tasks.length === 0) {
      this.log(`${c.dim}No tasks in queue. Use /submit to add one.${c.reset}`);
      return;
    }

    const statusColors: Record<string, string> = {
      open: c.yellow,
      claimed: c.blue,
      in_progress: c.cyan,
      review: c.magenta,
      done: c.green,
      rejected: c.red,
    };

    this.log('');
    this.log(`${c.bold}Task Queue (${tasks.length})${c.reset}`);
    for (const task of tasks.slice(0, 20)) {
      const color = statusColors[task.status] || c.dim;
      const shortId = task.id.slice(0, 8);
      const assignee = task.assignedTo ? ` ${c.dim}-> ${task.assignedTo.slice(0, 12)}${c.reset}` : '';
      this.log(`  ${color}[${task.status}]${c.reset} ${c.cyan}${shortId}${c.reset} ${task.title}${assignee}`);
    }
    if (tasks.length > 20) {
      this.log(`  ${c.dim}... and ${tasks.length - 20} more${c.reset}`);
    }
    this.log('');
  }

  // ── Monitor ──

  private showMonitor(): void {
    const monitor = this.node.getMonitor();
    if (!monitor) {
      this.log('');
      this.log(`${c.bold}Health Monitor${c.reset}: ${c.red}off${c.reset}`);
      this.log(`  ${c.dim}Auto-enables with scheduler (Claude Code detection) or use ${c.cyan}--monitor${c.dim} flag.${c.reset}`);
      this.log('');
      return;
    }

    const metrics = monitor.getCurrentMetrics();
    const config = monitor.getConfig();

    const healthColors: Record<string, string> = {
      healthy: c.green,
      degraded: c.yellow,
      critical: c.red,
    };
    const healthColor = healthColors[metrics.nodeHealth] || c.dim;
    const dot = metrics.nodeHealth === 'healthy' ? '\u25cf' : '\u25cf';

    const lines = [
      '',
      `${c.bold}Health Monitor${c.reset}  ${healthColor}${dot} ${metrics.nodeHealth.toUpperCase()}${c.reset}`,
      '',
      `  ${c.dim}Peers:${c.reset}                ${metrics.peerCount}`,
      `  ${c.dim}Scheduler:${c.reset}            ${metrics.schedulerRunning ? `${c.green}running${c.reset}` : `${c.red}stopped${c.reset}`}`,
      `  ${c.dim}Active tasks:${c.reset}         ${metrics.activeTasks}`,
      `  ${c.dim}Success rate:${c.reset}         ${Math.round(metrics.recentSuccessRate * 100)}%`,
      `  ${c.dim}Consecutive fails:${c.reset}    ${metrics.consecutiveFailures}`,
      `  ${c.dim}Check interval:${c.reset}       ${config.checkIntervalMs / 1000}s`,
      `  ${c.dim}Uptime:${c.reset}               ${Math.floor(metrics.uptimeSeconds / 60)}m ${metrics.uptimeSeconds % 60}s`,
    ];

    const activeAlerts = metrics.alerts.filter((a: any) => !a.resolved);
    if (activeAlerts.length > 0) {
      lines.push('');
      lines.push(`${c.bold}Active Alerts (${activeAlerts.length})${c.reset}`);
      for (const alert of activeAlerts) {
        const sColor = alert.severity === 'critical' ? c.red : alert.severity === 'warning' ? c.yellow : c.dim;
        const ago = Math.floor((Date.now() - alert.lastSeen) / 1000);
        lines.push(`  ${sColor}[${alert.severity}]${c.reset} ${alert.type} — ${alert.message} ${c.dim}(${ago}s ago, x${alert.count})${c.reset}`);
      }
    } else {
      lines.push('');
      lines.push(`  ${c.green}No active alerts.${c.reset}`);
    }

    lines.push('');
    lines.forEach(l => this.log(l));
  }

  // ── Resource Management ──

  private showResources(): void {
    const registry = this.node.getResourceRegistry();
    const identity = this.node.getIdentity();
    if (!registry || !identity) {
      this.log(`${c.red}Node not ready.${c.reset}`);
      return;
    }

    const myPeerId = identity.peerId;
    const myResources = registry.getOwnerResources(myPeerId);

    this.log('');
    this.log(`${c.cyan}${c.bold}=== Your Resources ===${c.reset}`);

    if (myResources.length === 0) {
      this.log(`  ${c.dim}No resources contributed yet.${c.reset}`);
    } else {
      for (const r of myResources) {
        const idShort = r.resourceId.slice(-4);
        const statusColor = r.status === 'active' ? c.green : c.red;
        const serviceName = (r as any).metadata?.service || r.type;
        const labelTag = (r as any).metadata?.label ? ` ${c.dim}(${(r as any).metadata.label})${c.reset}` : '';
        this.log(`  ${c.yellow}[${r.resourceId}]${c.reset} ${c.bold}${serviceName}${c.reset} ${c.dim}${r.type}${c.reset}  ${c.dim}****${idShort}${c.reset}  ${statusColor}(${r.status})${c.reset}${labelTag}`);
      }
    }

    this.log('');
    this.log(`${c.cyan}${c.bold}=== Network Resources ===${c.reset}`);

    const allResources = registry.getAllResources();
    const activeResources = allResources.filter(r => r.status === 'active');

    if (activeResources.length === 0) {
      this.log(`  ${c.dim}No network resources found.${c.reset}`);
    } else {
      // Group by service name (prefer metadata.service, fall back to type)
      const byService = new Map<string, Set<string>>();
      for (const r of activeResources) {
        const serviceName = (r as any).metadata?.service || r.type;
        if (!byService.has(serviceName)) byService.set(serviceName, new Set());
        byService.get(serviceName)!.add(r.userId || 'anonymous');
      }

      for (const [service, providers] of byService) {
        this.log(`  ${c.bold}${service}${c.reset}: ${c.green}${providers.size}${c.reset} provider${providers.size !== 1 ? 's' : ''}`);
      }
    }

    this.log('');
    this.log(`${c.dim}Tip: /contribute <service> [key] to add, /revoke <id> to remove${c.reset}`);
    this.log('');
  }

  private async doContribute(argsStr: string): Promise<void> {
    const SERVICE_MAP: Record<string, { type: string; metadata: Record<string, any> }> = {
      'openai':      { type: 'ai_api_key',      metadata: { provider: 'openai', service: 'OpenAI' } },
      'anthropic':   { type: 'ai_api_key',      metadata: { provider: 'anthropic', service: 'Anthropic' } },
      'gemini':      { type: 'ai_api_key',      metadata: { provider: 'gemini', service: 'Google Gemini' } },
      'mongodb':     { type: 'storage_db',      metadata: { provider: 'mongodb', service: 'MongoDB' } },
      'aws':         { type: 'storage_blob',    metadata: { provider: 'aws', service: 'AWS S3' } },
      's3':          { type: 'storage_blob',    metadata: { provider: 'aws', service: 'AWS S3' } },
      'github':      { type: 'code_repository', metadata: { provider: 'github', service: 'GitHub' } },
      'ec2':         { type: 'cloud_compute',   metadata: { provider: 'aws', service: 'AWS Compute' } },
      'lambda':      { type: 'cloud_compute',   metadata: { provider: 'aws', service: 'AWS Compute' } },
    };

    const [firstArg, ...valueParts] = argsStr.split(' ');
    const value = valueParts.join(' ');
    const serviceLower = firstArg?.toLowerCase() || '';

    if (serviceLower === 'claude-code' || serviceLower === 'claudecode') {
      this.log('');
      this.log(`${c.yellow}Claude Code is detected automatically as a node capability.${c.reset}`);
      this.log(`${c.dim}It shows under "My Nodes" on the Resources page — no need to /contribute it separately.${c.reset}`);
      this.log(`${c.dim}Use /status to see your node's capabilities.${c.reset}`);
      this.log('');
      return;
    }

    if (!firstArg || !value) {
      // Special help text for AWS with no value
      if (serviceLower === 'aws' || serviceLower === 's3') {
        this.log('');
        this.log(`${c.yellow}AWS S3 requires structured credentials. Use JSON format:${c.reset}`);
        this.log(`${c.dim}/contribute aws {"accessKeyId":"AKIA...","secretAccessKey":"...","region":"us-east-1","bucket":"my-bucket"}${c.reset}`);
        this.log(`${c.dim}Or use the gateway Resources page for a form-based experience.${c.reset}`);
        this.log('');
        return;
      }
      if (serviceLower === 'ec2' || serviceLower === 'lambda') {
        this.log('');
        this.log(`${c.yellow}AWS Compute requires structured credentials. Use JSON format:${c.reset}`);
        this.log(`${c.dim}/contribute ec2 {"accessKeyId":"AKIA...","secretAccessKey":"wJal..."}${c.reset}`);
        this.log(`${c.dim}Or use the gateway Resources page for a form-based experience.${c.reset}`);
        this.log('');
        return;
      }
      this.log(`${c.dim}Usage: /contribute <service> <key>${c.reset}`);
      this.log(`${c.dim}Services: openai, anthropic, gemini, mongodb, aws, github, ec2, lambda, claude-code${c.reset}`);
      this.log(`${c.dim}Example: /contribute openai sk-proj-abc123${c.reset}`);
      this.log(`${c.dim}         /contribute claude-code${c.reset}`);
      return;
    }

    const registry = this.node.getResourceRegistry();
    if (!registry) {
      this.log(`${c.red}Resource registry not available.${c.reset}`);
      return;
    }

    const preset = SERVICE_MAP[firstArg.toLowerCase()];
    if (!preset) {
      this.log(`${c.red}Unknown service "${firstArg}".${c.reset}`);
      this.log(`${c.dim}Valid services: openai, anthropic, gemini, mongodb, aws, s3, github, ec2, lambda, claude-code${c.reset}`);
      return;
    }
    const type = preset.type;
    const metadata = preset.metadata;

    // AWS/S3: validate JSON credentials if provided as JSON
    let credentialValue = value;
    if (serviceLower === 'aws' || serviceLower === 's3') {
      if (value.trimStart().startsWith('{')) {
        try {
          const parsed = JSON.parse(value);
          const requiredFields = ['accessKeyId', 'secretAccessKey', 'region', 'bucket'];
          const missing = requiredFields.filter(f => !parsed[f]);
          if (missing.length > 0) {
            this.log(`${c.red}AWS JSON credentials missing fields: ${missing.join(', ')}${c.reset}`);
            this.log(`${c.dim}Required: accessKeyId, secretAccessKey, region, bucket${c.reset}`);
            return;
          }
          credentialValue = value; // valid JSON, pass as-is
        } catch {
          this.log(`${c.red}Invalid JSON format for AWS credentials.${c.reset}`);
          this.log(`${c.dim}Example: /contribute aws {"accessKeyId":"AKIA...","secretAccessKey":"...","region":"us-east-1","bucket":"my-bucket"}${c.reset}`);
          return;
        }
      }
      // else: plain string, accept as-is (backward compatibility)
    }

    // EC2/Lambda: validate JSON credentials if provided as JSON
    if (serviceLower === 'ec2' || serviceLower === 'lambda') {
      if (value.trimStart().startsWith('{')) {
        try {
          const parsed = JSON.parse(value);
          const requiredFields = ['accessKeyId', 'secretAccessKey'];
          const missing = requiredFields.filter(f => !parsed[f]);
          if (missing.length > 0) {
            this.log(`${c.red}AWS Compute JSON credentials missing fields: ${missing.join(', ')}${c.reset}`);
            this.log(`${c.dim}Required: accessKeyId, secretAccessKey${c.reset}`);
            return;
          }
          credentialValue = value; // valid JSON, pass as-is
        } catch {
          this.log(`${c.red}Invalid JSON format for AWS Compute credentials.${c.reset}`);
          this.log(`${c.dim}Example: /contribute ec2 {"accessKeyId":"AKIA...","secretAccessKey":"wJal..."}${c.reset}`);
          return;
        }
      }
      // else: plain string, accept as-is (backward compatibility)
    }

    try {
      const linkedUser = this.node.getLinkedUser();
      const record = await registry.registerResource(type as any, credentialValue, { metadata, userId: linkedUser?.peerId });
      const masked = '****' + credentialValue.slice(-4);
      const serviceName = metadata.service || type;
      this.log('');
      this.log(`${c.green}Resource contributed successfully.${c.reset}`);
      this.log(`  ${c.dim}ID:${c.reset}      ${c.yellow}${record.resourceId}${c.reset}`);
      this.log(`  ${c.dim}Service:${c.reset} ${c.bold}${serviceName}${c.reset}`);
      this.log(`  ${c.dim}Type:${c.reset}    ${c.bold}${record.type}${c.reset}`);
      this.log(`  ${c.dim}Value:${c.reset}   ${c.dim}${masked}${c.reset}`);
      if (serviceLower === 'mongodb') {
        this.log('');
        this.log(`${c.yellow}  \u26a0 Restart your node for MongoDB storage to activate.${c.reset}`);
        this.log(`${c.dim}    User data features (projects, chat) will be available after restart.${c.reset}`);
      }
      // Phase 64: Offer to launch a secure compute instance for EC2 contributions
      if (serviceLower === 'ec2' || serviceLower === 'lambda') {
        this.log('');
        this.log(`${c.yellow}  Launch a secure compute instance?${c.reset}`);
        this.log(`${c.dim}    /launch ${record.resourceId}${c.reset}`);
        this.log(`${c.dim}    Instance will run a Pando node in compute mode (no SSH, tripwire-protected).${c.reset}`);
      }
      this.log('');
    } catch (err: any) {
      this.log(`${c.red}Failed to contribute resource: ${err.message}${c.reset}`);
    }
  }

  private async doRevoke(argsStr: string): Promise<void> {
    const id = argsStr.trim();
    if (!id) {
      this.log(`${c.dim}Usage: /revoke <id>${c.reset}`);
      return;
    }

    const registry = this.node.getResourceRegistry();
    if (!registry) {
      this.log(`${c.red}Resource registry not available.${c.reset}`);
      return;
    }

    try {
      const success = await registry.revokeResource(id);
      if (success) {
        this.log(`${c.green}Resource ${c.yellow}${id}${c.green} revoked.${c.reset}`);
      } else {
        this.log(`${c.red}Failed to revoke: resource not found or not owned by this node.${c.reset}`);
      }
    } catch (err: any) {
      this.log(`${c.red}Failed to revoke resource: ${err.message}${c.reset}`);
    }
  }

  // ── Cloud Instances (Phase 64) ──

  private async doLaunchInstance(argsStr: string): Promise<void> {
    const parts = argsStr.trim().split(/\s+/);
    const resourceId = parts[0];

    if (!resourceId) {
      this.log(`${c.dim}Usage: /launch <resourceId> [instanceType] [region]${c.reset}`);
      this.log(`${c.dim}Example: /launch bc17780e t3.small us-east-1${c.reset}`);
      return;
    }

    const cloudManager = this.node.getCloudInstanceManager();
    if (!cloudManager) {
      this.log(`${c.red}Cloud instance manager not available.${c.reset}`);
      return;
    }

    const instanceType = parts[1] || undefined;
    const region = parts[2] || undefined;

    try {
      this.log('');
      this.log(`${c.yellow}Launching secure compute instance...${c.reset}`);
      this.log(`${c.dim}  No SSH, tripwire-protected, compute mode.${c.reset}`);
      const record = await cloudManager.launchInstance(resourceId, { instanceType, region });
      this.log('');
      this.log(`${c.green}Instance launched successfully.${c.reset}`);
      this.log(`  ${c.dim}Instance ID:${c.reset} ${c.yellow}${record.instanceId}${c.reset}`);
      this.log(`  ${c.dim}Region:${c.reset}      ${record.region}`);
      this.log(`  ${c.dim}Type:${c.reset}        ${record.instanceType}`);
      this.log(`  ${c.dim}Status:${c.reset}      ${record.status}`);
      this.log(`  ${c.dim}Public IP:${c.reset}   ${record.publicIp || 'pending...'}`);
      this.log('');
      this.log(`${c.dim}Waiting for node to connect to P2P network...${c.reset}`);
      this.log(`${c.dim}Use /instances to check status.${c.reset}`);
      this.log('');
    } catch (err: any) {
      this.log(`${c.red}Failed to launch instance: ${err.message}${c.reset}`);
    }
  }

  private showInstances(): void {
    const cloudManager = this.node.getCloudInstanceManager();
    if (!cloudManager) {
      this.log(`${c.red}Cloud instance manager not available.${c.reset}`);
      return;
    }

    const instances = cloudManager.getInstances();
    if (instances.length === 0) {
      this.log(`${c.dim}No cloud instances. Use /launch <resourceId> to launch one.${c.reset}`);
      return;
    }

    this.log('');
    this.log(`${c.bold}Cloud Instances (${instances.length}):${c.reset}`);
    for (const inst of instances) {
      const statusColor = inst.status === 'running' ? c.green :
                         inst.status === 'launching' ? c.yellow :
                         inst.status === 'terminated' ? c.dim : c.red;
      this.log(`  ${c.yellow}${inst.instanceId}${c.reset}  ${statusColor}${inst.status}${c.reset}  ${inst.publicIp || 'no IP'}  ${inst.instanceType}  ${inst.region}`);
      if (inst.peerId) {
        this.log(`    ${c.dim}Peer: ${inst.peerId.slice(0, 20)}...${c.reset}`);
      }
      if (inst.apps.length > 0) {
        this.log(`    ${c.dim}Apps: ${inst.apps.join(', ')}${c.reset}`);
      }
      if (inst.error) {
        this.log(`    ${c.red}Error: ${inst.error}${c.reset}`);
      }
    }
    this.log('');
  }

  private async doTerminateInstance(argsStr: string): Promise<void> {
    const instanceId = argsStr.trim();
    if (!instanceId) {
      this.log(`${c.dim}Usage: /terminate <instanceId>${c.reset}`);
      return;
    }

    const cloudManager = this.node.getCloudInstanceManager();
    if (!cloudManager) {
      this.log(`${c.red}Cloud instance manager not available.${c.reset}`);
      return;
    }

    try {
      await cloudManager.terminateInstance(instanceId);
      this.log(`${c.green}Instance ${c.yellow}${instanceId}${c.green} terminated.${c.reset}`);
    } catch (err: any) {
      this.log(`${c.red}Failed to terminate instance: ${err.message}${c.reset}`);
    }
  }

  private async doUpgradeInstance(argsStr: string): Promise<void> {
    const instanceId = argsStr.trim();
    if (!instanceId) {
      this.log(`${c.dim}Usage: /upgrade-instance <instanceId>${c.reset}`);
      return;
    }

    const cloudManager = this.node.getCloudInstanceManager();
    if (!cloudManager) {
      this.log(`${c.red}Cloud instance manager not available.${c.reset}`);
      return;
    }

    this.log(`${c.dim}Sending upgrade request to ${instanceId}...${c.reset}`);
    try {
      const result = await cloudManager.upgradeInstance(instanceId);
      this.log(`${c.green}Upgrade result: ${c.yellow}${result.status}${c.reset}`);
      if (result.output) this.log(`${c.dim}${result.output}${c.reset}`);
    } catch (err: any) {
      this.log(`${c.red}Upgrade failed: ${err.message}${c.reset}`);
    }
  }

  // ── Invite ──

  private showInvite(): void {
    const network = this.node.getNetwork();
    const identity = this.node.getIdentity();
    if (!network || !identity) {
      this.log(`${c.red}Node not ready.${c.reset}`);
      return;
    }

    const addrs = network.getListenAddresses();
    // Filter out localhost — those only work on the same machine
    const external = addrs.filter(a => !a.includes('/127.0.0.1/'));

    if (external.length === 0) {
      this.log(`${c.yellow}No external addresses available. Are you connected to a network?${c.reset}`);
      if (addrs.length > 0) {
        this.log(`${c.dim}Only localhost address available: ${addrs[0]}${c.reset}`);
      }
      return;
    }

    this.log('');
    this.log(`${c.bold}Invite a new peer${c.reset}`);
    this.log(`${c.dim}Share one of these commands with someone to connect to your node:${c.reset}`);
    this.log('');

    for (const addr of external) {
      // Detect if this is a Tailscale/VPN address (100.x.x.x) vs LAN
      const ipMatch = addr.match(/\/ip4\/([\d.]+)\//);
      const ip = ipMatch ? ipMatch[1] : '';
      const label = ip.startsWith('100.') ? '(Tailscale/VPN)' : '(LAN)';

      this.log(`  ${c.dim}${label}${c.reset}`);
      this.log(`  ${c.cyan}pando --bootstrap ${addr}${c.reset}`);
      this.log('');
    }

    this.log(`${c.dim}The peer needs Pando installed: git clone + npm install + npm run build${c.reset}`);
    this.log(`${c.dim}Then run the command above to join the network through your node.${c.reset}`);
    this.log('');
  }

  // ── Agent System Commands ──

  /**
   * Read the API bearer token from <dataDir>/api-token.
   */
  private loadApiToken(): string {
    try {
      const tokenPath = join(this.node.getDataDir(), 'api-token');
      if (existsSync(tokenPath)) {
        return readFileSync(tokenPath, 'utf-8').trim();
      }
    } catch { /* ignore */ }
    return '';
  }

  /**
   * Make an HTTP request to the local node API.
   */
  private async apiRequest(method: string, path: string, body?: any): Promise<any> {
    const apiPort = this.node.getApiPort();
    const token = this.loadApiToken();
    const url = `http://127.0.0.1:${apiPort}${path}`;

    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text, status: res.status };
    }
  }

  /**
   * /agents — show the agent tree
   */
  private async showAgents(): Promise<void> {
    const spinner = createSpinner('Loading agents...', (t) => this.log(t));

    try {
      const tree = await this.apiRequest('GET', '/agents/tree');
      spinner.stop();

      if (tree.error) {
        this.log(`${c.red}${tree.error}${c.reset}`);
        return;
      }

      if (!Array.isArray(tree) || tree.length === 0) {
        this.log(`${c.dim}No agents running. Use /chat to talk to the node manager.${c.reset}`);
        return;
      }

      this.log('');
      this.log(`${c.bold}Agent Tree${c.reset}`);
      this.printAgentTree(tree, 0);
      this.log('');
    } catch (err: any) {
      spinner.stop();
      this.log(`${c.red}Failed to load agents: ${err.message}${c.reset}`);
    }
  }

  /**
   * Recursively print agent tree nodes with indentation.
   */
  private printAgentTree(nodes: any[], depth: number): void {
    for (const node of nodes) {
      const indent = '  '.repeat(depth + 1);
      const statusColors: Record<string, string> = {
        RUNNING: c.green,
        IDLE: c.yellow,
        COMPLETED: c.dim,
        FAILED: c.red,
        ARCHIVED: c.dim,
      };
      const statusColor = statusColors[node.status] || c.dim;
      const shortId = node.id.length > 16 ? node.id.slice(0, 12) + '...' : node.id;
      const tasks = node.taskCount > 0 ? ` ${c.dim}(${node.taskCount} tasks)${c.reset}` : '';
      const cost = node.totalCost > 0 ? ` ${c.dim}$${node.totalCost.toFixed(2)}${c.reset}` : '';

      this.log(`${indent}${statusColor}[${node.status}]${c.reset} ${c.cyan}${shortId}${c.reset} ${c.bold}${node.role}${c.reset}${tasks}${cost}`);
      if (node.description) {
        this.log(`${indent}  ${c.dim}${node.description}${c.reset}`);
      }

      if (Array.isArray(node.children) && node.children.length > 0) {
        this.printAgentTree(node.children, depth + 1);
      }
    }
  }

  /**
   * /chat <message> — send a message to the node manager
   */
  private async doChat(message: string): Promise<void> {
    if (!message) {
      this.log(`${c.dim}Usage: /chat <message>${c.reset}`);
      return;
    }

    const spinner = createSpinner('Thinking...', (t) => this.log(t));

    try {
      const result = await this.apiRequest('POST', '/chat/message', { message });

      if (result.error) {
        spinner.stop();
        this.log(`${c.red}${result.error}${c.reset}`);
        return;
      }

      // Simple tier — immediate reply
      if (result.tier === 'simple' && result.reply) {
        spinner.stop();
        this.log('');
        this.log(`${c.bold}${result.reply}${c.reset}`);
        this.log('');
        return;
      }

      // Complex tier — poll for the assistant response
      if (result.status === 'queued' && result.threadId) {
        const threadId = result.threadId;
        const maxWait = 60_000; // 60 seconds
        const pollInterval = 2_000; // 2 seconds
        const startTime = Date.now();

        while (Date.now() - startTime < maxWait) {
          await new Promise(resolve => setTimeout(resolve, pollInterval));

          try {
            const thread = await this.apiRequest('GET', `/chat/threads/${threadId}`);
            if (thread.messages && Array.isArray(thread.messages)) {
              const assistantMsg = thread.messages.find((m: any) => m.role === 'assistant');
              if (assistantMsg) {
                spinner.stop();
                this.log('');
                this.log(`${c.bold}${assistantMsg.content}${c.reset}`);
                this.log('');
                return;
              }
            }
          } catch {
            // Polling error — keep trying
          }
        }

        spinner.stop();
        this.log(`${c.yellow}Still processing. Check thread ${c.cyan}${threadId}${c.yellow} later.${c.reset}`);
        return;
      }

      // Fallback
      spinner.stop();
      this.log(`${c.green}Message sent.${c.reset} ${c.dim}${result.status || 'queued'}${c.reset}`);
    } catch (err: any) {
      spinner.stop();
      this.log(`${c.red}Chat failed: ${err.message}${c.reset}`);
    }
  }

  /**
   * /agent <id> <message> — send a message to a specific agent
   */
  private async doAgentMessage(agentId: string, message: string): Promise<void> {
    if (!agentId || !message) {
      this.log(`${c.dim}Usage: /agent <id> <message>${c.reset}`);
      return;
    }

    try {
      const result = await this.apiRequest('POST', `/agents/${agentId}/message`, {
        prompt: message,
        source: 'operator',
      });

      if (result.error) {
        this.log(`${c.red}${result.error}${c.reset}`);
        return;
      }

      this.log(`${c.green}Message sent to agent ${c.cyan}${agentId}${c.green}.${c.reset}`);
    } catch (err: any) {
      this.log(`${c.red}Failed to send message: ${err.message}${c.reset}`);
    }
  }

  // ── Lifecycle ──

  /**
   * Phase 34: Handle restart from pipeline/upgrade — TUI stays open, shows progress,
   * then exits with code 75 so the launcher loop restarts the process.
   */
  private handleRestart(reason: string, changedFiles?: string[]): void {
    this.log('');
    this.log(`${c.yellow}${c.bold}Upgrading...${c.reset} (${reason})`);
    if (changedFiles && changedFiles.length > 0) {
      const display = changedFiles.slice(0, 5);
      for (const f of display) {
        this.log(`  ${c.dim}${f}${c.reset}`);
      }
      if (changedFiles.length > 5) {
        this.log(`  ${c.dim}...and ${changedFiles.length - 5} more${c.reset}`);
      }
    }
    this.log(`${c.dim}Terminal stays open — node will restart momentarily...${c.reset}`);
    this.log('');

    // Graceful shutdown then exit(75) — launcher restarts
    (async () => {
      try {
        // Stop agents first
        const agentManager = this.node.getAgentManager();
        if (agentManager) {
          const killed = await agentManager.stopAll(10_000);
          this.log(`${c.dim}Stopped ${killed} agent(s)${c.reset}`);
          agentManager.stop();
        }

        this.log(`${c.dim}Stopping node...${c.reset}`);
        await this.node.stop();
        this.fileLogger.close();

        this.log(`${c.green}Restarting...${c.reset}`);
        process.exit(75);
      } catch (err) {
        this.log(`${c.red}Restart error, forcing exit${c.reset}`);
        process.exit(75);
      }
    })();
  }

  /**
   * Phase 73: /upgrade command — dispatch subcommands (propose, status, history, pull).
   */
  private async doUpgrade(args: string[]): Promise<void> {
    const sub = args[0]?.toLowerCase();
    if (!sub) {
      this.log('');
      this.log(`${c.bold}Upgrade Commands:${c.reset}`);
      this.log(`  ${c.cyan}/upgrade status${c.reset}    — Show version, auto-approve info, active upgrade`);
      this.log(`  ${c.cyan}/upgrade propose${c.reset} ${c.dim}<desc>${c.reset} — Propose upgrade from current git diff`);
      this.log(`  ${c.cyan}/upgrade history${c.reset}   — Show upgrade history`);
      this.log(`  ${c.cyan}/upgrade pull${c.reset}      — Manual git pull + build + restart`);
      this.log('');
      return;
    }
    switch (sub) {
      case 'status': await this.doUpgradeStatus(); break;
      case 'propose': await this.doUpgradePropose(args.slice(1).join(' ')); break;
      case 'history': await this.doUpgradeHistory(); break;
      case 'pull': await this.doUpgradePull(); break;
      default: this.log(`${c.red}Unknown: ${sub}${c.reset}. Use /upgrade for help.`);
    }
  }

  private async doUpgradeStatus(): Promise<void> {
    this.log('');
    const up = this.node.getUpgradeProtocol();
    if (!up) { this.log(`${c.red}Upgrade protocol not available${c.reset}`); return; }
    const status = up.getUpgradeStatus();
    const peers = (this.node as any).network?.getPeerCount?.() ?? 0;
    this.log(`${c.bold}Upgrade Status${c.reset}`);
    this.log(`  Version:      ${c.cyan}${status.currentVersion}${c.reset}`);
    this.log(`  Peers:        ${peers}`);
    this.log(`  Pinned:       ${status.pinnedVersion ? c.yellow + status.pinnedVersion + c.reset : c.dim + 'no' + c.reset}`);
    if (status.activeUpgrade) this.log(`  Active:       ${c.yellow}${status.activeUpgrade.proposalId.slice(0, 8)}${c.reset} — ${status.activeUpgrade.description}`);
    if (status.lastUpgrade) {
      const col = status.lastUpgrade.status === 'success' ? c.green : c.red;
      this.log(`  Last:         ${col}${status.lastUpgrade.status}${c.reset} (${status.lastUpgrade.proposalId.slice(0, 8)})`);
    }
    this.log('');
  }

  private async doUpgradePropose(description: string): Promise<void> {
    if (!description.trim()) { this.log(`${c.dim}Usage: /upgrade propose <description>${c.reset}`); return; }
    const up = this.node.getUpgradeProtocol();
    if (!up) { this.log(`${c.red}Upgrade protocol not available${c.reset}`); return; }
    this.log(`${c.dim}Creating upgrade proposal...${c.reset}`);
    try {
      const proposal = await up.createUpgradeProposal(description);
      this.log(`${c.green}Upgrade proposal created: ${proposal.proposalId.slice(0, 8)}${c.reset} — ${description} (commit: ${proposal.commitHash}, risk: ${proposal.riskAssessment.riskLevel})`);
    } catch (err: any) { this.log(`${c.red}Proposal failed: ${err.message}${c.reset}`); }
  }

  private async doUpgradeHistory(): Promise<void> {
    const up = this.node.getUpgradeProtocol();
    if (!up) { this.log(`${c.red}Upgrade protocol not available${c.reset}`); return; }
    const history = up.getUpgradeHistory();
    this.log('');
    if (history.length === 0) { this.log(`${c.dim}No upgrade history.${c.reset}`); }
    else {
      this.log(`${c.bold}Upgrade History${c.reset} (${history.length})`);
      for (const r of history.slice(0, 10)) {
        const col = r.status === 'success' ? c.green : c.red;
        this.log(`  ${col}${r.status.padEnd(12)}${c.reset} ${r.proposalId.slice(0, 8)} — v${r.version}`);
      }
    }
    this.log('');
  }

  private async doUpgradePull(): Promise<void> {
    const { execSync } = await import('node:child_process');
    const repoDir = process.cwd();
    this.log(`${c.bold}Checking for updates...${c.reset}`);
    try {
      execSync('git fetch', { cwd: repoDir, stdio: 'pipe', timeout: 30_000 });
      const status = execSync('git status -uno', { cwd: repoDir, encoding: 'utf-8', timeout: 10_000 });
      if (status.includes('up to date') || status.includes('up-to-date')) {
        this.log(`${c.green}Already up to date.${c.reset}`); return;
      }
      if (!status.includes('behind')) {
        this.log(`${c.yellow}Branch has local changes or diverged.${c.reset}`); return;
      }
      this.log(`${c.dim}Pulling...${c.reset}`);
      execSync('git pull', { cwd: repoDir, encoding: 'utf-8', timeout: 60_000 });
      this.log(`${c.dim}Building...${c.reset}`);
      execSync('npm run build', { cwd: repoDir, stdio: 'pipe', timeout: 120_000 });
      this.log(`${c.green}Build succeeded.${c.reset}`);
      this.handleRestart('manual-upgrade');
    } catch (err: any) {
      this.log(`${c.red}Upgrade failed: ${err.stderr?.toString()?.slice(-300) || err.message}${c.reset}`);
    }
  }

  /**
   * /login <username> <password> — authenticate against local node's /auth/login
   * and link the user account to this node for reward routing.
   */
  private async doLogin(username?: string, password?: string): Promise<void> {
    if (!username || !password) {
      this.log(`${c.dim}Usage: /login <username> <password>${c.reset}`);
      return;
    }

    const apiPort = this.node.getApiPort();
    const spinner = createSpinner('Authenticating...', (t) => this.log(t));

    try {
      const res = await fetch(`http://127.0.0.1:${apiPort}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: username, password }),
      });

      const data = await res.json() as any;

      if (!res.ok) {
        spinner.stop();
        this.log(`${c.red}Login failed: ${data.error || 'Unknown error'}${c.reset}`);
        return;
      }

      const userPeerId = data.user?.peerId;
      const userName = data.user?.username || username;

      if (!userPeerId) {
        spinner.stop();
        this.log(`${c.red}Login failed: no peerId in response${c.reset}`);
        return;
      }

      this.node.linkUser(userPeerId, userName);
      spinner.stop();
      this.log('');
      this.log(`${c.green}${c.bold}Logged in as ${userName}.${c.reset} Node rewards -> your account.`);
      this.log(`  ${c.dim}User Peer ID: ${c.cyan}${userPeerId}${c.reset}`);
      this.log('');
    } catch (err: any) {
      spinner.stop();
      this.log(`${c.red}Login failed: ${err.message}${c.reset}`);
    }
  }

  /**
   * /register <username> <password> — create a new account and auto-link to this node.
   * Two-step: POST /auth/guest → POST /auth/claim.
   */
  private async doRegister(username?: string, password?: string): Promise<void> {
    if (!username || !password) {
      this.log(`${c.dim}Usage: /register <username> <password>${c.reset}`);
      return;
    }

    const apiPort = this.node.getApiPort();
    const spinner = createSpinner('Creating account...', (t) => this.log(t));

    try {
      // Step 1: Create guest account (server-side key generation)
      const guestRes = await fetch(`http://127.0.0.1:${apiPort}/auth/guest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const guestData = await guestRes.json() as any;

      if (!guestRes.ok || !guestData.success) {
        spinner.stop();
        this.log(`${c.red}Registration failed: ${guestData.error || 'Could not create account'}${c.reset}`);
        return;
      }

      const guestToken = guestData.token;
      if (!guestToken) {
        spinner.stop();
        this.log(`${c.red}Registration failed: no session token returned${c.reset}`);
        return;
      }

      // Step 2: Claim the guest account with username + password
      const claimRes = await fetch(`http://127.0.0.1:${apiPort}/auth/claim`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Token': guestToken,
        },
        body: JSON.stringify({ username, password }),
      });

      const claimData = await claimRes.json() as any;

      if (!claimRes.ok || !claimData.success) {
        spinner.stop();
        this.log(`${c.red}Registration failed: ${claimData.error || 'Could not claim account'}${c.reset}`);
        return;
      }

      const userPeerId = claimData.peerId || guestData.peerId;

      if (!userPeerId) {
        spinner.stop();
        this.log(`${c.red}Registration failed: no peerId in response${c.reset}`);
        return;
      }

      // Auto-link the new account to this node
      this.node.linkUser(userPeerId, username);
      spinner.stop();
      this.log('');
      this.log(`${c.green}${c.bold}Account created: ${username}${c.reset}`);
      this.log(`  ${c.dim}Peer ID: ${c.cyan}${userPeerId}${c.reset}`);
      this.log(`  ${c.dim}Node rewards -> your account.${c.reset}`);
      this.log('');
    } catch (err: any) {
      spinner.stop();
      this.log(`${c.red}Registration failed: ${err.message}${c.reset}`);
    }
  }

  private async doLogout(): Promise<void> {
    // Phase 54: /logout = clear identity session, lock the node
    // Phase 55: Also unlink user account — rewards revert to node address
    this.node.unlinkUser();
    await clearSession(this.node.getDataDir());
    this.log('');
    this.log(`${c.green}Logged out.${c.reset} Node rewards -> node address.`);
    this.log(`${c.dim}Restart the node to re-authenticate.${c.reset}`);
    this.log('');
  }

  // ── v2.5: Local Environment Commands ────────────────────────────────────────

  private async doLocalIndex(dirPath: string): Promise<void> {
    const le = this.node.getLocalEnv();
    if (!le) {
      this.log(`${c.red}Local environment not initialized.${c.reset}`);
      return;
    }
    if (!dirPath) {
      this.log(`${c.dim}Usage: /index <directory>${c.reset}`);
      return;
    }
    this.log(`${c.dim}Indexing ${dirPath}...${c.reset}`);
    try {
      const result = await le.grantDirectory(dirPath);
      this.log(`${c.green}Indexed${c.reset} ${dirPath}: ${result.added} files added, ${result.skipped} skipped.`);
    } catch (err: any) {
      this.log(`${c.red}Error: ${err.message}${c.reset}`);
    }
  }

  private doLocalUnindex(dirPath: string): void {
    const le = this.node.getLocalEnv();
    if (!le) {
      this.log(`${c.red}Local environment not initialized.${c.reset}`);
      return;
    }
    if (!dirPath) {
      this.log(`${c.dim}Usage: /unindex <directory>${c.reset}`);
      return;
    }
    le.revokeDirectory(dirPath);
    this.log(`${c.yellow}Unindexed${c.reset} ${dirPath}.`);
  }

  private showLocalStatus(): void {
    const le = this.node.getLocalEnv();
    if (!le) {
      this.log(`${c.dim}Local environment not initialized.${c.reset}`);
      return;
    }
    const status = le.getStatus();
    this.log('');
    this.log(`${c.bold}Local File Index (Envelope 1)${c.reset}`);
    this.log(`  Total files: ${c.cyan}${status.totalFiles}${c.reset}`);
    this.log(`  DB: ${c.dim}${status.dbPath}${c.reset}`);
    this.log(`  Memory: ${c.dim}${status.memoryPath}${c.reset}`);
    if (status.grantedDirs.length === 0) {
      this.log(`  ${c.dim}No directories indexed. Use /index <dir> to add one.${c.reset}`);
    } else {
      this.log(`  Indexed directories:`);
      for (const dir of status.grantedDirs) {
        const ago = Math.round((Date.now() - dir.lastIndexedAt) / 1000 / 60);
        this.log(`    ${c.cyan}${dir.path}${c.reset}  ${dir.fileCount} files  ${c.dim}(last indexed ${ago}m ago)${c.reset}`);
      }
    }
    this.log('');
  }

  private showMemory(args: string[]): void {
    const le = this.node.getLocalEnv();
    if (!le) {
      this.log(`${c.dim}Local environment not initialized.${c.reset}`);
      return;
    }
    const memory = le.getMemory();
    if (!memory) {
      this.log(`${c.dim}No user memory yet. Agents will write here as they learn about you.${c.reset}`);
      return;
    }
    this.log('');
    this.log(`${c.bold}User Memory (Envelope 1 — ~/.pando/memory/user-memory.md)${c.reset}`);
    this.log(c.dim + '─'.repeat(60) + c.reset);
    // Show last 40 lines max
    const lines = memory.split('\n');
    const shown = lines.length > 40 ? lines.slice(-40) : lines;
    if (lines.length > 40) {
      this.log(`${c.dim}(showing last 40 of ${lines.length} lines)${c.reset}`);
    }
    for (const line of shown) {
      this.log(line);
    }
    this.log('');
  }

  private async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    if (this.suggestionsVisible) {
      this.clearSuggestionBox();
    }

    this.log('');
    this.log(`${c.yellow}Shutting down...${c.reset}`);

    // Restore console
    console.log = this.originalLog;
    console.error = this.originalError;

    await this.node.stop();
    this.fileLogger.close();
    this.rl.close();
    process.exit(0);
  }
}

// ── CLI arg parsing ──

// Default public bootstrap node for npx pando first-run discovery
const DEFAULT_BOOTSTRAP = '/ip4/100.87.67.78/tcp/4001/p2p/12D3KooWACe64YzKkwbAt98VVTs652YtvMPrg68hzPxtbYYWhCPR';

async function main() {
  const args = process.argv.slice(2);

  const portFlag = args.indexOf('--port');
  const port = portFlag !== -1 ? parsePort(args[portFlag + 1]) : 0;

  const apiPortFlag = args.indexOf('--api-port');
  const apiPort = apiPortFlag !== -1 ? parsePort(args[apiPortFlag + 1]) : 4000;

  const dataDirFlag = args.indexOf('--data-dir');
  const dataDir = dataDirFlag !== -1 ? args[dataDirFlag + 1] : undefined;

  // Phase 52.3: Scheduler auto-detection
  // --scheduler flag still works (backward compat), but scheduler now auto-enables
  // when Claude Code is detected in PATH. Use --no-scheduler to explicitly disable.
  const explicitScheduler = args.includes('--scheduler');
  const noScheduler = args.includes('--no-scheduler');
  let autoScheduler = explicitScheduler;
  if (!autoScheduler && !noScheduler) {
    autoScheduler = detectClaudeCode();
  }

  const bootstrapPeers: string[] = [];
  let idx = args.indexOf('--bootstrap');
  while (idx !== -1) {
    if (args[idx + 1]) bootstrapPeers.push(args[idx + 1]);
    idx = args.indexOf('--bootstrap', idx + 1);
  }
  if (bootstrapPeers.length === 0) {
    bootstrapPeers.push(DEFAULT_BOOTSTRAP);
  }

  const tui = new PandoTUI({
    listenPort: port,
    apiPort,
    bootstrapPeers,
    ...(dataDir ? { dataDir } : {}),
  });

  await tui.start(autoScheduler);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
