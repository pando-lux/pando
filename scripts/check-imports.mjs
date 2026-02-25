#!/usr/bin/env node
/**
 * check-imports.mjs — Enforce layer import boundaries.
 *
 * Rules:
 *   kernel/ → may NOT import from core/ or platform/
 *   core/   → may NOT import from platform/
 *   platform/ → may import from anything (within packages/node/src/)
 *
 * Run: node scripts/check-imports.mjs
 * Add to CI: exits with code 1 if violations found.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NODE_SRC = resolve(__dirname, '../packages/node/src');

const RULES = {
  kernel:   [],             // Cannot import from anywhere in node/src except kernel itself
  core:     ['kernel'],     // Can import from kernel only
  platform: ['kernel', 'core'], // Can import from kernel and core
};

let violations = 0;

for (const [layer, allowedLayers] of Object.entries(RULES)) {
  const dir = join(NODE_SRC, layer);
  let files;
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.ts'));
  } catch {
    continue;
  }

  for (const file of files) {
    const content = readFileSync(join(dir, file), 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match: from '../<something>/'
      const m = line.match(/from\s+['"]\.\.\/(\w+)\//);
      if (!m) continue;
      const importedLayer = m[1];

      // Skip if importing from an allowed layer or from itself
      if (allowedLayers.includes(importedLayer) || importedLayer === layer) continue;

      // Skip lines that are just interface/comment definitions
      if (line.trim().startsWith('//') || line.trim().startsWith('*') || line.trim().startsWith('interface')) continue;

      console.error(`[VIOLATION] ${layer}/${file}:${i + 1} imports from ${importedLayer}/`);
      console.error(`  > ${line.trim()}`);
      violations++;
    }
  }
}

if (violations === 0) {
  console.log('✓ All import boundaries clean.');
  process.exit(0);
} else {
  console.error(`\n✗ ${violations} import boundary violation(s) found.`);
  console.error('  kernel/ must not import core/ or platform/');
  console.error('  core/ must not import platform/');
  process.exit(1);
}
