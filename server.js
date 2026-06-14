require('dotenv').config();
const express = require('express');
const path = require('path');
const { pool, init, getAllMatches, updateMatchTeams, getMatchesByDate, updateMatchStatus, getCompletedCountForDate, getTotalCountForDate, getCachedPrediction, cachePrediction, updateLastChecked, getLastChecked, invalidatePrediction, invalidateAllForTeam, getEloRating, updateEloRating, saveMatchResult, getRecentResults, saveMatchAnalysis, getMatchAnalysis, getRecentAnalyses } = require('./database');
const { loadAgents, loadWorkflow } = require('./agent-loader');
const { predictFromElo, calcEloUpdate } = require('./elo');
const https = require('https');

function deepseekChat(systemPrompt, userContent, maxTokens, temp) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      max_tokens: maxTokens || 1024,
      temperature: temp !== undefined ? temp : 0,
      stream: false
    });
    const req = https.request({
      hostname: 'api.deepseek.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.DEEPSEEK_API_KEY,
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 180000
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          const result = JSON.parse(body);
          if (result.choices && result.choices[0]) {
            resolve(result.choices[0].message.content);
          } else {
            reject(new Error('DeepSeek API error: ' + JSON.stringify(result)));
          }
        } catch (e) {
          reject(new Error('Failed to parse DeepSeek response: ' + body.substring(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(data);
    req.end();
  });
}

const app = express();
const PORT = process.env.PORT || 5051;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/api/version', (req, res) => {
  res.json({ version: '2.0-deepseek-raw', time: new Date().toISOString() });
});

// 生成全部日期（6月11日–7月20日），标注哪些有比赛，过滤已全部结束的日期
async function getMatchCalendar() {
  const allMatches = await await getAllMatches();
  const matchMap = {};
  allMatches.forEach(m => {
    if (!matchMap[m.date]) matchMap[m.date] = [];
    matchMap[m.date].push(m);
  });

  const result = [];
  const start = new Date(2026, 5, 12);  // 北京时间：首场揭幕战 6月12日 03:00
  const end = new Date(2026, 6, 20);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const month = d.getMonth() + 1;
    const day = d.getDate();
    const key = month + '月' + day + '日';
    const dayMatches = matchMap[key] || [];
    const hasMatches = dayMatches.length > 0;
    const completedCount = dayMatches.filter(m => m.status === 'completed').length;
    const allCompleted = hasMatches && completedCount === dayMatches.length;

    result.push({
      date: key,
      hasMatches,
      allCompleted,           // 当天全部比赛已结束
      matches: dayMatches
    });
  }
  return result;
}

// ── 页面路由 ──

app.get('/', async (req, res) => {
  autoRefreshKnockout();    // 后台自动检查淘汰赛更新
  detectCompletedMatches();  // 自动检测已结束比赛 → 存比分 → 抓赛后数据
  const calendar = await getMatchCalendar();
  const { rows: recent } = await pool.query('SELECT * FROM executions ORDER BY created_at DESC LIMIT 5');
  recent.forEach(r => { r.results = typeof r.results === 'string' ? JSON.parse(r.results) : r.results; });
  res.render('index', { calendar, recent });
});

app.get('/predict', (req, res) => {
  const { home, away, date, venue } = req.query;
  if (!home || !away) return res.redirect('/');
  res.render('predict', { home, away, date: date || '', venue: venue || '' });
});

app.get('/result/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM executions WHERE id = $1', [req.params.id]);
  const execution = rows[0];
  if (!execution) return res.status(404).send('记录不存在');
  execution.results = typeof execution.results === 'string' ? JSON.parse(execution.results) : execution.results;
  res.render('result', { execution });
});

// ── API ──

app.get('/api/matches', async (req, res) => {
  res.json(await getMatchCalendar());
});

app.get('/api/agents', (req, res) => {
  res.json(loadAgents());
});

app.get('/api/executions', async (req, res) => {
  const { rows: list } = await pool.query('SELECT * FROM executions ORDER BY created_at DESC LIMIT 20');
  list.forEach(r => { r.results = typeof r.results === 'string' ? JSON.parse(r.results) : r.results; });
  res.json(list);
});

app.post('/api/predict', async (req, res) => {
  const { teamA, teamB, matchDate, venue, force } = req.body;
  if (!teamA || !teamB) return res.status(400).json({ error: '请填写两支球队名称' });

  // 非强制模式下，检查是否已有缓存预测
  if (!force) {
    const cached = await getCachedPrediction(teamA, teamB);
    if (cached) {
      // 有缓存，先检测是否有重大新闻需要清缓存
      const majorNews = await checkForMajorNews(teamA, teamB);
      if (!majorNews) {
        // 更新时间戳，让这次预测排到最近预测顶端
        await pool.query('UPDATE executions SET created_at = NOW() WHERE id = $1', [cached.id]);
        cached.results = typeof cached.results === 'string' ? JSON.parse(cached.results) : cached.results;
        return res.json({ executionId: cached.id, status: cached.status });
      }
      // 有重大新闻，缓存已清，继续走完整预测流程
    }
  }

  const agents = loadAgents();
  const agentMap = {};
  agents.forEach(a => { agentMap[a.name] = a; });

  const workflow = loadWorkflow();

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await pool.query(
    'INSERT INTO executions (id, team_a, team_b, match_date, venue, status) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, teamA, teamB, matchDate || '', venue || '', 'running']
  );

  // 缓存此次预测（team_a, team_b → execution_id）
  await cachePrediction(teamA, teamB, id);

  runWorkflow(id, teamA, teamB, matchDate, venue, agents, agentMap, workflow).catch(async err => {
    console.error('Workflow error:', err);
    const { rows } = await pool.query('SELECT results FROM executions WHERE id = $1', [id]);
    if (rows.length > 0) {
      const arr = typeof rows[0].results === 'string' ? JSON.parse(rows[0].results) : rows[0].results;
      arr.push({ agentName: '系统', status: 'failed', output: err.message });
      await pool.query('UPDATE executions SET status=$1, results=$2, completed_at=NOW() WHERE id=$3',
        ['failed', JSON.stringify(arr), id]);
    }
  });

  res.json({ executionId: id, status: 'running' });
});

