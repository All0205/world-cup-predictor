const fs = require('fs');
const path = require('path');

const ELO_FILE = path.join(__dirname, 'data', 'elo.json');

const HOME_ADVANTAGE = 100;
const ELO_PER_GOAL = 200;
const BASELINE_GOALS = 1.3;
const DEFAULT_ELO = 1500;

let _cache = null;

function loadElo() {
  if (_cache) return _cache;
  _cache = JSON.parse(fs.readFileSync(ELO_FILE, 'utf-8'));
  return _cache;
}

function getElo(teamName) {
  const data = loadElo();
  if (data[teamName]) return data[teamName];

  for (const [name, rating] of Object.entries(data)) {
    if (teamName.includes(name) || name.includes(teamName)) return rating;
  }

  return DEFAULT_ELO;
}

function poissonProb(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

function factorial(n) {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}

const STADIUM_COUNTRY = {
  '阿兹特克': '墨西哥', 'Estadio Azteca': '墨西哥',
  'BBVA': '墨西哥', 'Estadio BBVA': '墨西哥',
  'BC Place': '加拿大', 'BMO Field': '加拿大',
  'MetLife': '美国', 'Gillette': '美国', 'NRG': '美国',
  'AT&T': '美国', "Levi's": '美国', 'Lumen': '美国',
  'SoFi': '美国', 'Hard Rock': '美国', 'Arrowhead': '美国',
  'Mercedes-Benz': '美国', 'Lincoln Financial': '美国',
};

function isHome(team, venue) {
  if (!venue) return false;
  for (const [stadium, country] of Object.entries(STADIUM_COUNTRY)) {
    if (venue.includes(stadium) && team.includes(country)) return true;
  }
  if (venue.includes(team)) return true;
  return false;
}

function predictFromElo(teamA, teamB, venue, eloAdjustA = 0, eloAdjustB = 0) {
  const eloA = getElo(teamA) + eloAdjustA;
  const eloB = getElo(teamB) + eloAdjustB;

  const homeA = isHome(teamA, venue);
  const homeB = isHome(teamB, venue);

  const adjustedA = homeA ? eloA + HOME_ADVANTAGE : eloA;
  const adjustedB = homeB ? eloB + HOME_ADVANTAGE : eloB;
  const diff = adjustedA - adjustedB;

  const xgA = Math.max(0.1, BASELINE_GOALS + diff / (ELO_PER_GOAL * 2));
  const xgB = Math.max(0.1, BASELINE_GOALS - diff / (ELO_PER_GOAL * 2));

  const scores = [];
  for (let a = 0; a <= 6; a++) {
    for (let b = 0; b <= 6; b++) {
      const p = poissonProb(xgA, a) * poissonProb(xgB, b);
      if (p > 0.001) scores.push({ home: a, away: b, prob: p });
    }
  }
  scores.sort((a, b) => b.prob - a.prob);

  const top3 = scores.slice(0, 3);
  const drawProb = scores.filter(s => s.home === s.away).reduce((sum, s) => sum + s.prob, 0);
  const homeWinProb = scores.filter(s => s.home > s.away).reduce((sum, s) => sum + s.prob, 0);
  const awayWinProb = scores.filter(s => s.home < s.away).reduce((sum, s) => sum + s.prob, 0);

  return {
    eloARaw: eloA,
    eloBRaw: eloB,
    eloA: adjustedA,
    eloB: adjustedB,
    eloDiff: diff,
    eloAdjustA,
    eloAdjustB,
    homeAdvantage: homeA ? teamA : (homeB ? teamB : null),
    xgA: Math.round(xgA * 100) / 100,
    xgB: Math.round(xgB * 100) / 100,
    homeWinProb: Math.round(homeWinProb * 100),
    drawProb: Math.round(drawProb * 100),
    awayWinProb: Math.round(awayWinProb * 100),
    mostLikely: top3.map(s => ({
      score: `${s.home}-${s.away}`,
      prob: Math.round(s.prob * 100)
    }))
  };
}

module.exports = { predictFromElo, getElo, poissonProb };
