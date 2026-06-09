const fs = require('fs');
const path = require('path');

const AGENTS_DIR = path.join(__dirname, 'agents');
const WORKFLOW_FILE = path.join(__dirname, 'workflow.md');

function parseMdSections(content) {
  const lines = content.split('\n');
  const result = {};
  let currentKey = null;
  let currentValue = [];

  for (const line of lines) {
    const h1Match = line.match(/^# (.+)/);
    if (h1Match) { result.name = h1Match[1].trim(); continue; }

    const h2Match = line.match(/^## (.+)/);
    if (h2Match) {
      if (currentKey) { result[currentKey] = currentValue.join('\n').trim(); }
      currentKey = h2Match[1].trim();
      currentValue = [];
      continue;
    }

    if (currentKey) currentValue.push(line);
  }
  if (currentKey) { result[currentKey] = currentValue.join('\n').trim(); }

  return result;
}

function parseSkills(skillsText) {
  if (!skillsText) return [];
  return skillsText
    .split('\n')
    .filter(l => l.trim().startsWith('-'))
    .map(l => l.replace(/^-\s*/, '').trim());
}

function loadAgents() {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  const files = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'));
  return files.map(f => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, f), 'utf-8');
    const sections = parseMdSections(content);

    return {
      id: f.replace('.md', ''),
      name: sections['name'] || f.replace('.md', ''),
      role: sections['角色'] || '',
      expertise: sections['专长'] || '',
      input_spec: sections['输入'] || '',
      output_spec: sections['输出'] || '',
      constraints: sections['约束'] || '',
      system_prompt: sections['System Prompt'] || '',
      skills: parseSkills(sections['Skills'] || ''),
    };
  });
}

function loadWorkflow() {
  if (!fs.existsSync(WORKFLOW_FILE)) return { nodes: [] };

  const content = fs.readFileSync(WORKFLOW_FILE, 'utf-8');
  const lines = content.split('\n');
  const nodes = [];
  let currentNode = null;

  for (const line of lines) {
    const h3Match = line.match(/^### (.+)/);
    if (h3Match) {
      if (currentNode) nodes.push(currentNode);
      currentNode = { name: h3Match[1].trim(), agent: '', dependsOn: [] };
      continue;
    }

    if (currentNode) {
      const agentMatch = line.match(/- agent:\s*(.+)/);
      if (agentMatch) currentNode.agent = agentMatch[1].trim();

      const depMatch = line.match(/- dependsOn:\s*\[(.+)\]/);
      if (depMatch) {
        const depStr = depMatch[1].trim();
        if (depStr === '') {
          currentNode.dependsOn = [];
        } else {
          currentNode.dependsOn = depStr.split(',').map(s => s.trim());
        }
      }
    }
  }
  if (currentNode) nodes.push(currentNode);

  return { nodes };
}

module.exports = { loadAgents, loadWorkflow };