app.get('/api/executions/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM executions WHERE id = $1', [req.params.id]);
  const execution = rows[0];
  if (!execution) return res.status(404).json({ error: 'Not found' });
  execution.results = typeof execution.results === 'string' ? JSON.parse(execution.results) : execution.results;
  res.json(execution);
});

// ── 淘汰赛赛程自动更新 ──

let lastAutoRefresh = 0;
const AUTO_REFRESH_INTERVAL = 6 * 60 * 60 * 1000; // 每6小时最多自动检查一次

async function autoRefreshKnockout() {
  const now = Date.now();
  if (now - lastAutoRefresh < AUTO_REFRESH_INTERVAL) return;
  lastAutoRefresh = now;

  try {
    const allMatches = await await getAllMatches();
    const placeholders = allMatches.filter(m =>
      m.home.includes('胜者') || m.home.includes('败者') ||
      m.home.includes('组') || m.away.includes('组') ||
      m.away.includes('胜者') || m.away.includes('败者')
    );
    if (placeholders.length === 0) return; // 全部已确定，无需刷新

    console.log('  [自动刷新] 检测到', placeholders.length, '场待定赛程，开始搜索...');

    const now2 = new Date();
    const dateStr = `${now2.getFullYear()}年${now2.getMonth() + 1}月`;
    const dateStrEN = `${now2.toLocaleString('en-US', { month: 'long' })} ${now2.getFullYear()}`;
    const searchResult = await searchTavily(
      `2026 World Cup knockout round 16 8 quarter final confirmed teams results ${dateStrEN}`,
      3
    );

    if (!searchResult || searchResult.results.length === 0) return;

    let newsText = searchResult.answer || '';
    newsText += '\n' + searchResult.results.map(r => `- ${r.title}: ${r.content}`).join('\n');

    const reply = await deepseekChat(
      '你是世界杯赛程数据提取器。从新闻中提取已确认的淘汰赛对阵。只提取官方确认的比赛结果和晋级球队。输出JSON数组，每项格式：{"stage":"阶段","date":"日期","home":"球队A","away":"球队B"}。stage用中文：1/16决赛、1/8决赛、1/4决赛、半决赛、三四名决赛、决赛。如果没有找到任何确认的对阵，输出空数组[]。',
      `当前待更新的淘汰赛占位：\n${placeholders.map(m => `[${m.id}] ${m.date} ${m.stage}: ${m.home} vs ${m.away}`).join('\n')}\n\n最新新闻：\n${newsText.substring(0, 4000)}`,
      1024, 0
    );
    const jsonMatch = reply.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return;

    const updates = JSON.parse(jsonMatch[0]);
    let updated = 0;
    for (const update of updates) {
      const match = allMatches.find(m =>
        m.date === update.date && m.stage === update.stage &&
        (m.home.includes('胜者') || m.home.includes('败者') || m.home.includes('组'))
      );
      if (match) {
        await updateMatchTeams(match.id, update.home, update.away);
        updated++;
      }
    }
    if (updated > 0) console.log('  [自动刷新] 成功更新', updated, '场比赛');
  } catch (err) {
    console.error('  [自动刷新] 失败:', err.message);
  }
}

// ── 比赛结果自动检测 ──

