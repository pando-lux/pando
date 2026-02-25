#!/usr/bin/env node

/**
 * Pando — The Open Network
 *
 * npx entry point. Launches the interactive TUI node.
 *
 * Usage:
 *   npx pando                          # start interactive node
 *   npx pando --port 4001              # custom P2P port
 *   npx pando --bootstrap <multiaddr>  # connect to existing node
 *   npx pando --headless               # non-interactive (CLI mode)
 */

'use strict';

const { join } = require('path');

const args = process.argv.slice(2);
const headless = args.includes('--headless');

// TUI is the default interactive entry point; --headless uses the minimal CLI
const entrypoint = headless
  ? join(__dirname, '..', 'dist', 'cli.js')
  : join(__dirname, '..', 'dist', 'tui.js');

// Filter out --headless from args passed to the node
const nodeArgs = args.filter(a => a !== '--headless');

// Re-exec with the real entry point
process.argv = [process.argv[0], entrypoint, ...nodeArgs];
require(entrypoint);
