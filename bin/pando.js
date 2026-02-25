#!/usr/bin/env node

/**
 * Pando — The Open Network
 *
 * Smart launcher: checks if the project is built, auto-builds if needed,
 * then starts the interactive TUI node.
 *
 * Usage:
 *   npx pando                          # start interactive node
 *   npx pando --port 4001              # custom P2P port
 *   npx pando --bootstrap <multiaddr>  # connect to existing node
 *   npx pando --headless               # non-interactive (CLI mode)
 */

'use strict';

const { existsSync } = require('fs');
const { join } = require('path');
const { execSync, fork } = require('child_process');

const root = join(__dirname, '..');

const tuiPath = join(root, 'packages', 'node', 'dist', 'tui.js');
const cliPath = join(root, 'packages', 'node', 'dist', 'cli.js');
const args = process.argv.slice(2);

const headless = args.includes('--headless');
const entrypoint = headless ? cliPath : tuiPath;

// Check if built — auto-build on first run
if (!existsSync(entrypoint)) {
  console.log('First run — building Pando...');
  try {
    execSync('npm run build', { cwd: root, stdio: 'inherit' });
    console.log('Build complete.\n');
  } catch (err) {
    console.error('Build failed. Make sure you have Node 20+ and run: npm install');
    process.exit(1);
  }
}

// Filter out --headless from args passed to the node
const nodeArgs = args.filter(a => a !== '--headless');

const RESTART_EXIT_CODE = 75;

function launch() {
  const child = fork(entrypoint, nodeArgs, {
    cwd: root,
    stdio: 'inherit',
  });

  child.on('exit', (code) => {
    if (code === RESTART_EXIT_CODE) {
      console.log('\n[launcher] Restart requested (auto-update). Relaunching...\n');
      // Small delay to let ports release
      setTimeout(launch, 2000);
    } else {
      process.exit(code ?? 0);
    }
  });
}

launch();
