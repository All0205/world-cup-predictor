const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'predictor.db'));
db.pragma('journal_mode = WAL');

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY,
      team_a TEXT NOT NULL,
      team_b TEXT NOT NULL,
      match_date TEXT DEFAULT '',
      venue TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      results TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      completed_at TEXT
    )
  `);
}

module.exports = { db, init };
