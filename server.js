require('dotenv').config();
const express = require('express');
const path = require('path');
const { pool, init, getAllMatches, updateMatchTeams, getMatchesByDate, updateMatchStatus, getCompletedCountForDate, getTotalCountForDate, getCachedPrediction, cachePrediction, updateLastChecked, getLastChecked, invalidatePrediction, invalidateAllForTeam } = require('./database');
const { loadAgents, loadWorkflow } = require('./agent-loader');
const { predictFromElo } = require('./elo');

const app = express();
const PORT = process.env.PORT || 5051;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
  detectCompletedMatches();  // 后台自动检测已结束的比赛
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
    const searchResult = await searchTavily(
      `2026 世界杯 淘汰赛 晋级 对阵 ${dateStr} 16强 8强`,
      3
    );

    if (!searchResult || searchResult.results.length === 0) return;

    let newsText = searchResult.answer || '';
    newsText += '\n' + searchResult.results.map(r => `- ${r.title}: ${r.content}`).join('\n');

    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      temperature: 0,
      system: '你是世界杯赛程数据提取器。从新闻中提取已确认的淘汰赛对阵。只提取官方确认的比赛结果和晋级球队。输出JSON数组，每项格式：{"stage":"阶段","date":"日期","home":"球队A","away":"球队B"}。stage用中文：1/16决赛、1/8决赛、1/4决赛、半决赛、三四名决赛、决赛。如果没有找到任何确认的对阵，输出空数组[]。',
      messages: [{
        role: 'user',
        content: `当前待更新的淘汰赛占位：\n${placeholders.map(m => `[${m.id}] ${m.date} ${m.stage}: ${m.home} vs ${m.away}`).join('\n')}\n\n最新新闻：\n${newsText.substring(0, 4000)}`
      }],
    });

    const reply = msg.content.filter(c => c.type === 'text').map(c => c.text).join('').trim();
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

    console.log('  [结果检测] 检测到', dueMatches.length, '场可检查的比赛');

    const teamNames = [...new Set(dueMatches.flatMap(m => [m.home, m.away]))];
    const query = `世界杯 比分 结果 ${teamNames.slice(0, 5).join(' ')} ${today}`;
    const searchResult = await searchTavily(query, 2);

    if (!searchResult || searchResult.results.length === 0) return;

    let newsText = searchResult.answer || '';
    newsText += '\n' + searchResult.results.map(r => `- ${r.title}: ${r.content}`).join('\n');

    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      temperature: 0,
      system: '你是一个比赛结果提取器。严格判断标准：只有当新闻中明确出现了"最终比分""FT""全场比赛结束"或具体比分数字（如2-1、3-0等）时，才认为比赛已结束。以下情况绝对不能标记为completed：赛前预测、前瞻报道、首发名单公布、"即将开始""揭幕战打响"等预热新闻、训练新闻、球员采访。宁可漏判也不能错判。输出JSON数组，每项格式：{"home":"球队A","away":"球队B","completed":true,"score":"X-X"}。如果没有任何比赛确认结束（即找不到具体比分），输出空数组[]。',
      messages: [{
        role: 'user',
        content: `以下比赛可能已经进行，请判断哪些已经结束：\n${dueMatches.map(m => `- ${m.date} ${m.home} vs ${m.away} (${m.stage})`).join('\n')}\n\n最新新闻：\n${newsText.substring(0, 3000)}`
      }],
    });

    const reply = msg.content.filter(c => c.type === 'text').map(c => c.text).join('').trim();
    const jsonMatch = reply.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return;

    const results = JSON.parse(jsonMatch[0]);
    let updated = 0;
    for (const r of results) {
      if (!r.completed) continue;
      const match = dueMatches.find(m => m.home === r.home && m.away === r.away);
      if (match) {
        await updateMatchStatus(match.id, 'completed');
        console.log('  [结果检测] ✅', match.date, match.home, 'vs', match.away, '已结束');
        updated++;
      }
    }
    if (updated > 0) console.log('  [结果检测] 标记', updated, '场比赛为已完成');
  } catch (err) {
    console.error('  [结果检测] 失败:', err.message);
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
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      temperature: 0,
      system: '你是世界杯赛程数据提取器。从新闻中提取已确认的淘汰赛对阵。只提取官方确认的比赛结果和晋级球队。输出JSON数组，每项格式：{"stage":"阶段","date":"日期","home":"球队A","away":"球队B"}。stage用中文：1/16决赛、1/8决赛、1/4决赛、半决赛、三四名决赛、决赛。如果没有找到任何确认的对阵，输出空数组[]。',
      messages: [{
        role: 'user',
        content: `当前待更新的淘汰赛占位：\n${placeholders.map(m => `[${m.id}] ${m.date} ${m.stage}: ${m.home} vs ${m.away}`).join('\n')}\n\n最新新闻：\n${newsText.substring(0, 4000)}`
      }],
    });

    const reply = msg.content.filter(c => c.type === 'text').map(c => c.text).join('').trim();
    console.log('  [赛程更新] Claude 回复:', reply.substring(0, 300));

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

