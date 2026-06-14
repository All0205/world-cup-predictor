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
    CREATE TABLE IF NOT EXISTS elo_ratings (
      team TEXT PRIMARY KEY,
      rating INTEGER NOT NULL DEFAULT 1500,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS match_results (
      id SERIAL PRIMARY KEY,
      match_id INTEGER REFERENCES matches(id),
      date TEXT NOT NULL,
      home TEXT NOT NULL,
      away TEXT NOT NULL,
      home_score INTEGER NOT NULL,
      away_score INTEGER NOT NULL,
      stage TEXT DEFAULT '',
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS match_analysis (
      id SERIAL PRIMARY KEY,
      match_id INTEGER REFERENCES matches(id),
      home TEXT NOT NULL,
      away TEXT NOT NULL,
      home_score INTEGER NOT NULL,
      away_score INTEGER NOT NULL,
      possession_home REAL,
      possession_away REAL,
      shots_home INTEGER,
      shots_away INTEGER,
      shots_on_target_home INTEGER,
      shots_on_target_away INTEGER,
      xg_home REAL,
      xg_away REAL,
      corners_home INTEGER,
      corners_away INTEGER,
      fouls_home INTEGER,
      fouls_away INTEGER,
      offsides_home INTEGER,
      offsides_away INTEGER,
      yellow_cards_home INTEGER,
      yellow_cards_away INTEGER,
      red_cards_home INTEGER,
      red_cards_away INTEGER,
      penalties_home INTEGER,
      penalties_away INTEGER,
      pass_accuracy_home REAL,
      pass_accuracy_away REAL,
      commentary_summary TEXT,
      tactical_summary TEXT,
      key_moments TEXT,
      source_urls TEXT,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await seedElo();
  await seedMatches();
}

async function seedElo() {
  const { rows } = await pool.query('SELECT COUNT(*) as c FROM elo_ratings');
  if (parseInt(rows[0].c) > 0) return;

  const elo = require('./data/elo.json');
  for (const [team, rating] of Object.entries(elo)) {
    await pool.query('INSERT INTO elo_ratings (team, rating) VALUES ($1, $2)', [team, rating]);
  }
  console.log('  [数据库] 已导入', Object.keys(elo).length, '支球队的ELO评分');
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

// ── ELO 评分 ──

async function getEloRating(team) {
  const { rows } = await pool.query('SELECT rating FROM elo_ratings WHERE team = $1', [team]);
  if (rows.length > 0) return rows[0].rating;
  // 模糊匹配
  const { rows: all } = await pool.query('SELECT team, rating FROM elo_ratings');
  for (const r of all) {
    if (team.includes(r.team) || r.team.includes(team)) return r.rating;
  }
  return 1500;
}

async function getAllEloRatings() {
  const { rows } = await pool.query('SELECT team, rating FROM elo_ratings ORDER BY rating DESC');
  const map = {};
  rows.forEach(r => { map[r.team] = r.rating; });
  return map;
}

async function updateEloRating(team, newRating) {
  await pool.query(
    'INSERT INTO elo_ratings (team, rating, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (team) DO UPDATE SET rating = $2, updated_at = NOW()',
    [team, Math.round(newRating)]
  );
}

// ── 比赛结果 ──

async function saveMatchResult(matchId, date, home, away, homeScore, awayScore, stage) {
  // 检查是否已记录
  const { rows } = await pool.query(
    'SELECT id FROM match_results WHERE match_id = $1 AND home = $2 AND away = $3',
    [matchId, home, away]
  );
  if (rows.length > 0) return null; // 已存在

  await pool.query(
    'INSERT INTO match_results (match_id, date, home, away, home_score, away_score, stage) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [matchId, date, home, away, homeScore, awayScore, stage]
  );
  return { date, home, away, homeScore, awayScore, stage };
}

async function getRecentResults(team, limit = 5) {
  const { rows } = await pool.query(
    'SELECT date, home, away, home_score, away_score, stage FROM match_results WHERE home = $1 OR away = $1 ORDER BY recorded_at DESC LIMIT $2',
    [team, limit]
  );
  return rows;
}

// ── 比赛详细分析 ──

async function saveMatchAnalysis(data) {
  const toFloat = (v) => (v !== null && v !== undefined) ? parseFloat(v) : null;
  const toInt = (v) => (v !== null && v !== undefined) ? parseInt(v) : null;
  await pool.query(
    `INSERT INTO match_analysis (match_id, home, away, home_score, away_score,
      possession_home, possession_away, shots_home, shots_away,
      shots_on_target_home, shots_on_target_away, xg_home, xg_away,
      corners_home, corners_away, fouls_home, fouls_away,
      offsides_home, offsides_away, yellow_cards_home, yellow_cards_away,
      red_cards_home, red_cards_away, penalties_home, penalties_away,
      pass_accuracy_home, pass_accuracy_away,
      commentary_summary, tactical_summary, key_moments, source_urls)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)`,
    [data.match_id, data.home, data.away, data.home_score, data.away_score,
     toFloat(data.possession_home), toFloat(data.possession_away), toInt(data.shots_home), toInt(data.shots_away),
     toInt(data.shots_on_target_home), toInt(data.shots_on_target_away), toFloat(data.xg_home), toFloat(data.xg_away),
     toInt(data.corners_home), toInt(data.corners_away), toInt(data.fouls_home), toInt(data.fouls_away),
     toInt(data.offsides_home), toInt(data.offsides_away), toInt(data.yellow_cards_home), toInt(data.yellow_cards_away),
     toInt(data.red_cards_home), toInt(data.red_cards_away), toInt(data.penalties_home), toInt(data.penalties_away),
     toFloat(data.pass_accuracy_home), toFloat(data.pass_accuracy_away),
     data.commentary_summary, data.tactical_summary, data.key_moments, data.source_urls]
  );
}

async function getMatchAnalysis(matchId) {
  const { rows } = await pool.query(
    'SELECT * FROM match_analysis WHERE match_id = $1 ORDER BY recorded_at DESC LIMIT 1',
    [matchId]
  );
  return rows[0] || null;
}

async function getRecentAnalyses(team, limit = 3) {
  const { rows } = await pool.query(
    'SELECT * FROM match_analysis WHERE home = $1 OR away = $1 ORDER BY recorded_at DESC LIMIT $2',
    [team, limit]
  );
  return rows;
}

module.exports = {
  pool, init,
  getAllMatches, updateMatchTeams, getMatchesByDate, updateMatchStatus, getCompletedCountForDate, getTotalCountForDate,
  getCachedPrediction, cachePrediction,
  updateLastChecked, getLastChecked,
  invalidatePrediction, invalidateAllForTeam,
  getEloRating, getAllEloRatings, updateEloRating,
  saveMatchResult, getRecentResults,
  saveMatchAnalysis, getMatchAnalysis, getRecentAnalyses
};
