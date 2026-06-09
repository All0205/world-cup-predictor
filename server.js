require('dotenv').config();
const express = require('express');
const path = require('path');
const { db, init } = require('./database');
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
  const { teamA, teamB, matchDate, venue } = req.body;
  if (!teamA || !teamB) return res.status(400).json({ error: '请填写两支球队名称' });

  const agents = loadAgents();
  const agentMap = {};
  agents.forEach(a => { agentMap[a.name] = a; });

  const workflow = loadWorkflow();

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  db.prepare(`
    INSERT INTO executions (id, team_a, team_b, match_date, venue, status)
    VALUES (?, ?, ?, ?, ?, 'running')
  `).run(id, teamA, teamB, matchDate || '', venue || '');

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

async function searchTavily(query) {
  const https = require('https');
  return new Promise((resolve) => {
    const body = JSON.stringify({
      api_key: TAVILY_KEY,
      query,
      search_depth: 'basic',
      max_results: 5,
      include_answer: true
    });
    const req = https.request({
      hostname: 'api.tavily.com',
      path: '/search',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
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
    req.write(body);
    req.end();
  });
}

async function gatherRealtimeIntel(teamA, teamB, matchDate) {
  const queries = [
    { label: `${teamA}近况`, q: `${teamA} football team 2026 World Cup latest news squad` },
    { label: `${teamB}近况`, q: `${teamB} football team 2026 World Cup latest news squad` },
    { label: '交锋记录', q: `${teamA} vs ${teamB} football match history results` },
  ];

  const results = await Promise.all(queries.map(q => searchTavily(q.q)));

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
