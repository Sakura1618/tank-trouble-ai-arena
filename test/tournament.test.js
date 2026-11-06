import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileBot, prepareBots, resolveBot, resolvePool } from '../tournament/bots.js';
import { bootstrapElo, fitElo, matchScores, pairwise, placements, wilson } from '../tournament/rating.js';
import * as schedule from '../tournament/schedule.js';
import { runMatches } from '../tournament/pool.js';
import { executeRun } from '../tournament/run.js';
import { buildFeedback, renderFeedback, summarize } from '../tournament/report.js';
import { ArenaStore } from '../tournament/store.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arena-test-'));

function fakeMatch(players) {
  return {
    result: { players: players.map(p => ({ id: p.id, alive: p.deathTick === null, forfeit: p.forfeit ?? null })) },
    stats: Object.fromEntries(players.map(p => [p.id, { deathTick: p.deathTick }])),
  };
}

test('Wilson 区间：已知数值与边界', () => {
  const { low, high } = wilson(50, 100);
  assert.ok(Math.abs(low - 0.4038) < 0.001 && Math.abs(high - 0.5962) < 0.001);
  assert.equal(wilson(0, 0).high, 1);
  assert.ok(wilson(10, 10).low > 0.7);
});

test('Elo 拟合与比赛顺序无关', () => {
  const pairs = [];
  for (let i = 0; i < 30; i++) pairs.push({ a: 'A', b: 'B', score: i % 3 ? 1 : 0 }, { a: 'B', b: 'C', score: i % 4 ? 1 : 0.5 });
  const forward = fitElo(['A', 'B', 'C'], pairs);
  const backward = fitElo(['A', 'B', 'C'], [...pairs].reverse());
  for (const id of ['A', 'B', 'C']) assert.ok(Math.abs(forward[id] - backward[id]) < 1e-6);
  assert.ok(forward.A > forward.B && forward.B > forward.C);
});

test('全胜不会让评分发散', () => {
  const ratings = fitElo(['A', 'B'], Array.from({ length: 20 }, () => ({ a: 'A', b: 'B', score: 1 })));
  assert.ok(Number.isFinite(ratings.A) && ratings.A - ratings.B < 1000);
});

test('Elo 区间重采样可复现', () => {
  const groups = Array.from({ length: 10 }, (_, i) => [{ a: 'A', b: 'B', score: i % 2 }]);
  assert.deepEqual(bootstrapElo(['A', 'B'], groups, { samples: 50 }), bootstrapElo(['A', 'B'], groups, { samples: 50 }));
});

test('名次与得分：存活优先，晚死优先，同 Tick 并列，判负垫底', () => {
  const match = fakeMatch([{ id: 'a', deathTick: null }, { id: 'b', deathTick: 300 }, { id: 'c', deathTick: 300 }, { id: 'd', deathTick: 10, forfeit: { code: 'x' } }]);
  assert.deepEqual(placements(match), { a: 1, b: 2, c: 2, d: 4 });
  const scores = matchScores(match);
  assert.equal(scores.a, 1);
  assert.equal(scores.b, scores.c);
  assert.equal(scores.d, 0);
});

test('双人局：胜 1、平 0.5、负 0', () => {
  assert.deepEqual(matchScores(fakeMatch([{ id: 'a', deathTick: null }, { id: 'b', deathTick: 5 }])), { a: 1, b: 0 });
  assert.deepEqual(matchScores(fakeMatch([{ id: 'a', deathTick: null }, { id: 'b', deathTick: null }])), { a: 0.5, b: 0.5 });
  assert.deepEqual(matchScores(fakeMatch([{ id: 'a', deathTick: 9 }, { id: 'b', deathTick: 9 }])), { a: 0.5, b: 0.5 });
});

test('镜像比赛不产生自己对自己的评分样本', () => {
  const match = fakeMatch([{ id: 'x#1', deathTick: null }, { id: 'x#2', deathTick: 5 }]);
  assert.deepEqual(pairwise(match, () => 'x'), []);
});

const A = { id: 'A', name: 'A', color: '#111111', hash: 'a' };
const B = { id: 'B', name: 'B', color: '#222222', hash: 'b' };
const C = { id: 'C', name: 'C', color: '#333333', hash: 'c' };

test('赛程：对决每个种子换边两局，循环赛覆盖全部配对', () => {
  const seeds = schedule.seedList('x', 3);
  const duel = schedule.duel(A, B, seeds);
  assert.equal(duel.length, 6);
  assert.deepEqual(duel.slice(0, 2).map(m => m.seatRotation), [0, 1]);
  assert.equal(duel[0].group, duel[1].group);
  assert.equal(schedule.roundRobin([A, B, C], seeds).length, 18);
  assert.equal(schedule.melee([A, B, C], seeds).length, 9);
  assert.equal(schedule.gauntlet(A, [A, B, C], seeds).length, 12);
  assert.equal(new Set(schedule.mirror(A, seeds)[0].lineup.map(e => e.id)).size, 2);
});

test('种子集稳定，基准集随仓库固定', () => {
  assert.deepEqual(schedule.seedList('s', 4), schedule.seedList('s', 4));
  assert.notDeepEqual(schedule.seedList('s', 4), schedule.seedList('t', 4));
  assert.equal(schedule.loadSuite('classic-v1/public').seeds.length, 100);
});

test('留出种子来自本机私有盐，不等于公开种子', () => {
  const dir = tempDir();
  const first = schedule.holdoutSeeds(dir, 5);
  assert.deepEqual(first, schedule.holdoutSeeds(dir, 5));
  assert.notDeepEqual(first, schedule.holdoutSeeds(tempDir(), 5));
  assert.notDeepEqual(first, schedule.loadSuite('classic-v1/public').seeds.slice(0, 5));
});

