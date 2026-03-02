const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbDir = path.join(process.env.HOME || 'C:\Users\jaira', '.pando');
const files = fs.readdirSync(dbDir).filter(f => f.endsWith('.db'));

console.log('Found DB files:', files);
console.log('\nChecking each database for directives table...\n');

for (const file of files) {
  const dbPath = path.join(dbDir, file);
  try {
    const db = new Database(dbPath, { readonly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    if (tables.some(t => t.name === 'directives')) {
      console.log(`FOUND directives table in: ${file}`);
      console.log('Tables:', tables.map(t => t.name).join(', '));
      
      // Query directive 207
      const dir207 = db.prepare('SELECT * FROM directives WHERE id = 207').all();
      console.log('\nDirective #207:');
      console.log(JSON.stringify(dir207, null, 2));
      
      // Query recent directives
      const recent = db.prepare('SELECT id, title, status, created_at FROM directives ORDER BY id DESC LIMIT 10').all();
      console.log('\nRecent directives (last 10):');
      console.log(JSON.stringify(recent, null, 2));
    }
    db.close();
  } catch (e) {
    // Silently skip errors
  }
}
