import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BotFault, NodeBot } from '../runtime/node-bot.js';
import { runMatch } from '../runtime/node-match.js';
import { verifyReplay } from '../replay/format.js';
import { classic, entrants } from './helpers.js';
import { ArenaWorld } from '../engine/world.js';
import { observeDynamic, observeStatic } from '../engine/observation.js';

const budget = classic.budget;

function fixture() {
  const world = new ArenaWorld(entrants(2), { ruleset: classic, seed: 1 });
  return { world, statics: observeStatic(world) };
}

function bot(source, seed = 1, overrides = {}) {
  const { world, statics } = fixture();
  const instance = new NodeBot({ source, seed, selfId: 'p0', playerCount: 2, statics, budget: { ...budget, ...overrides } });
  return { instance, world, tick: () => JSON.stringify(observeDynamic(world, 'p0', instance.apiVersion)) };
}

const source = name => fs.readFileSync(new URL(`../bots/${name}.js`, import.meta.url), 'utf8');
const reader = expression => `module.exports = { update(state) { globalThis.__out = (${expression}); return { move: 0, turn: 0 }; } };`;

test('Math.random 由比赛种子决定', () => {
  const code = 'module.exports = { update() { return { move: Math.random() > 2 ? 1 : 0, turn: 0, fire: false, special: false, x: 1 }; }, }; globalThis.first = [Math.random(), Math.random()];';
  const read = seed => { const b = bot(code, seed); return b.instance.context.first; };
  assert.deepEqual([...read(7)], [...read(7)]);
  assert.notDeepEqual([...read(7)], [...read(8)]);
});

test('时钟是虚拟的：由 Tick 决定，真实耗时不可见', () => {
  const b = bot(reader('[Date.now(), performance.now(), new Date().getTime()]'));
  b.instance.decide(b.tick());
  assert.deepEqual([...b.instance.context.__out], [0, 0, 0]);
  b.world.tick = 60;
  b.instance.decide(b.tick());
  const [date, perf] = b.instance.context.__out;
  assert.ok(Math.abs(date - 1000) < 1e-6);
  assert.ok(Math.abs(perf - 1000) < 1e-6);
});

test('显式日期参数仍然可用', () => {
  const b = bot(reader('new Date(2020, 0, 1).getFullYear()'));
  b.instance.decide(b.tick());
  assert.equal(b.instance.context.__out, 2020);
});

test('沙箱里没有 Node 能力和外部通信接口', () => {
  const b = bot(reader('[typeof require, typeof process, typeof fetch, typeof setTimeout, typeof WebSocket, typeof crypto].join()'));
  b.instance.decide(b.tick());
  assert.equal(b.instance.context.__out, 'undefined,undefined,undefined,undefined,undefined,undefined');
});

test('死循环被硬时限拦下并记为超时', () => {
  const b = bot('module.exports = { update() { for (;;) {} } };', 1, { hardMs: 30 });
  assert.throws(() => b.instance.decide(b.tick()), error => error instanceof BotFault && error.code === 'unresponsive_timeout' && error.timeout);
});

test('顶层死循环被初始化时限拦下', () => {
  assert.throws(() => bot('for (;;) {}', 1, { initMs: 30 }), error => error.code === 'init_timeout');
});

test('异常和缺失入口都归类为脚本错误', () => {
  const b = bot('module.exports = { update() { throw new Error("boom"); } };');
  assert.throws(() => b.instance.decide(b.tick()), error => error.code === 'script_error' && /boom/.test(error.message));
  assert.throws(() => bot('module.exports = {};'), error => error.code === 'script_error');
  assert.throws(() => bot('syntax error here'), error => error.code === 'script_error');
});

test('API v2：init 只调用一次，this 上的记忆跨 Tick 保留', () => {
  const b = bot(`module.exports = {
    apiVersion: 2,
    init(context) { this.memory = { calls: 0, cols: context.map.cols, id: context.selfId, players: context.playerCount }; },
    update(state) {
      this.memory.calls++;
      globalThis.__out = [this.memory.calls, this.memory.cols, this.memory.id, this.memory.players, state.apiVersion, typeof state.self.actionFlipCount];
      return { move: 1, turn: 0 };
    },
  };`);
  assert.equal(b.instance.apiVersion, 2);
  b.instance.decide(b.tick());
  b.instance.decide(b.tick());
  assert.deepEqual([...b.instance.context.__out], [2, 9, 'p0', 2, 2, 'number']);
});