async function detectCompletedMatches() {
  try {
    const allMatches = await getAllMatches();
    const upcoming = allMatches.filter(m =>
      m.status === 'upcoming' && !m.home.includes('组') && !m.home.includes('胜者') && !m.home.includes('败者') &&
      !m.away.includes('组') && !m.away.includes('胜者') && !m.away.includes('败者')
    );

    if (upcoming.length === 0) return;

    const now = new Date();
    const today = `${now.getMonth() + 1}月${now.getDate()}日`;
    const dateEN = `${now.toLocaleString('en-US', { month: 'long' })} ${now.getDate()}, ${now.getFullYear()}`;

    // 只检查今天及之前日期的比赛
    const dueMatches = upcoming.filter(m => {
      const mParts = m.date.match(/(\d+)月(\d+)日/);
      if (!mParts) return false;
      const tParts = today.match(/(\d+)月(\d+)日/);
      if (!tParts) return false;
      const mVal = parseInt(mParts[1]) * 100 + parseInt(mParts[2]);
      const tVal = parseInt(tParts[1]) * 100 + parseInt(tParts[2]);
      return mVal <= tVal;
    });

    if (dueMatches.length === 0) return;

    console.log('  [自动检测] 检查', dueMatches.length, '场比赛...');

    let updated = 0;
    for (let i = 0; i < dueMatches.length; i += 3) {
      const batch = dueMatches.slice(i, i + 3);
      const batchResults = await Promise.all(batch.map(async (match) => {
        const queries = [
          { label: 'EN', q: `"${match.home}" "${match.away}" World Cup 2026 final score result ${dateEN}`, days: 3 },
          { label: 'ZH', q: `${match.home} ${match.away} 世界杯 最终比分 比赛结果 ${match.date}`, days: 3 },
        ];
        const searches = await Promise.all(queries.map(q => searchTavily(q.q, q.days)));
        const hasResults = searches.some(s => s && s.results.length > 0);
        return { match, searches, hasResults };
      }));

      for (const { match, searches, hasResults } of batchResults) {
        if (!hasResults) { console.log('  [自动检测]', match.home, 'vs', match.away, '— 暂无结果'); continue; }

        // 优先用 Tavily Answer（聚合结果更可靠）
        let newsText = '';
        for (const s of searches) {
          if (!s) continue;
          if (s.answer) newsText = '【TAVILY ANSWER】\n' + s.answer + '\n\n' + newsText;
          newsText += s.results.map(r => `- ${r.title}: ${(r.content || '').substring(0, 400)}`).join('\n') + '\n';
        }

        const reply = await deepseekChat(
          `你是比赛结果提取器。严格判断：
- 只有新闻中明确出现"最终比分""Full-time""FT""比赛结束"等字样+具体比分（如2-1）才确认比赛已结束
- 赛前预测/前瞻/首发/赔率新闻绝对不能标记为completed
- 如果新闻都在讨论"即将""预计""前瞻""preview"，输出completed:false
- 不确定就输出false（宁可漏判不要误判）
输出严格的JSON：{"completed":true或false,"score":"X-X"或null}`,
          `${match.date} ${match.home} vs ${match.away}\n\n${newsText.substring(0, 4000)}`,
          256, 0
        );

        try {
          const jsonMatch = reply.match(/\{[\s\S]*\}/);
          if (!jsonMatch) continue;
          const r = JSON.parse(jsonMatch[0]);
          if (!r.completed || !r.score) continue;

          await updateMatchStatus(match.id, 'completed');
          const [homeScore, awayScore] = r.score.split('-').map(Number);
          if (isNaN(homeScore) || isNaN(awayScore)) continue;

          const saved = await saveMatchResult(match.id, match.date, match.home, match.away, homeScore, awayScore, match.stage);
          if (saved) {
            console.log('  [自动检测] ✅', match.date, match.home, homeScore, '-', awayScore, match.away);
            const eloA = await getEloRating(match.home);
            const eloB = await getEloRating(match.away);
            const update = calcEloUpdate(eloA, eloB, homeScore, awayScore, match.venue, match.home, match.away);
            await updateEloRating(match.home, update.newEloA);
            await updateEloRating(match.away, update.newEloB);
            console.log('  [ELO]', match.home, eloA, '→', update.newEloA, '|', match.away, eloB, '→', update.newEloB);
            // 立即抓取赛后详细数据
            gatherMatchPerformance(match.id, match.home, match.away, homeScore, awayScore, match.date).catch(e =>
              console.error('  [赛后数据] 抓取失败:', match.home, 'vs', match.away, e.message));
            updated++;
          }
        } catch (e) { console.error('  [自动检测] 解析失败:', e.message); }
      }
    }
    if (updated > 0) console.log('  [自动检测] 共更新', updated, '场比赛');
  } catch (err) {
    console.error('  [自动检测] 失败:', err.message);
  }
}

app.post('/api/matches/refresh', async (req, res) => {
  try {
    const allMatches = await await getAllMatches();
    const placeholders = allMatches.filter(m =>
      m.home.includes('胜者') || m.home.includes('败者') ||
      m.home.includes('组') || m.away.includes('组') ||
      m.away.includes('胜者') || m.away.includes('败者')
    );

    if (placeholders.length === 0) {
      return res.json({ updated: 0, message: '所有赛程已确定，无需更新' });
    }

    const now = new Date();
    const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月`;

    // 搜索最新淘汰赛对阵
    const searchResult = await searchTavily(
      `2026 世界杯 淘汰赛 对阵 ${dateStr} 16强 8强 晋级 结果`,
      3
    );

    if (!searchResult || searchResult.results.length === 0) {
      return res.json({ updated: 0, message: '未搜索到淘汰赛最新信息，请稍后再试' });
    }

    let newsText = searchResult.answer || '';
    newsText += '\n' + searchResult.results.map(r => `- ${r.title}: ${r.content}`).join('\n');

    // 让 Claude 提取已确定的淘汰赛对阵
    const reply = await deepseekChat(
      '你是世界杯赛程数据提取器。从新闻中提取已确认的淘汰赛对阵。只提取官方确认的比赛结果和晋级球队。输出JSON数组，每项格式：{"stage":"阶段","date":"日期","home":"球队A","away":"球队B"}。stage用中文：1/16决赛、1/8决赛、1/4决赛、半决赛、三四名决赛、决赛。如果没有找到任何确认的对阵，输出空数组[]。',
      `当前待更新的淘汰赛占位：\n${placeholders.map(m => `[${m.id}] ${m.date} ${m.stage}: ${m.home} vs ${m.away}`).join('\n')}\n\n最新新闻：\n${newsText.substring(0, 4000)}`,
      1024, 0
    );
    console.log('  [赛程更新] DeepSeek 回复:', reply.substring(0, 300));

    // 解析 JSON 回复
    const jsonMatch = reply.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return res.json({ updated: 0, message: '未能解析出有效的对阵信息，请稍后再试', raw: reply.substring(0, 200) });
    }

    const updates = JSON.parse(jsonMatch[0]);
    let updated = 0;

    for (const update of updates) {
      // 找到匹配的占位符（按日期+阶段匹配）
      const match = allMatches.find(m =>
        m.date === update.date && m.stage === update.stage &&
        (m.home.includes('胜者') || m.home.includes('败者') || m.home.includes('组'))
      );
      if (match) {
        await updateMatchTeams(match.id, update.home, update.away);
        console.log(`  [赛程更新] #${match.id} ${update.date} ${update.stage}: ${update.home} vs ${update.away}`);
        updated++;
      }
    }

    res.json({ updated, message: `成功更新 ${updated} 场比赛`, details: updates });
  } catch (err) {
    console.error('  [赛程更新] 失败:', err.message);
    res.status(500).json({ error: '刷新失败: ' + err.message });
  }
});

