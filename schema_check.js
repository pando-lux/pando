const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(process.env.HOME || 'C:\Users\jaira', '.pando', 'agents.db');
const db = new Database(dbPath, { readonly: true });

const info = db.pragma('table_info(directives)');
console.log('=== Directives Table Schema ===');
console.log(JSON.stringify(info, null, 2));

console.log('\n=== All Directives ===');
const all = db.prepare('SELECT id, status, added_by, content FROM directives ORDER BY id DESC').all();
all.forEach(d => {
  const preview = d.content.substring(0, 60).replace(/\n/g, ' ');
  console.log(`\nID ${d.id}:`);
  console.log(`  Status: ${d.status}`);
  console.log(`  Added by: ${d.added_by}`);
  console.log(`  Content: ${preview}...`);
});

db.close();
