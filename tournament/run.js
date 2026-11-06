// 执行一次赛事并写出全部产物：摘要、报告、录像、数据库记录。

import fs from 'node:fs';
import path from 'node:path';
import { getRuleset, rulesetHash } from '../rulesets/index.js';
import { numberMatches } from './schedule.js';
import { defaultWorkers, runMatches } from './pool.js';
import { renderReport, summarize } from './report.js';
import { matchScores } from './rating.js';
import { ArenaStore } from './store.js';

let runCounter = 0;

// 时间只精确到秒：同一秒内的连续运行靠计数器区分，并行进程靠 pid 区分。
function runId(mode) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  return `${stamp}-${mode}-${process.pid.toString(36)}${(runCounter++).toString(36)}`;
}

function shouldKeep(policy, match, task, focus) {
  if (policy === 'all') return true;
  if (policy === 'none') return false;
  const scores = matchScores(match);
  const mine = task.lineup.filter(e => !focus || e.key === focus);
  return mine.some(e => scores[e.id] < 0.5);
}

function progress(done, total) {
  if (!process.stderr.isTTY && done % 25 !== 0 && done !== total) return;
  process.stderr.write(`\r比赛进度 ${done}/${total}`);
  if (done === total) process.stderr.write('\n');
}

export async function executeRun({ title, mode, rulesetId, bots, matches, seedLabel, maxSeconds, resultsDir, replays = 'losses', focus = null, workers = defaultWorkers(), persist = true }) {
  const ruleset = getRuleset(rulesetId);
  const tasks = numberMatches(matches).map(m => ({ ...m, ruleset: rulesetId, maxSeconds }));
  const sources = Object.fromEntries(bots.map(b => [b.id, b.source]));
  const results = await runMatches(tasks, { sources, workers, onResult: progress });
  const summary = summarize(tasks, results);

  const id = runId(mode);
  const dir = path.join(resultsDir, id);
  fs.mkdirSync(path.join(dir, 'replays'), { recursive: true });
  const replayPaths = results.map((match, i) => {
    if (!shouldKeep(replays, match, tasks[i], focus)) return null;
    const file = path.join('replays', `${String(i).padStart(5, '0')}-${match.replay.seed}.json`);
    fs.writeFileSync(path.join(dir, file), JSON.stringify(match.replay));
    return path.join(id, file).replaceAll('\\', '/');
  });

  const config = { title, mode, ruleset: rulesetId, rulesetHash: rulesetHash(ruleset), seedLabel, matchCount: tasks.length, maxSeconds: maxSeconds ?? ruleset.maxSeconds, bots: bots.map(b => ({ id: b.id, hash: b.hash })) };
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ config, summary }, null, 2));
  fs.writeFileSync(path.join(dir, 'report.md'), renderReport({ title, config, summary }));
  fs.writeFileSync(path.join(dir, 'matches.jsonl'), results.map((match, i) => JSON.stringify({
    index: i, seed: match.replay.seed, seatRotation: match.replay.seatRotation, lineup: tasks[i].lineup.map(e => e.key),
    result: { winnerId: match.result.winnerId, reason: match.result.reason, ticks: match.result.ticks }, finalHash: match.replay.finalHash, replay: replayPaths[i],
  })).join('\n') + '\n');

  if (persist) {
    const store = new ArenaStore(resultsDir);
    store.saveRun({ id, config, bots, tasks, matches: results, scoresOf: matchScores, replayPaths });
    store.close();
  }
  return { id, dir, config, tasks, results, summary, replayPaths };
}