// 手动更新某场比赛的队名
app.post('/api/matches/update', async (req, res) => {
  const { id, home, away } = req.body;
  if (!id || !home || !away) return res.status(400).json({ error: '缺少 id/home/away' });
  await updateMatchTeams(id, home, away);
  res.json({ success: true, id, home, away });
});

// 手动触发比赛结果检测（仅管理员使用，自动检测不可靠已禁用）
app.get('/api/matches/detect-completed', async (req, res) => {
  try {
    await detectCompletedMatches();
    const { rows: results } = await pool.query('SELECT * FROM match_results ORDER BY recorded_at DESC LIMIT 10');
    res.json({ success: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 手动录入比分 + 自动搜集赛后详细分析
app.post('/api/matches/score', async (req, res) => {
  try {
    const { matchId, homeScore, awayScore } = req.body;
    if (!matchId || homeScore === undefined || awayScore === undefined) {
      return res.status(400).json({ error: '缺少 matchId / homeScore / awayScore' });
    }
    // 获取比赛信息
    const { rows: matches } = await pool.query('SELECT * FROM matches WHERE id = $1', [matchId]);
    if (matches.length === 0) return res.status(404).json({ error: '比赛不存在' });
    const m = matches[0];

    // 保存结果
    const home = parseInt(homeScore), away = parseInt(awayScore);
    if (isNaN(home) || isNaN(away)) return res.status(400).json({ error: '比分必须是数字' });

    await updateMatchStatus(matchId, 'completed');
    const saved = await saveMatchResult(matchId, m.date, m.home, m.away, home, away, m.stage);

    // ELO 更新
    let eloResult = null;
    if (saved) {
      const eloA = await getEloRating(m.home);
      const eloB = await getEloRating(m.away);
      const update = calcEloUpdate(eloA, eloB, home, away, m.venue, m.home, m.away);
      await updateEloRating(m.home, update.newEloA);
      await updateEloRating(m.away, update.newEloB);
      await invalidateAllForTeam(m.home);
      await invalidateAllForTeam(m.away);
      eloResult = { home: { old: eloA, new: update.newEloA }, away: { old: eloB, new: update.newEloB } };
    }

    // 异步搜集赛后详细分析（不阻塞响应）
    gatherMatchPerformance(matchId, m.home, m.away, home, away, m.date).catch(e =>
      console.error('  [赛后分析] 搜集失败:', e.message));

    res.json({ success: true, match: { home: m.home, away: m.away, homeScore: home, awayScore: away }, elo: eloResult, message: saved ? '比分已录入' : '该比赛已录入过' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 赛后详细表现数据搜集
async function gatherMatchPerformance(matchId, home, away, homeScore, awayScore, matchDate) {
  console.log(`  [赛后分析] 开始搜集 ${home} vs ${away} 详细数据...`);
  const now = new Date();
  const dateEN = `${now.toLocaleString('en-US', { month: 'long' })} ${now.getFullYear()}`;

  // 赛后详细数据搜索 — 中文体育数据站(球迷屋/捷报/网易)有文字版统计表
  const queries = [
    { label: '中文数据站', q: `site:qiumiwu.com OR site:jbb.cn OR site:sports.163.com ${home} ${away} 世界杯 全场数据 控球率 射门 射正 角球`, days: 5 },
    { label: '中文统计', q: `${home} ${away} 世界杯 技术统计 赛后数据 控球率 射门 传球`, days: 5 },
    { label: '英文统计', q: `\"${home}\" \"${away}\" ${homeScore}-${awayScore} World Cup 2026 match stats possession shots xG ESPN`, days: 5 },
    { label: '赛后分析', q: `${home} vs ${away} World Cup 2026 match report post-match analysis`, days: 5 },
  ];

  const results = await Promise.all(queries.map(q => searchTavily(q.q, q.days)));

  // Tavily Answer 放最前面（最精炼），然后是各搜索结果
  let allText = '';
  for (let i = 0; i < queries.length; i++) {
    if (!results[i]) continue;
    if (results[i].answer) allText = '【TAVILY SUMMARY】\n' + results[i].answer + '\n\n' + allText;
    allText += results[i].results.map(r => `- ${r.title}: ${(r.content || '').substring(0, 500)}`).join('\n') + '\n';
  }

  if (!allText.trim()) {
    console.log(`  [赛后分析] ${home} vs ${away} 未搜到详细数据`);
    return;
  }

  // 用 DeepSeek 提取结构化数据
  const extractionPrompt = `你是数据提取器。从报道中提取${home}(${homeScore}) vs ${away}(${awayScore})的比赛统计。

规则：只提取明确出现的数字，没有就null。输出严格JSON：
{"possession_home":数字或null,"possession_away":数字或null,"shots_home":数字或null,"shots_away":数字或null,"shots_on_target_home":数字或null,"shots_on_target_away":数字或null,"xg_home":数字或null,"xg_away":数字或null,"corners_home":数字或null,"corners_away":数字或null,"fouls_home":数字或null,"fouls_away":数字或null,"offsides_home":数字或null,"offsides_away":数字或null,"yellow_cards_home":数字或null,"yellow_cards_away":数字或null,"red_cards_home":数字或null,"red_cards_away":数字或null,"penalties_home":数字或null,"penalties_away":数字或null,"pass_accuracy_home":数字或null,"pass_accuracy_away":数字或null,"commentary_summary":null或"解说","tactical_summary":null或"战术","key_moments":null或"关键瞬间","source_urls":null或"URL"}`;

  try {
    const reply = await deepseekChat(extractionPrompt,
      `${home} ${homeScore}-${awayScore} ${away} (${matchDate})\n\n赛后报道：\n${allText.substring(0, 10000)}`,
      1024, 0);
    const jsonMatch = reply.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { console.log('  [赛后分析] DeepSeek未返回有效JSON'); return; }

    const data = JSON.parse(jsonMatch[0]);
    await saveMatchAnalysis({
      match_id: matchId,
      home, away, home_score: homeScore, away_score: awayScore,
      possession_home: data.possession_home, possession_away: data.possession_away,
      shots_home: data.shots_home, shots_away: data.shots_away,
      shots_on_target_home: data.shots_on_target_home, shots_on_target_away: data.shots_on_target_away,
      xg_home: data.xg_home, xg_away: data.xg_away,
      corners_home: data.corners_home, corners_away: data.corners_away,
      fouls_home: data.fouls_home, fouls_away: data.fouls_away,
      offsides_home: data.offsides_home, offsides_away: data.offsides_away,
      yellow_cards_home: data.yellow_cards_home, yellow_cards_away: data.yellow_cards_away,
      red_cards_home: data.red_cards_home, red_cards_away: data.red_cards_away,
      penalties_home: data.penalties_home, penalties_away: data.penalties_away,
      pass_accuracy_home: data.pass_accuracy_home, pass_accuracy_away: data.pass_accuracy_away,
      commentary_summary: data.commentary_summary,
      tactical_summary: data.tactical_summary,
      key_moments: data.key_moments,
      source_urls: data.source_urls
    });
    console.log(`  [赛后分析] ✅ ${home} vs ${away} 详细数据已保存`);
  } catch (e) {
    console.error('  [赛后分析] 解析失败:', e.message);
  }
}

// 管理员页面
// 重置比赛比分（修改前先清除旧记录）
app.post('/api/matches/reset-score', async (req, res) => {
  try {
    const { matchId } = req.body;
    if (!matchId) return res.status(400).json({ error: '缺少 matchId' });
    await pool.query('DELETE FROM match_results WHERE match_id = $1', [matchId]);
    await pool.query('DELETE FROM match_analysis WHERE match_id = $1', [matchId]);
    await pool.query('UPDATE matches SET status = $1 WHERE id = $2', ['upcoming', matchId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin', async (req, res) => {
  const allMatches = await getAllMatches();
  const { rows: results } = await pool.query('SELECT * FROM match_results ORDER BY recorded_at DESC');
  const resultMap = {};
  results.forEach(r => { resultMap[r.match_id] = r; });

  // 按日期分组
  const grouped = {};
  allMatches.forEach(m => {
    const r = resultMap[m.id];
    if (!grouped[m.date]) grouped[m.date] = [];
    grouped[m.date].push({ ...m, result: r || null });
  });

  res.render('admin', { grouped, resultMap });
});

// ── 实时搜索（Tavily API）──

const TAVILY_KEY = process.env.TAVILY_API_KEY || '';

async function searchTavily(query, days) {
  const https = require('https');
  return new Promise((resolve) => {
    const body = {
      api_key: TAVILY_KEY,
      query,
      search_depth: 'advanced',
      max_results: 10,
      include_answer: true
    };
    if (days) body.days = days;
    const req = https.request({
      hostname: 'api.tavily.com',
      path: '/search',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(body)) },
      timeout: 15000
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const data = Buffer.concat(chunks).toString('utf8');
          const json = JSON.parse(data);
          resolve({
            answer: json.answer || '',
            results: (json.results || []).slice(0, 10).map(r => ({
              title: r.title || '',
              url: r.url || '',
              content: (r.content || '').substring(0, 800)
            }))
          });
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function gatherRealtimeIntel(teamA, teamB, matchDate) {
  const now = new Date();
  const month = now.getMonth() + 1;
  const dateStrZH = `${now.getFullYear()}年${month}月`;
  const dateStrEN = `${now.toLocaleString('en-US', { month: 'long' })} ${now.getFullYear()}`;

  // 中英双语搜索，每队各两个维度（综合阵容+伤病专项）
  const queries = [
    // 中文搜索
    { label: `${teamA} 近况(中)`, q: `${teamA} ${dateStrZH} 世界杯 最新阵容 伤病 首发 缺阵`, days: 7 },
    { label: `${teamB} 近况(中)`, q: `${teamB} ${dateStrZH} 世界杯 最新阵容 伤病 首发 缺阵`, days: 7 },
    // 英文搜索（主力来源）
    { label: `${teamA} News (EN)`, q: `${teamA} ${dateStrEN} World Cup 2026 latest squad lineup injury news`, days: 7 },
    { label: `${teamB} News (EN)`, q: `${teamB} ${dateStrEN} World Cup 2026 latest squad lineup injury news`, days: 7 },
    // 伤病专项搜索
    { label: `${teamA} 伤病专项`, q: `"${teamA}" injury absent out miss World Cup 2026 ${dateStrEN}`, days: 7 },
    { label: `${teamB} 伤病专项`, q: `"${teamB}" injury absent out miss World Cup 2026 ${dateStrEN}`, days: 7 },
    // 裁判专项搜索
    { label: '裁判信息(中)', q: `${teamA} vs ${teamB} 裁判 主裁判 执法 ${dateStrZH} 世界杯`, days: 7 },
    { label: 'Referee (EN)', q: `${teamA} ${teamB} referee appointed official World Cup 2026 ${dateStrEN}`, days: 7 },
    // 交锋记录（不限时间）
    { label: '交锋记录', q: `${teamA} vs ${teamB} head to head history result 2026 World Cup`, days: null },
  ];

  const results = await Promise.all(queries.map(q => searchTavily(q.q, q.days)));

  const parts = [];
  for (let i = 0; i < queries.length; i++) {
    if (results[i] && results[i].results.length > 0) {
      const r = results[i];
      let text = '';
      if (r.answer) text += r.answer + '\n';
      text += r.results.map(r => `- ${r.title}: ${r.content}`).join('\n');
      parts.push(`【${queries[i].label}】\n${text}`);
    }
  }

  return parts.length > 0
    ? `\n\n==== 实时搜索情报（Tavily API）====\n${parts.join('\n\n')}\n==== 搜索情报结束 ====\n`
    : '';
}

// ── ELO 伤病量化 ──

async function quantifyEloAdjustment(teamA, teamB, intelText) {
  if (!intelText) return { adjustA: 0, adjustB: 0, reason: '无情报，不调整' };

  try {
    const reply = await deepseekChat(
      `你是足球ELO评分调整专家。基于情报中的伤病/停赛信息，量化ELO调整值。

关键：你必须用你的足球知识判断情报中提到的每个球员属于球队A还是球队B。例如内马尔、维尼修斯属于巴西；阿什拉夫、齐耶赫属于摩洛哥。情报中提到某队球员的伤病，就必须对该队扣分。

规则：
- 仅根据"确认缺席/赛季报销/确定无缘/缺阵/不会上场/miss/out/absent"的球员扣分。"可能""疑似""出战成疑/doubtful"不扣分
- 一门确认缺席: -40~-50
- 队长/防线核心确认缺席: -30~-40
- 头号射手确认缺席: -30~-40
- 主力中场/边锋确认缺席: -20~-30 (每人)
- 多名主力缺席可累加，但单队上限 -80
- 球员伤愈复出/确认回归: +20~+30
- 没有确认缺席则 adjust 均为 0

输出严格JSON，不要其他文字：
{"adjustA":-XX,"adjustB":-YY,"reason":"球队A: xxx; 球队B: xxx"}`,
      `球队A：${teamA}\n球队B：${teamB}\n\n情报：\n${intelText.substring(0, 3000)}`,
      100, 0
    );
    console.log(`  [ELO调整] DeepSeek回复: ${reply}`);

    const jsonMatch = reply.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      parsed.adjustA = parseInt(parsed.adjustA) || 0;
      parsed.adjustB = parseInt(parsed.adjustB) || 0;
      console.log(`  [ELO调整] ${teamA}: ${parsed.adjustA}, ${teamB}: ${parsed.adjustB} — ${parsed.reason}`);
      return { adjustA: parsed.adjustA, adjustB: parsed.adjustB, reason: parsed.reason || '' };
    }
  } catch (e) {
    console.error('  [ELO调整] 失败:', e.message);
  }
  return { adjustA: 0, adjustB: 0, reason: '解析失败' };
}

// ── 重大新闻检测（缓存失效）──

const NEWS_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000; // 同一场比赛每2小时最多检查一次

async function checkForMajorNews(teamA, teamB) {
  const lastChecked = await getLastChecked(teamA, teamB);
  if (lastChecked) {
    const elapsed = Date.now() - new Date(lastChecked + '+08:00').getTime();
    if (elapsed < NEWS_CHECK_INTERVAL_MS) {
      console.log(`  [新闻检查] ${teamA} vs ${teamB} 距上次检查不足2小时，跳过`);
      return false;
    }
  }

  console.log(`  [新闻检查] 正在检查 ${teamA} vs ${teamB} 的重大新闻...`);

  // 搜索两队近期重大新闻（中英双语）
  const now = new Date();
  const dateStrZH = `${now.getFullYear()}年${now.getMonth() + 1}月`;
  const dateStrEN = `${now.toLocaleString('en-US', { month: 'long' })} ${now.getFullYear()}`;
  const queries = [
    `${teamA} ${dateStrZH} 世界杯 突发 伤病 停赛 退出 缺阵`,
    `${teamB} ${dateStrZH} 世界杯 突发 伤病 停赛 退出 缺阵`,
    `"${teamA}" injury out absent World Cup 2026 ${dateStrEN}`,
    `"${teamB}" injury out absent World Cup 2026 ${dateStrEN}`,
  ];

  const results = await Promise.all(queries.map(q => searchTavily(q, 7)));
  const newsText = results
    .filter(r => r && r.results.length > 0)
    .map(r => {
      let text = r.answer || '';
      text += '\n' + r.results.map(n => `- ${n.title}: ${n.content}`).join('\n');
      return text;
    })
    .join('\n\n');

  await updateLastChecked(teamA, teamB);

  if (!newsText.trim()) {
    console.log('  [新闻检查] 无相关新闻，保留缓存');
    return false;
  }

  // 让 Claude 判断是否为重大变故
  try {
    const verdict = await deepseekChat(
      '你是足球赛事分析师。判断是否有"已确认的"重大变故会显著改变预测。严格标准：只有官方确认的核心球员（头号球星/队长/主力射手/一门）"确定缺席"本轮才算。以下全部算MINOR：任何"可能""疑似""出战成疑""或"的表述、角色球员、媒体猜测、训练日常、战术调整、换帅传闻。宁愿漏判也不能错判——只要有一丝不确定就选MINOR。只回复一个词：MAJOR_A / MAJOR_B / MAJOR_BOTH / MINOR。',
      `球队A：${teamA}\n球队B：${teamB}\n\n最新新闻：\n${newsText.substring(0, 3000)}`,
      50, 0
    );
    console.log(`  [新闻检查] DeepSeek 判定: ${verdict}`);

    if (verdict.includes('MAJOR_BOTH')) {
      console.log(`  [新闻检查] ⚠️ 两队均有重大变故！清除 ${teamA} 和 ${teamB} 所有相关预测`);
      await invalidateAllForTeam(teamA);
      await invalidateAllForTeam(teamB);
      return true;
    }
    if (verdict.includes('MAJOR_A')) {
      console.log(`  [新闻检查] ⚠️ ${teamA} 有重大变故！清除其所有相关预测`);
      await invalidateAllForTeam(teamA);
      return true;
    }
    if (verdict.includes('MAJOR_B')) {
      console.log(`  [新闻检查] ⚠️ ${teamB} 有重大变故！清除其所有相关预测`);
      await invalidateAllForTeam(teamB);
      return true;
    }

    return false;
  } catch (err) {
    console.error('  [新闻检查] Claude 调用失败:', err.message);
    return false; // 出错时保留缓存，安全优先
  }
}

// ── 执行引擎 ──

async function runWorkflow(id, teamA, teamB, matchDate, venue, agents, agentMap, workflow) {

  const allResults = [];
  const input = `球队A：${teamA}\n球队B：${teamB}\n比赛时间：${matchDate || '未指定'}\n比赛地点：${venue || '未指定'}`;

  async function saveResults() {
    await pool.query('UPDATE executions SET results = $1 WHERE id = $2',
      [JSON.stringify(allResults), id]);
  }

  // 1. 预搜索实时情报
  let realtimeIntel = '';
  try {
    realtimeIntel = await gatherRealtimeIntel(teamA, teamB, matchDate);
    if (realtimeIntel) console.log('  [搜索] 实时情报已获取');
  } catch (e) {
    console.error('  [搜索] 失败:', e.message);
  }

  // 2. 情报 → ELO 量化调整
  const eloAdj = await quantifyEloAdjustment(teamA, teamB, realtimeIntel);

  // 3. 获取动态ELO (数据库 → 覆盖静态JSON) + 近期比赛结果
  const [dbEloA, dbEloB, recentA, recentB] = await Promise.all([
    getEloRating(teamA), getEloRating(teamB),
    getRecentResults(teamA, 5), getRecentResults(teamB, 5)
  ]);
  const eloData = {}; eloData[teamA] = dbEloA; eloData[teamB] = dbEloB;

  // 计算 ELO 基线（含伤病调整 + 数据库ELO）
  const eloBaseline = predictFromElo(teamA, teamB, venue || '', eloAdj.adjustA, eloAdj.adjustB, eloData);

  // 近期比赛结果文本（含赛事详细数据）
  let recentResultsText = '';
  if (recentA.length > 0 || recentB.length > 0) {
    // 获取近期比赛的详细分析数据
    const [analysesA, analysesB] = await Promise.all([
      getRecentAnalyses(teamA, 3),
      getRecentAnalyses(teamB, 3)
    ]);
    const analysisMap = {};
    [...(analysesA || []), ...(analysesB || [])].forEach(a => {
      if (a) analysisMap[`${a.home}_${a.away}`] = a;
    });

    const formatResults = (team, results) => {
      if (results.length === 0) return `${team}: 无近期比赛记录`;
      return results.map(r => {
        const isHome = r.home === team;
        const myScore = isHome ? r.home_score : r.away_score;
        const oppScore = isHome ? r.away_score : r.home_score;
        const opp = isHome ? r.away : r.home;
        const result = myScore > oppScore ? '胜' : myScore < oppScore ? '负' : '平';

        let line = `${r.date} ${r.stage}: ${team} ${myScore}-${oppScore} ${opp} (${result})`;

        // 附上详细比赛数据
        const analysis = analysisMap[`${r.home}_${r.away}`];
        if (analysis) {
          const parts = [];
          if (analysis.possession_home !== null) parts.push(`控球 ${analysis.possession_home}%-${analysis.possession_away}%`);
          if (analysis.shots_home !== null) parts.push(`射门 ${analysis.shots_home}-${analysis.shots_away}`);
          if (analysis.shots_on_target_home !== null) parts.push(`射正 ${analysis.shots_on_target_home}-${analysis.shots_on_target_away}`);
          if (analysis.xg_home !== null) parts.push(`xG ${analysis.xg_home}-${analysis.xg_away}`);
          if (analysis.corners_home !== null) parts.push(`角球 ${analysis.corners_home}-${analysis.corners_away}`);
          if (analysis.fouls_home !== null) parts.push(`犯规 ${analysis.fouls_home}-${analysis.fouls_away}`);
          if (analysis.offsides_home !== null) parts.push(`越位 ${analysis.offsides_home}-${analysis.offsides_away}`);
          if (analysis.yellow_cards_home !== null) parts.push(`黄牌 ${analysis.yellow_cards_home}-${analysis.yellow_cards_away}`);
          if (analysis.red_cards_home !== null) parts.push(`红牌 ${analysis.red_cards_home}-${analysis.red_cards_away}`);
          if (analysis.penalties_home !== null) parts.push(`点球 ${analysis.penalties_home}-${analysis.penalties_away}`);
          if (analysis.pass_accuracy_home !== null) parts.push(`传球 ${analysis.pass_accuracy_home}%-${analysis.pass_accuracy_away}%`);
          if (parts.length > 0) line += `\n  📊 ${parts.join(' | ')}`;
          if (analysis.tactical_summary) line += `\n  🧠 战术: ${analysis.tactical_summary}`;
          if (analysis.commentary_summary) line += `\n  🎙️ 解说: ${analysis.commentary_summary}`;
          if (analysis.key_moments) line += `\n  ⚡ 关键: ${analysis.key_moments}`;
        }

        return line;
      }).join('\n\n');
    };
    recentResultsText = `\n\n==== 🆕 近期比赛结果（最新最重要，含详细赛后数据）====\n${formatResults(teamA, recentA)}\n\n${formatResults(teamB, recentB)}\n==== 近期结果结束 ====\n`;
  }

  const eloBlock = `
==== ELO 量化基线 ====
- ${teamA} 当前 ELO: ${dbEloA}${eloAdj.adjustA !== 0 ? ` → 伤病调整 ${eloAdj.adjustA} → 有效 ELO: ${eloBaseline.eloARaw}` : ''}
- ${teamB} 当前 ELO: ${dbEloB}${eloAdj.adjustB !== 0 ? ` → 伤病调整 ${eloAdj.adjustB} → 有效 ELO: ${eloBaseline.eloBRaw}` : ''}
- ${eloBaseline.homeAdvantage ? `主场加成: ${eloBaseline.homeAdvantage} +100` : '中立场'}
- ELO 差值: ${eloBaseline.eloDiff > 0 ? `${teamA} 高 ${eloBaseline.eloDiff} 分` : `${teamB} 高 ${-eloBaseline.eloDiff} 分`}
- 调整原因: ${eloAdj.reason}
- 预期进球 (xG): ${teamA} ${eloBaseline.xgA} — ${teamB} ${eloBaseline.xgB}
- 胜平负概率: ${teamA}胜 ${eloBaseline.homeWinProb}% / 平 ${eloBaseline.drawProb}% / ${teamB}胜 ${eloBaseline.awayWinProb}%
- 量化模型最可能比分: ${eloBaseline.mostLikely.map(s => `${s.score} (${s.prob}%)`).join(', ')}
==== ELO 基线结束 ====

⚠️ ELO 基线已综合伤病调整。近期比赛结果见上方，优先参考最近比赛的实际表现来判断偏离。`;
  // ═══ ELO 基线结束 ═══

  const nodeMap = {};
  for (const n of workflow.nodes) nodeMap[n.name] = n;

  const executed = new Set();

  while (executed.size < workflow.nodes.length) {
    const ready = workflow.nodes.filter(n => {
      if (executed.has(n.name)) return false;
      return (n.dependsOn || []).every(dep => executed.has(dep));
    });

    for (const node of ready) {
      const agent = agents.find(a => a.name === node.agent);
      if (!agent) {
        allResults.push({ agentName: node.name, status: 'failed', output: 'Agent配置未找到' });
        saveResults();
        executed.add(node.name);
        continue;
      }

      const resultEntry = { agentName: node.name, status: 'running', output: null };
      allResults.push(resultEntry);
      saveResults();

      // recentResultsText 放在最前面，确保不被长文本淹没
      let agentInput = input + recentResultsText + eloBlock;
      const isFirstAgent = executed.size === 0;
      if (isFirstAgent && realtimeIntel) {
        agentInput = input + recentResultsText + realtimeIntel + eloBlock;
      }

      const upstreams = allResults.filter(r => {
        const n = workflow.nodes.find(wn => wn.name === r.agentName);
        return n && (node.dependsOn || []).includes(n.name);
      });
      if (upstreams.length > 0) {
        const upstreamText = upstreams.map(u => u.output || '').filter(Boolean).join('\n\n---\n\n');
        if (upstreamText) {
          agentInput = `${input}\n\n${recentResultsText}\n\n==== 上游Agent分析结果 ====\n${upstreamText}\n\n${eloBlock}`;
        }
      }

      const temp = 0.3;  // 固定温度，确保相同输入产生相同预测

      try {
        const output = await deepseekChat(agent.system_prompt, agentInput, 2048, temp);

        resultEntry.status = 'completed';
        resultEntry.output = output;
      } catch (err) {
        resultEntry.status = 'failed';
        resultEntry.output = '调用失败: ' + err.message;
      }

      await saveResults();
      executed.add(node.name);
    }
  }

  await pool.query('UPDATE executions SET status=$1, completed_at=NOW() WHERE id=$2',
    ['completed', id]);
}

// ── 启动 ──
(async () => {
  await init();
  app.listen(PORT, async () => {
    console.log(`⚽ 世界杯预测平台已启动: http://localhost:${PORT}`);
    console.log(`   Agent数量: ${loadAgents().length}`);
    console.log(`   工作流节点: ${loadWorkflow().nodes.length}`);

    // 每6小时自动检测已结束比赛 → 存比分 → 抓赛后数据
    setInterval(async () => {
      try { await detectCompletedMatches(); } catch(e) {}
    }, 6 * 60 * 60 * 1000);
    console.log('   ⏰ 每6小时自动检测比赛结果');
  });
})();
