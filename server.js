require('dotenv').config();
const express = require('express');
const path = require('path');
const { db, init, getCachedPrediction, cachePrediction, updateLastChecked, getLastChecked, invalidatePrediction, invalidateAllForTeam } = require('./database');
const { loadAgents, loadWorkflow } = require('./agent-loader');

const app = express();
const PORT = 5051;
const matches = require('./matches.json');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 生成全部日期（6月11日–7月19日），标注哪些有比赛
function getMatchCalendar() {
  const matchDates = [...new Set(matches.map(m => m.date))];
  const matchMap = {};
  matches.forEach(m => {
    if (!matchMap[m.date]) matchMap[m.date] = [];
    matchMap[m.date].push(m);
  });

  const result = [];
  // 6月11日 → 7月19日
  const start = new Date(2026, 5, 11); // month 5 = June
  const end = new Date(2026, 6, 19);   // month 6 = July

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const month = d.getMonth() + 1;
    const day = d.getDate();
    const key = month + '月' + day + '日';
    const hasMatches = matchDates.includes(key);
    result.push({
      date: key,
      hasMatches,
      matches: matchMap[key] || []
    });
  }
  return result;
}

// ── 页面路由 ──

app.get('/', (req, res) => {
  const calendar = getMatchCalendar();
  const recent = db.prepare('SELECT * FROM executions ORDER BY created_at DESC LIMIT 5').all();
  recent.forEach(r => { r.results = JSON.parse(r.results); });
  res.render('index', { calendar, recent });
});

app.get('/predict', (req, res) => {
  const { home, away, date, venue } = req.query;
  if (!home || !away) return res.redirect('/');
  res.render('predict', { home, away, date: date || '', venue: venue || '' });
});

app.get('/result/:id', (req, res) => {
  const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(req.params.id);
  if (!execution) return res.status(404).send('记录不存在');
  execution.results = JSON.parse(execution.results);
  res.render('result', { execution });
});

// ── API ──

app.get('/api/matches', (req, res) => {
  res.json(getMatchCalendar());
});

app.get('/api/agents', (req, res) => {
  res.json(loadAgents());
});

app.get('/api/executions', (req, res) => {
  const list = db.prepare('SELECT * FROM executions ORDER BY created_at DESC LIMIT 20').all();
  list.forEach(r => { r.results = JSON.parse(r.results); });
  res.json(list);
});

