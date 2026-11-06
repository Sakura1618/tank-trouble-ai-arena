// 晋级门：候选版本要在公开种子和留出种子上都明确赢过现任冠军，
// 并且不能在基准对手身上退步，才能成为新冠军。

import fs from 'node:fs';
import path from 'node:path';
import { matchScores, wilson } from './rating.js';
import { duel, gauntlet, holdoutSeeds, loadSuite } from './schedule.js';
import { executeRun } from './run.js';
import { ArenaStore } from './store.js';

const REGRESSION_TOLERANCE = 0.03;

function headToHead(run, candidateId) {
  let score = 0;
  let games = 0;
  run.results.forEach((match, i) => {
    const me = run.tasks[i].lineup.find(e => e.key === candidateId);
    score += matchScores(match)[me.id];
    games++;
  });
  return { score, games, rate: score / games, ci: wilson(score, games) };
}

function poolRate(run, botId) {
  const row = run.summary.table.find(r => r.id === botId);
  return row ? row.score : 0;
}

export async function runGate({ candidate, champion, pool, rulesetId, resultsDir, suiteId, holdoutCount, replays, workers, maxSeconds }) {
  const suite = loadSuite(suiteId);
  const common = { rulesetId, resultsDir, workers, maxSeconds, focus: candidate.id };
  const stages = [];

  const publicRun = await executeRun({ ...common, title: `晋级 · 公开种子：${candidate.id} vs ${champion.id}`, mode: 'gate-public',
    bots: [candidate, champion], matches: duel(candidate, champion, suite.seeds), seedLabel: suite.id, replays });
  const publicResult = headToHead(publicRun, candidate.id);
  stages.push({ name: '公开种子', run: publicRun.id, ...publicResult, pass: publicResult.rate > 0.5 });

  if (stages[0].pass) {
    const seeds = holdoutSeeds(resultsDir, holdoutCount);
    const holdoutRun = await executeRun({ ...common, title: `晋级 · 留出种子：${candidate.id} vs ${champion.id}`, mode: 'gate-holdout',
      bots: [candidate, champion], matches: duel(candidate, champion, seeds), seedLabel: 'holdout', replays: 'none' });
    const holdoutResult = headToHead(holdoutRun, candidate.id);
    stages.push({ name: '留出种子', run: holdoutRun.id, ...holdoutResult, pass: holdoutResult.ci.low > 0.5 });
  }

  if (stages.every(s => s.pass) && pool.length) {
    const others = pool.filter(b => b.id !== candidate.id && b.id !== champion.id);
    if (others.length) {
      const baseSeeds = suite.seeds.slice(0, Math.min(20, suite.seeds.length));
      const candidateRun = await executeRun({ ...common, title: `晋级 · 回归：${candidate.id}`, mode: 'gate-regression', bots: [candidate, ...others], matches: gauntlet(candidate, others, baseSeeds), seedLabel: suite.id, replays: 'none' });
      const championRun = await executeRun({ ...common, focus: champion.id, title: `晋级 · 回归基线：${champion.id}`, mode: 'gate-regression', bots: [champion, ...others], matches: gauntlet(champion, others, baseSeeds), seedLabel: suite.id, replays: 'none' });
      const candidateRate = poolRate(candidateRun, candidate.id);
      const championRate = poolRate(championRun, champion.id);
      stages.push({ name: '基准回归', run: candidateRun.id, rate: candidateRate, baseline: championRate, pass: candidateRate >= championRate - REGRESSION_TOLERANCE });
    }
  }

  const promoted = stages.length >= 2 && stages.every(s => s.pass);
  if (promoted) {
    // 冠军要留存源码快照：选手文件之后还会被继续修改，历代冠军必须能原样复赛。
    const dir = path.join(resultsDir, 'champions', rulesetId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${candidate.id}-${candidate.hash}.js`);
    fs.writeFileSync(file, candidate.source);
    const store = new ArenaStore(resultsDir);
    store.promote({ ruleset: rulesetId, bot: { ...candidate, file }, runId: stages[stages.length - 1].run, note: `击败 ${champion.id}` });
    store.close();
  }
  return { promoted, stages };
}
