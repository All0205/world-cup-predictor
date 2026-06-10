const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY,
      team_a TEXT NOT NULL,
      team_b TEXT NOT NULL,
      match_date TEXT DEFAULT '',
      venue TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      results JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS predictions (
      team_a TEXT NOT NULL,
      team_b TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_checked_at TIMESTAMPTZ,
      PRIMARY KEY (team_a, team_b)
    );
    CREATE TABLE IF NOT EXISTS matches (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      home TEXT NOT NULL,
      away TEXT NOT NULL,
      venue TEXT DEFAULT '',
      stage TEXT DEFAULT '小组赛',
      grp TEXT DEFAULT '',
      status TEXT DEFAULT 'upcoming'
    );
  `);

  await seedMatches();
}

async function seedMatches() {
  const { rows } = await pool.query('SELECT COUNT(*) as c FROM matches');
  if (parseInt(rows[0].c) > 0) return;

  const matches = require('./matches.json');
  const ko = knockoutPlaceholders();
  const all = [...matches.map(m => ({ ...m, stage: '小组赛', grp: m.group || '', status: 'upcoming' })), ...ko];

  for (const m of all) {
    await pool.query(
      'INSERT INTO matches (date, home, away, venue, stage, grp, status) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [m.date, m.home, m.away, m.venue, m.stage || '小组赛', m.grp || '', m.status || 'upcoming']
    );
  }
}

function knockoutPlaceholders() {
  const list = [];
  const r32 = [
    ['6月29日', 'A组第二', 'B组第二', 'SoFi Stadium, 洛杉矶'],
    ['6月30日', 'E组第一', 'A/B/C/D/F组第三', 'Gillette Stadium, 波士顿'],
    ['6月30日', 'F组第一', 'C组第二', 'Estadio BBVA, 蒙特雷'],
    ['6月30日', 'C组第一', 'F组第二', 'NRG Stadium, 休斯顿'],
    ['7月1日', 'I组第一', 'C/D/F/G/H组第三', 'MetLife Stadium, 新泽西'],
    ['7月1日', 'E组第二', 'I组第二', 'AT&T Stadium, 达拉斯'],
    ['7月1日', 'A组第一', 'C/E/F/H/I组第三', 'Estadio Azteca, 墨西哥城'],
    ['7月2日', 'L组第一', 'E/H/I/J/K组第三', 'Mercedes-Benz Stadium, 亚特兰大'],
    ['7月2日', 'D组第一', 'B/E/F/I/J组第三', "Levi's Stadium, 旧金山"],
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
  const qf = [
    ['7月10日', 'R16-M89胜者', 'R16-M90胜者', 'Gillette Stadium, 波士顿'],
    ['7月11日', 'R16-M93胜者', 'R16-M94胜者', 'SoFi Stadium, 洛杉矶'],
    ['7月12日', 'R16-M91胜者', 'R16-M92胜者', 'Hard Rock Stadium, 迈阿密'],
    ['7月12日', 'R16-M95胜者', 'R16-M96胜者', 'Arrowhead Stadium, 堪萨斯城'],
  ];
  for (const [date, home, away, venue] of qf) {
    list.push({ date, home, away, venue, stage: '1/4决赛', grp: '', status: 'upcoming' });
  }
  list.push({ date: '7月15日', home: 'QF-M97胜者', away: 'QF-M98胜者', venue: 'AT&T Stadium, 达拉斯', stage: '半决赛', grp: '', status: 'upcoming' });
  list.push({ date: '7月16日', home: 'QF-M99胜者', away: 'QF-M100胜者', venue: 'Mercedes-Benz Stadium, 亚特兰大', stage: '半决赛', grp: '', status: 'upcoming' });
  list.push({ date: '7月19日', home: 'SF-M101败者', away: 'SF-M102败者', venue: 'Hard Rock Stadium, 迈阿密', stage: '三四名决赛', grp: '', status: 'upcoming' });
  list.push({ date: '7月20日', home: 'SF-M101胜者', away: 'SF-M102胜者', venue: 'MetLife Stadium, 新泽西', stage: '决赛', grp: '', status: 'upcoming' });
  return list;
}

async function getAllMatches() {
  const { rows } = await pool.query('SELECT * FROM matches ORDER BY date, id');
  return rows;
}

async function updateMatchTeams(id, home, away) {
  await pool.query('UPDATE matches SET home = $1, away = $2 WHERE id = $3', [home, away, id]);
}

async function getMatchesByDate(date) {
  const { rows } = await pool.query('SELECT * FROM matches WHERE date = $1', [date]);
  return rows;
}

async function updateMatchStatus(id, status) {
  await pool.query('UPDATE matches SET status = $1 WHERE id = $2', [status, id]);
}

async function getCompletedCountForDate(date) {
  const { rows } = await pool.query('SELECT COUNT(*) as c FROM matches WHERE date = $1 AND status = $2', [date, 'completed']);
  return rows[0] ? parseInt(rows[0].c) : 0;
}

async function getTotalCountForDate(date) {
  const { rows } = await pool.query('SELECT COUNT(*) as c FROM matches WHERE date = $1', [date]);
  return rows[0] ? parseInt(rows[0].c) : 0;
}

async function getCachedPrediction(teamA, teamB) {
  const { rows } = await pool.query(
    'SELECT execution_id FROM predictions WHERE team_a = $1 AND team_b = $2',
    [teamA, teamB]
  );
  if (rows.length === 0) return null;
  const { rows: execRows } = await pool.query('SELECT * FROM executions WHERE id = $1', [rows[0].execution_id]);
  return execRows.length > 0 ? execRows[0] : null;
}

async function cachePrediction(teamA, teamB, executionId) {
  await pool.query(
    'INSERT INTO predictions (team_a, team_b, execution_id, created_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (team_a, team_b) DO UPDATE SET execution_id = $3, created_at = NOW()',
    [teamA, teamB, executionId]
  );
}

async function updateLastChecked(teamA, teamB) {
  await pool.query(
    'UPDATE predictions SET last_checked_at = NOW() WHERE team_a = $1 AND team_b = $2',
    [teamA, teamB]
  );
}

async function getLastChecked(teamA, teamB) {
  const { rows } = await pool.query(
    'SELECT last_checked_at FROM predictions WHERE team_a = $1 AND team_b = $2',
    [teamA, teamB]
  );
  return rows.length > 0 ? rows[0].last_checked_at : null;
}

async function invalidatePrediction(teamA, teamB) {
  await pool.query('DELETE FROM predictions WHERE team_a = $1 AND team_b = $2', [teamA, teamB]);
}

async function invalidateAllForTeam(team) {
  await pool.query('DELETE FROM predictions WHERE team_a = $1 OR team_b = $1', [team]);
}

module.exports = {
  pool, init,
  getAllMatches, updateMatchTeams, getMatchesByDate, updateMatchStatus, getCompletedCountForDate, getTotalCountForDate,
  getCachedPrediction, cachePrediction,
  updateLastChecked, getLastChecked,
  invalidatePrediction, invalidateAllForTeam
};
