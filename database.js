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
    );
    CREATE TABLE IF NOT EXISTS predictions (
      team_a TEXT NOT NULL,
      team_b TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      last_checked_at TEXT DEFAULT '',
      PRIMARY KEY (team_a, team_b)
    );
  `);
  // 兼容旧表：如果 predictions 缺少 last_checked_at 列则补上
  try {
    db.exec('ALTER TABLE predictions ADD COLUMN last_checked_at TEXT DEFAULT \'\'');
  } catch (e) { /* 列已存在则忽略 */ }
}

function getCachedPrediction(teamA, teamB) {
  const row = db.prepare(
    'SELECT execution_id FROM predictions WHERE team_a = ? AND team_b = ?'
  ).get(teamA, teamB);
  if (!row) return null;
  return db.prepare('SELECT * FROM executions WHERE id = ?').get(row.execution_id);
}

function cachePrediction(teamA, teamB, executionId) {
  db.prepare(
    'INSERT OR REPLACE INTO predictions (team_a, team_b, execution_id, created_at, last_checked_at) VALUES (?, ?, ?, datetime(\'now\',\'localtime\'), \'\')'
  ).run(teamA, teamB, executionId);
}

function updateLastChecked(teamA, teamB) {
  db.prepare(
    'UPDATE predictions SET last_checked_at = datetime(\'now\',\'localtime\') WHERE team_a = ? AND team_b = ?'
  ).run(teamA, teamB);
}

function getLastChecked(teamA, teamB) {
  const row = db.prepare(
    'SELECT last_checked_at FROM predictions WHERE team_a = ? AND team_b = ?'
  ).get(teamA, teamB);
  return row ? row.last_checked_at : null;
}

function invalidatePrediction(teamA, teamB) {
  db.prepare('DELETE FROM predictions WHERE team_a = ? AND team_b = ?').run(teamA, teamB);
}

function invalidateAllForTeam(team) {
  db.prepare('DELETE FROM predictions WHERE team_a = ? OR team_b = ?').run(team, team);
}

module.exports = { db, init, getCachedPrediction, cachePrediction, updateLastChecked, getLastChecked, invalidatePrediction, invalidateAllForTeam };
