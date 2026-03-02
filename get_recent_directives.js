const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(process.env.HOME || 'C:\Users\jaira', '.pando', 'agents.db');
const db = new Database(dbPath, { readonly: true });

console.log('=== ALL DIRECTIVES (ID DESC) ===\n');
const all = db.prepare('SELECT id, title, status, created_at, added_by FROM directives ORDER BY id DESC').all();
all.forEach(d => {
  console.log(`ID ${d.id}: [${d.status}] "${d.title.substring(0, 80)}"... (added by ${d.added_by})`);
});

console.log('\n\n=== DIRECTIVE #207 FULL CONTENT ===\n');
const dir207 = db.prepare('SELECT * FROM directives WHERE id = 207').get();
console.log(`Target: ${dir207.target_id}`);
console.log(`Status: ${dir207.status}`);
console.log(`Added by: ${dir207.added_by}`);
console.log(`Created: ${dir207.created_at}`);
console.log(`Times seen: ${dir207.times_seen}`);
console.log(`\nContent:\n${dir207.content}`);

db.close();