app.post('/api/predict', async (req, res) => {
  const { teamA, teamB, matchDate, venue, force } = req.body;
  if (!teamA || !teamB) return res.status(400).json({ error: '请填写两支球队名称' });

  // 非强制模式下，检查是否已有缓存预测
  if (!force) {
    const cached = getCachedPrediction(teamA, teamB);
    if (cached) {
      // 有缓存，先检测是否有重大新闻需要清缓存
      const majorNews = await checkForMajorNews(teamA, teamB);
      if (!majorNews) {
        cached.results = JSON.parse(cached.results);
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
  db.prepare(`
    INSERT INTO executions (id, team_a, team_b, match_date, venue, status)
    VALUES (?, ?, ?, ?, ?, 'running')
  `).run(id, teamA, teamB, matchDate || '', venue || '');

  // 缓存此次预测（team_a, team_b → execution_id）
  cachePrediction(teamA, teamB, id);

  runWorkflow(id, teamA, teamB, matchDate, venue, agents, agentMap, workflow).catch(err => {
    console.error('Workflow error:', err);
    const results = db.prepare('SELECT results FROM executions WHERE id = ?').get(id);
    if (results) {
      const arr = JSON.parse(results.results);
      arr.push({ agentName: '系统', status: 'failed', output: err.message });
      db.prepare('UPDATE executions SET status=?, results=?, completed_at=datetime(\'now\',\'localtime\') WHERE id=?')
        .run('failed', JSON.stringify(arr), id);
    }
  });

  res.json({ executionId: id, status: 'running' });
});

app.get('/api/executions/:id', (req, res) => {
  const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(req.params.id);
  if (!execution) return res.status(404).json({ error: 'Not found' });
  execution.results = JSON.parse(execution.results);
  res.json(execution);
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

// ── 重大新闻检测（缓存失效）──

const NEWS_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000; // 同一场比赛每2小时最多检查一次

async function checkForMajorNews(teamA, teamB) {
  const lastChecked = getLastChecked(teamA, teamB);
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

  updateLastChecked(teamA, teamB);

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
      system: '你是一名足球赛事分析师。判断新闻是否包含会显著改变比赛预测结果的"重大变故"。重大变故标准（严格）：核心球员（头号球星/队长/主力射手/一门）重伤或停赛、主教练突然下课、球队遭遇罢赛或重大场外危机。以下不算重大：角色球员微伤、日常轮换、媒体猜测、例行采访、训练日常、轻微不适。请只回复一个词：MAJOR_A（新闻关于球队A）、MAJOR_B（新闻关于球队B）、MAJOR_BOTH（两队都涉及）、或 MINOR（无重大变故）。',
      messages: [{
        role: 'user',
        content: `球队A：${teamA}\n球队B：${teamB}\n\n最新新闻：\n${newsText.substring(0, 3000)}`
      }],
    });

    const verdict = msg.content.filter(c => c.type === 'text').map(c => c.text).join('').trim();
    console.log(`  [新闻检查] Claude 判定: ${verdict}`);

    if (verdict.includes('MAJOR_BOTH')) {
      console.log(`  [新闻检查] ⚠️ 两队均有重大变故！清除 ${teamA} 和 ${teamB} 所有相关预测`);
      invalidateAllForTeam(teamA);
      invalidateAllForTeam(teamB);
      return true;
    }
    if (verdict.includes('MAJOR_A')) {
      console.log(`  [新闻检查] ⚠️ ${teamA} 有重大变故！清除其所有相关预测`);
      invalidateAllForTeam(teamA);
      return true;
    }
    if (verdict.includes('MAJOR_B')) {
      console.log(`  [新闻检查] ⚠️ ${teamB} 有重大变故！清除其所有相关预测`);
      invalidateAllForTeam(teamB);
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

  function saveResults() {
    db.prepare('UPDATE executions SET results = ? WHERE id = ?')
      .run(JSON.stringify(allResults), id);
  }

  // 预搜索实时情报（并行，不阻塞）
  let realtimeIntel = '';
  try {
    realtimeIntel = await gatherRealtimeIntel(teamA, teamB, matchDate);
    if (realtimeIntel) console.log('  [搜索] 实时情报已获取');
  } catch (e) {
    console.error('  [搜索] 失败:', e.message);
  }

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

      let agentInput = input;
      // 第一个Agent注入实时搜索情报
      const isFirstAgent = executed.size === 0;
      if (isFirstAgent && realtimeIntel) {
        agentInput = input + realtimeIntel;
      }

      const upstreams = allResults.filter(r => {
        const n = workflow.nodes.find(wn => wn.name === r.agentName);
        return n && (node.dependsOn || []).includes(n.name);
      });
      if (upstreams.length > 0) {
        const upstreamText = upstreams.map(u => u.output || '').filter(Boolean).join('\n\n---\n\n');
        if (upstreamText) {
          agentInput = `${input}\n\n==== 上游Agent分析结果 ====\n${upstreamText}`;
        }
      }

      const temp = 0.3 + Math.random() * 0.3;

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

      saveResults();
      executed.add(node.name);
    }
  }

  db.prepare('UPDATE executions SET status=?, completed_at=datetime(\'now\',\'localtime\') WHERE id=?')
    .run('completed', id);
}

// ── 启动 ──
init();
app.listen(PORT, () => {
  console.log(`⚽ 世界杯预测平台已启动: http://localhost:${PORT}`);
  console.log(`   Agent数量: ${loadAgents().length}`);
  console.log(`   工作流节点: ${loadWorkflow().nodes.length}`);
});