test('选手解析：预设、文件、TS，缺失时报错', async () => {
  const sentry = await resolveBot('sentry');
  assert.equal(sentry.id, 'sentry');
  await assert.rejects(resolveBot('no-such-bot'), /找不到选手/);
  assert.equal((await resolvePool('baseline')).length, 3);
  assert.equal(prepareBots([{ id: 'x', hash: 'h', color: null }])[0].color.startsWith('#'), true);

  const dir = tempDir();
  const file = path.join(dir, 'typed.ts');
  fs.writeFileSync(file, 'const speed: number = 1;\nmodule.exports = { update(): { move: number } { return { move: speed }; } };\n');
  const compiled = await compileBot(file);
  assert.ok(!compiled.includes(': number'));
  new Function('module', compiled)({ exports: {} });
});

test('同名不同版本的选手不会互相覆盖', () => {
  const bots = prepareBots([{ id: 'bot', name: 'bot', hash: 'aaaaaaaa11', color: null }, { id: 'bot', name: 'bot', hash: 'bbbbbbbb22', color: null }]);
  assert.notEqual(bots[0].id, bots[1].id);
  assert.throws(() => prepareBots([{ id: 'bot', hash: 'same' }, { id: 'bot', hash: 'same' }]), /mirror/);
});

test('连续运行不会写进同一目录', async () => {
  const resultsDir = tempDir();
  const bots = prepareBots(await Promise.all(['sentry', 'rusher'].map(id => resolveBot(id))));
  const options = { title: 't', mode: 'duel', rulesetId: 'classic-v1', bots, maxSeconds: 1, resultsDir, workers: 1, replays: 'none', seedLabel: 's', matches: schedule.duel(bots[0], bots[1], [1]) };
  const [first, second] = [await executeRun(options), await executeRun(options)];
  assert.notEqual(first.id, second.id);
});

test('并行结果与线程数无关', async () => {
  const bots = prepareBots(await Promise.all(['rusher', 'scout'].map(id => resolveBot(id))));
  const tasks = schedule.numberMatches(schedule.duel(bots[0], bots[1], schedule.seedList('parallel', 6)))
    .map(m => ({ ...m, ruleset: 'classic-v1', maxSeconds: 8 }));
  const sources = Object.fromEntries(bots.map(b => [b.id, b.source]));
  const serial = await runMatches(tasks, { sources, workers: 1 });
  const parallel = await runMatches(tasks, { sources, workers: 4 });
  assert.deepEqual(serial.map(m => m.replay.finalHash), parallel.map(m => m.replay.finalHash));
});

test('完整赛事：写出报告、录像、数据库，反馈只含公开信息', async () => {
  const resultsDir = tempDir();
  const bots = prepareBots(await Promise.all(['sentry', 'rusher'].map(id => resolveBot(id))));
  const run = await executeRun({ title: '测试', mode: 'duel', rulesetId: 'classic-v1', bots, maxSeconds: 10, resultsDir, workers: 2, replays: 'all',
    matches: schedule.duel(bots[0], bots[1], schedule.seedList('e2e', 4)), seedLabel: 'e2e' });
  assert.equal(run.results.length, 8);
  for (const file of ['summary.json', 'report.md', 'matches.jsonl']) assert.ok(fs.existsSync(path.join(run.dir, file)));
  assert.equal(fs.readdirSync(path.join(run.dir, 'replays')).length, 8);

  const row = run.summary.table[0];
  assert.equal(row.matches, 8);
  assert.ok(row.scoreLow <= row.score && row.score <= row.scoreHigh);

  const store = new ArenaStore(resultsDir);
  assert.equal(store.leaderboard('classic-v1').length, 2);
  assert.equal(store.currentChampion('classic-v1'), null);
  store.promote({ ruleset: 'classic-v1', bot: bots[0], runId: run.id, note: '测试' });
  assert.equal(store.currentChampion('classic-v1').label, bots[0].id);
  store.close();

  const feedback = buildFeedback('rusher', run.tasks, run.results, run.replayPaths);
  const text = renderFeedback(feedback, run.summary);
  assert.ok(text.includes('失败原因'));
  assert.ok(!text.includes('module.exports'));
});

test('汇总：镜像赛的两个席位归到同一选手', () => {
  const stats = id => ({ [id]: { kills: 0, deaths: 0, suicides: 0, directKills: 0, ricochetKills: 0, shots: 0, forfeits: 0, ticksAlive: 60, wallTicks: 0, stuckTicks: 0, gatedTicks: 0, requestedFlips: 0, actualReversals: 0, shortRuns: 0, runs: 0, turnFlips: 0, firstKillTick: null, deathTick: null } });
  const timing = { calls: 1, totalMs: 1, maxMs: 1, overBudget: 0 };
  const task = { group: 'g', lineup: [{ id: 'x#1', key: 'x' }, { id: 'x#2', key: 'x' }] };
  const match = { result: { players: [{ id: 'x#1', alive: true, forfeit: null }, { id: 'x#2', alive: true, forfeit: null }] },
    stats: { ...stats('x#1'), ...stats('x#2') }, timings: { 'x#1': timing, 'x#2': timing } };
  const summary = summarize([task], [match]);
  assert.equal(summary.table.length, 1);
  assert.equal(summary.table[0].matches, 2);
  assert.equal(summary.table[0].score, 0.5);
});
