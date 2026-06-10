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
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      home TEXT NOT NULL,
      away TEXT NOT NULL,
      venue TEXT DEFAULT '',
      stage TEXT DEFAULT '小组赛',
      grp TEXT DEFAULT '',
      status TEXT DEFAULT 'upcoming'
    );
  `);
  try {
    db.exec('ALTER TABLE predictions ADD COLUMN last_checked_at TEXT DEFAULT \'\'');
  } catch (e) { /* 列已存在则忽略 */ }

  seedMatches();
}

function seedMatches() {
  const count = db.prepare('SELECT COUNT(*) as c FROM matches').get();
  if (count.c > 0) return; // 已播种则跳过

  const matches = require('./matches.json');
  const insert = db.prepare(
    'INSERT INTO matches (date, home, away, venue, stage, grp, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );

  const seedMany = db.transaction((list) => {
    for (const m of list) insert.run(m.date, m.home, m.away, m.venue, m.stage || '小组赛', m.grp || '', m.status || 'upcoming');
  });

  // 小组赛
  seedMany(matches.map(m => ({ ...m, stage: '小组赛', grp: m.group || '', status: 'upcoming' })));

  // 淘汰赛占位
  const ko = knockoutPlaceholders();
  seedMany(ko);
}

function knockoutPlaceholders() {
  const list = [];

  // ── 1/16决赛 — 6月29日~7月4日（北京时间）──
  const r32 = [
    ['6月29日', 'A组第二', 'B组第二', 'SoFi Stadium, 洛杉矶'],
    ['6月30日', 'E组第一', 'A/B/C/D/F组第三', 'Gillette Stadium, 波士顿'],
    ['6月30日', 'F组第一', 'C组第二', 'Estadio BBVA, 蒙特雷'],
    ['6月30日', 'C组第一', 'F组第二', 'NRG Stadium, 休斯顿'],
    ['7月1日', 'I组第一', 'C/D/F/G/H组第三', 'MetLife Stadium, 新泽西'],
    ['7月1日', 'E组第二', 'I组第二', 'AT&T Stadium, 达拉斯'],
    ['7月1日', 'A组第一', 'C/E/F/H/I组第三', 'Estadio Azteca, 墨西哥城'],
    ['7月2日', 'L组第一', 'E/H/I/J/K组第三', 'Mercedes-Benz Stadium, 亚特兰大'],
    ['7月2日', 'D组第一', 'B/E/F/I/J组第三', 'Levi\'s Stadium, 旧金山'],
    ['7月2日', 'G组第一', 'A/E/H/I/J组第三', 'Lumen Field, 西雅图'],
    ['7月3日', 'K组第二', 'L组第二', 'BMO Field, 多伦多'],
    ['7月3日', 'H组第一', 'J组第二', 'SoFi Stadium, 洛杉矶'],
    ['7月3日', 'B组第一', 'E/F/G/I/J组第三', 'BC Place, 温哥华'],
    ['7月4日', 'J组第一', 'H组第二', 'Hard Rock Stadium, 迈阿密'],
    ['7月4日', 'K组第一', 'D/E/I/J/L组第三', 'Arrowhead Stadium, 堪萨斯城'],
    ['7月4日', 'D组第二', 'G组第二', 'AT&T Stadium, 达拉斯'],
  ];
  for (const [date, home, away, venue] of r32) {
    list.push({ date, home, away, venue, stage: '1/16决赛', grp: '', status: 'upcoming' });
  }

  // ── 1/8决赛 — 7月5日~7月8日（北京时间）──
  const r16 = [
    ['7月5日', 'R32-M74胜者', 'R32-M77胜者', 'Lincoln Financial Field, 费城'],
    ['7月5日', 'R32-M73胜者', 'R32-M75胜者', 'NRG Stadium, 休斯顿'],
    ['7月6日', 'R32-M76胜者', 'R32-M78胜者', 'MetLife Stadium, 新泽西'],
    ['7月6日', 'R32-M79胜者', 'R32-M80胜者', 'Estadio Azteca, 墨西哥城'],
    ['7月7日', 'R32-M83胜者', 'R32-M84胜者', 'AT&T Stadium, 达拉斯'],
    ['7月7日', 'R32-M81胜者', 'R32-M82胜者', 'Lumen Field, 西雅图'],
    ['7月8日', 'R32-M86胜者', 'R32-M88胜者', 'Mercedes-Benz Stadium, 亚特兰大'],
    ['7月8日', 'R32-M85胜者', 'R32-M87胜者', 'BC Place, 温哥华'],
  ];
  for (const [date, home, away, venue] of r16) {
    list.push({ date, home, away, venue, stage: '1/8决赛', grp: '', status: 'upcoming' });
  }

  // ── 1/4决赛 — 7月10日~7月12日（北京时间）──
  const qf = [
    ['7月10日', 'R16-M89胜者', 'R16-M90胜者', 'Gillette Stadium, 波士顿'],
    ['7月11日', 'R16-M93胜者', 'R16-M94胜者', 'SoFi Stadium, 洛杉矶'],
    ['7月12日', 'R16-M91胜者', 'R16-M92胜者', 'Hard Rock Stadium, 迈阿密'],
    ['7月12日', 'R16-M95胜者', 'R16-M96胜者', 'Arrowhead Stadium, 堪萨斯城'],
  ];
  for (const [date, home, away, venue] of qf) {
    list.push({ date, home, away, venue, stage: '1/4决赛', grp: '', status: 'upcoming' });
  }

  // ── 半决赛 — 7月15日~7月16日（北京时间）──
  list.push({ date: '7月15日', home: 'QF-M97胜者', away: 'QF-M98胜者', venue: 'AT&T Stadium, 达拉斯', stage: '半决赛', grp: '', status: 'upcoming' });
  list.push({ date: '7月16日', home: 'QF-M99胜者', away: 'QF-M100胜者', venue: 'Mercedes-Benz Stadium, 亚特兰大', stage: '半决赛', grp: '', status: 'upcoming' });

  // ── 三四名决赛 — 7月19日（北京时间）──
  list.push({ date: '7月19日', home: 'SF-M101败者', away: 'SF-M102败者', venue: 'Hard Rock Stadium, 迈阿密', stage: '三四名决赛', grp: '', status: 'upcoming' });

  // ── 决赛 — 7月20日（北京时间）──
  list.push({ date: '7月20日', home: 'SF-M101胜者', away: 'SF-M102胜者', venue: 'MetLife Stadium, 新泽西', stage: '决赛', grp: '', status: 'upcoming' });

  return list;
}

function getAllMatches() {
  return db.prepare('SELECT * FROM matches ORDER BY date, id').all();
}

function updateMatchTeams(id, home, away) {
  db.prepare('UPDATE matches SET home = ?, away = ? WHERE id = ?').run(home, away, id);
}

function getMatchesByDate(date) {
  return db.prepare('SELECT * FROM matches WHERE date = ?').all(date);
}

function updateMatchStatus(id, status) {
  db.prepare('UPDATE matches SET status = ? WHERE id = ?').run(status, id);
}

function getCompletedCountForDate(date) {
  const row = db.prepare('SELECT COUNT(*) as c FROM matches WHERE date = ? AND status = ?').get(date, 'completed');
  return row ? row.c : 0;
}

function getTotalCountForDate(date) {
  const row = db.prepare('SELECT COUNT(*) as c FROM matches WHERE date = ?').get(date);
  return row ? row.c : 0;
}

// ── 缓存相关 ──

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

module.exports = {
  db, init,
  getAllMatches, updateMatchTeams, getMatchesByDate, updateMatchStatus, getCompletedCountForDate, getTotalCountForDate,
  getCachedPrediction, cachePrediction,
  updateLastChecked, getLastChecked,
  invalidatePrediction, invalidateAllForTeam
};