test('API v1 脚本继续收到 apiVersion=1 和原有字段', () => {
  const b = bot(reader('[state.apiVersion, typeof state.self.actionFlipCount, state.map.cols, state.physics.moveSpeed, state.rules.wallBreak].join()'));
  assert.equal(b.instance.apiVersion, 1);
  b.instance.decide(b.tick());
  assert.equal(b.instance.context.__out, '1,undefined,9,120,false');
});

const lineup = (a, b) => [
  { id: 'a', name: a, color: '#111111', source: source(a) },
  { id: 'b', name: b, color: '#222222', source: source(b) },
];

test('同一批脚本和种子，比赛完全复现，包括使用 Math.random 和墙钟的脚本', () => {
  for (const [a, b] of [['deepseek-basic', 'astra-g1-sovereign'], ['rusher', 'scout']]) {
    const first = runMatch({ seed: 2024, entrants: lineup(a, b), maxSeconds: 6 });
    const second = runMatch({ seed: 2024, entrants: lineup(a, b), maxSeconds: 6 });
    assert.equal(first.replay.finalHash, second.replay.finalHash);
    assert.deepEqual(first.replay.actions, second.replay.actions);
  }
});

test('无头比赛产出的录像可以脱离脚本逐位重算', () => {
  const match = runMatch({ seed: 77, entrants: lineup('rusher', 'scout'), maxSeconds: 20 });
  const report = verifyReplay(JSON.parse(JSON.stringify(match.replay)));
  assert.ok(report.ok, JSON.stringify(report));
  assert.equal(report.finalHash, match.replay.finalHash);
});

test('故障选手判负，对手获胜，录像记录判负并能重算', () => {
  const match = runMatch({ seed: 5, maxSeconds: 5, entrants: [
    { id: 'bad', name: 'bad', color: '#111111', source: 'module.exports = { update(s) { if (s.tick === 30) throw new Error("x"); return { move: 1 }; } };' },
    { id: 'ok', name: 'ok', color: '#222222', source: 'module.exports = { update() { return {}; } };' },
  ] });
  assert.equal(match.result.winnerId, 'ok');
  assert.equal(match.replay.forfeits[0].tick, 30);
  assert.equal(match.stats.ok.kills, 0);
  assert.ok(verifyReplay(match.replay).ok);
});

test('非法动作判负，不静默修正', () => {
  const match = runMatch({ seed: 5, maxSeconds: 5, entrants: [
    { id: 'bad', name: 'bad', color: '#111111', source: 'module.exports = { update() { return { move: 5 }; } };' },
    { id: 'ok', name: 'ok', color: '#222222', source: 'module.exports = { update() { return {}; } };' },
  ] });
  assert.equal(match.result.winnerId, 'ok');
  assert.equal(match.result.players.find(p => p.id === 'bad').forfeit.code, 'invalid_action');
});

test('NaN 和 Infinity 判负，不会被 JSON 变成缺省值', () => {
  for (const value of ['NaN', 'Infinity', '-Infinity']) {
    const match = runMatch({ seed: 5, maxSeconds: 2, entrants: [
      { id: 'bad', name: 'bad', color: '#111111', source: `module.exports = { update() { return { turn: ${value} }; } };` },
      { id: 'ok', name: 'ok', color: '#222222', source: 'module.exports = { update() { return {}; } };' },
    ] });
    assert.equal(match.result.winnerId, 'ok');
  }
});

test('全部脚本都无法加载时全员判负', () => {
  const match = runMatch({ seed: 5, maxSeconds: 5, entrants: [
    { id: 'a', name: 'a', color: '#111111', source: 'nope(' },
    { id: 'b', name: 'b', color: '#222222', source: 'nope(' },
  ] });
  assert.equal(match.result.reason, 'all_forfeit');
  assert.equal(match.result.winnerId, null);
});

test('派对规则：破墙时地图更新会同步给脚本', () => {
  const code = 'module.exports = { update(s) { return { move: 1, turn: s.tick % 40 < 10 ? 1 : 0, fire: true }; } };';
  const match = runMatch({ ruleset: 'party-v1', seed: 9, maxSeconds: 12, entrants: [
    { id: 'a', name: 'a', color: '#111111', source: code },
    { id: 'b', name: 'b', color: '#222222', source: code },
  ] });
  assert.ok(verifyReplay(match.replay).ok);
});
