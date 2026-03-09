import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export async function register() {
  // Write gateway breadcrumb so the supervisor tray can find us
  const port = parseInt(process.env.PORT || '3000', 10);
  const pandoDir = join(homedir(), '.pando');
  try {
    mkdirSync(pandoDir, { recursive: true });
    writeFileSync(join(pandoDir, 'gateway.json'), JSON.stringify({ port, startedAt: Date.now() }));
  } catch { /* ignore — not critical */ }
}