// ── 实时搜索（Tavily API）──

const TAVILY_KEY = process.env.TAVILY_API_KEY || '';

async function searchTavily(query, days) {
  const https = require('https');
  return new Promise((resolve) => {
    const body = {
      api_key: TAVILY_KEY,
      query,
      search_depth: 'advanced',
      max_results: 5,
      include_answer: true
    };
    if (days) body.days = days;
    const req = https.request({
      hostname: 'api.tavily.com',
      path: '/search',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(body)) },
      timeout: 8000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({
            answer: json.answer || '',
            results: (json.results || []).slice(0, 5).map(r => ({
              title: r.title || '',
              url: r.url || '',
              content: (r.content || '').substring(0, 300)
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
  const dateStr = `${now.getFullYear()}年${month}月`;
  const queries = [
    { label: `${teamA}近况`, q: `${teamA} ${dateStr} 世界杯 最新阵容 伤病 首发` },
    { label: `${teamB}近况`, q: `${teamB} ${dateStr} 世界杯 最新阵容 伤病 首发` },
    { label: '交锋记录', q: `${teamA} vs ${teamB} 历史交锋 比分 2026` },
  ];

  // 近况查询限定7天内，交锋记录不限时间
  const results = await Promise.all([
    searchTavily(queries[0].q, 7),
    searchTavily(queries[1].q, 7),
    searchTavily(queries[2].q),       // 历史交锋，不限时间
  ]);

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
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      temperature: 0,
      system: `你是足球ELO评分调整专家。基于情报中的伤病/停赛信息，量化ELO调整值。

规则：
- 仅根据"确认缺席/赛季报销/确定无缘"的球员扣分。"可能""疑似""出战成疑"不扣分
- 一门确认缺席: -40~-50
- 队长/防线核心确认缺席: -30~-40
- 头号射手确认缺席: -30~-40
- 主力中场/边锋确认缺席: -20~-30 (每人)
- 多名主力缺席可累加，但单队上限 -80
- 球员伤愈复出/确认回归: +20~+30
- 没有确认缺席则 adjust 均为 0

输出严格JSON，不要其他文字：
{"adjustA":-XX,"adjustB":-YY,"reason":"球队A: xxx; 球队B: xxx"}`,
      messages: [{
        role: 'user',
        content: `球队A：${teamA}\n球队B：${teamB}\n\n情报：\n${intelText.substring(0, 3000)}`
      }],
    });

    const reply = msg.content.filter(c => c.type === 'text').map(c => c.text).join('').trim();
    console.log(`  [ELO调整] Claude回复: ${reply}`);

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

  // 搜索两队近期重大新闻
  const now = new Date();
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月`;
  const queries = [
    `${teamA} ${dateStr} 世界杯 突发 伤病 停赛 退出`,
    `${teamB} ${dateStr} 世界杯 突发 伤病 停赛 退出`,
    `${teamA} ${teamB} 世界杯 突发新闻 变故 ${dateStr}`,
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
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 50,
      temperature: 0,
      system: '你是足球赛事分析师。判断是否有"已确认的"重大变故会显著改变预测。严格标准：只有官方确认的核心球员（头号球星/队长/主力射手/一门）"确定缺席"本轮才算。以下全部算MINOR：任何"可能""疑似""出战成疑""或"的表述、角色球员、媒体猜测、训练日常、战术调整、换帅传闻。宁愿漏判也不能错判——只要有一丝不确定就选MINOR。只回复一个词：MAJOR_A / MAJOR_B / MAJOR_BOTH / MINOR。',
      messages: [{
        role: 'user',
        content: `球队A：${teamA}\n球队B：${teamB}\n\n最新新闻：\n${newsText.substring(0, 3000)}`
      }],
    });

    const verdict = msg.content.filter(c => c.type === 'text').map(c => c.text).join('').trim();
    console.log(`  [新闻检查] Claude 判定: ${verdict}`);

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
  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

  // 3. 计算 ELO 基线（含伤病调整）
  const eloBaseline = predictFromElo(teamA, teamB, venue || '', eloAdj.adjustA, eloAdj.adjustB);
  const eloBlock = `
==== ELO 量化基线 ====
- ${teamA} 原始 ELO: ${eloBaseline.eloARaw - eloAdj.adjustA}${eloAdj.adjustA !== 0 ? ` → 伤病调整 ${eloAdj.adjustA} → 有效 ELO: ${eloBaseline.eloARaw}` : ''}
- ${teamB} 原始 ELO: ${eloBaseline.eloBRaw - eloAdj.adjustB}${eloAdj.adjustB !== 0 ? ` → 伤病调整 ${eloAdj.adjustB} → 有效 ELO: ${eloBaseline.eloBRaw}` : ''}
- ${eloBaseline.homeAdvantage ? `主场加成: ${eloBaseline.homeAdvantage} +100` : '中立场'}
- ELO 差值: ${eloBaseline.eloDiff > 0 ? `${teamA} 高 ${eloBaseline.eloDiff} 分` : `${teamB} 高 ${-eloBaseline.eloDiff} 分`}
- 调整原因: ${eloAdj.reason}
- 预期进球 (xG): ${teamA} ${eloBaseline.xgA} — ${teamB} ${eloBaseline.xgB}
- 胜平负概率: ${teamA}胜 ${eloBaseline.homeWinProb}% / 平 ${eloBaseline.drawProb}% / ${teamB}胜 ${eloBaseline.awayWinProb}%
- 量化模型最可能比分: ${eloBaseline.mostLikely.map(s => `${s.score} (${s.prob}%)`).join(', ')}
==== ELO 基线结束 ====

⚠️ ELO 基线已综合伤病调整。你的任务是基于情报中的其他因素（战术、状态、天气等），判断是否需进一步偏离。`;
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

      let agentInput = input + eloBlock;
      // 第一个Agent注入实时搜索情报
      const isFirstAgent = executed.size === 0;
      if (isFirstAgent && realtimeIntel) {
        agentInput = input + realtimeIntel + eloBlock;
      }

      const upstreams = allResults.filter(r => {
        const n = workflow.nodes.find(wn => wn.name === r.agentName);
        return n && (node.dependsOn || []).includes(n.name);
      });
      if (upstreams.length > 0) {
        const upstreamText = upstreams.map(u => u.output || '').filter(Boolean).join('\n\n---\n\n');
        if (upstreamText) {
          agentInput = `${input}\n\n==== 上游Agent分析结果 ====\n${upstreamText}\n\n${eloBlock}`;
        }
      }

      const temp = 0.3;  // 固定温度，确保相同输入产生相同预测

      try {
        const msg = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 2048,
          temperature: temp,
          system: agent.system_prompt,
          messages: [{ role: 'user', content: agentInput }],
        });

        const textBlocks = msg.content.filter(c => c.type === 'text');
        const output = textBlocks.map(c => c.text).join('\n');

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
  app.listen(PORT, () => {
    console.log(`⚽ 世界杯预测平台已启动: http://localhost:${PORT}`);
    console.log(`   Agent数量: ${loadAgents().length}`);
    console.log(`   工作流节点: ${loadWorkflow().nodes.length}`);
  });
})();
