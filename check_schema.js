const { Database } = require('./node_modules/better-sqlite3');
const db = new Database('./data/athenamem.db');
const schema = db.prepare('SELECT sql FROM sqlite_master WHERE name="memories"').get();
console.log(schema ? schema.sql : 'not found');
const entries = db.prepare('SELECT sql FROM sqlite_master WHERE name="entries"').get();
console.log('ENTRIES:', entries ? entries.sql : 'not found');
db.close();
