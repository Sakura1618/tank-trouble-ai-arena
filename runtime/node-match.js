// 无头比赛：同一 Tick 内所有脚本读同一份观测，全部返回后统一结算。

import { ArenaWorld } from '../engine/world.js';
import { observeDynamic, observeStatic } from '../engine/observation.js';
import { MatchStats } from '../engine/stats.js';
import { IDLE_ACTION, normalizeAction } from '../engine/controls.js';
import { botSeedFor, hashHex } from '../engine/rng.js';
import { getRuleset } from '../rulesets/index.js';
import { ReplayRecorder } from '../replay/format.js';
import { BotFault, NodeBot } from './node-bot.js';

function timing() { return { calls: 0, totalMs: 0, maxMs: 0, overBudget: 0 }; }

// entrants: [{ id, name, color, source, label? }]
export function runMatch({ ruleset: rulesetId, seed, seeds, entrants, maxSeconds, mapStyle, seatRotation = 0, onTick = null }) {
  const ruleset = getRuleset(rulesetId);
  const prepared = entrants.map(e => ({ ...e, sourceHash: e.sourceHash ?? hashHex(e.source) }));
  const world = new ArenaWorld(prepared, { ruleset, seed, seeds, maxSeconds, mapStyle, seatRotation });
  const stats = new MatchStats(world);
  const recorder = new ReplayRecorder(world, { seeds, maxSeconds, mapStyle, seatRotation, entrants: prepared });
  const budget = ruleset.budget;
  const timings = Object.fromEntries(world.actors.map(p => [p.id, timing()]));
  const bots = new Map();
  const faulted = [];
  const fail = (id, error) => {
    const fault = error instanceof BotFault || error.code
      ? { code: error.code, message: error.message, elapsedMs: error.elapsedMs, timeout: !!error.timeout }
      : { code: 'script_error', message: String(error?.message ?? error) };
    bots.delete(id);
    faulted.push({ id, fault });
  };
  const applyFaults = () => {
    // 同 Tick 的故障全部处理完才判胜负，结果不依赖遍历顺序。
    for (const { id, fault } of faulted) { recorder.addForfeit(id, fault); world.forfeit(id, fault); }
    if (faulted.length) world.settle();
    faulted.length = 0;
  };

  let statics = observeStatic(world);
  for (const p of world.actors) {
    const entrant = prepared.find(e => e.id === p.id);
    try {
      bots.set(p.id, new NodeBot({ source: entrant.source, seed: botSeedFor(world.seeds.botSeed, p.id),
        selfId: p.id, playerCount: world.actors.length, statics, budget }));
    } catch (error) { fail(p.id, error); }
  }
  applyFaults();

  let revision = world.mapRevision;
  while (!world.result) {
    if (world.mapRevision !== revision) {
      revision = world.mapRevision;
      statics = observeStatic(world);
      for (const [id, bot] of bots) {
        try { bot.setStatic(statics); } catch (error) { fail(id, error); }
      }
    }
    const actions = {};
    for (const p of world.actors) {
      actions[p.id] = IDLE_ACTION;
      const bot = bots.get(p.id);
      if (!bot || !p.tank.alive) continue;
      try {
        const raw = bot.decide(JSON.stringify(observeDynamic(world, p.id, bot.apiVersion)));
        actions[p.id] = normalizeAction(raw);
        const t = timings[p.id];
        t.calls++;
        t.totalMs += bot.lastElapsedMs;
        t.maxMs = Math.max(t.maxMs, bot.lastElapsedMs);
        if (bot.lastElapsedMs > budget.decisionMs) t.overBudget++;
      } catch (error) { fail(p.id, error); }
    }
    applyFaults();
    if (world.result) break;
    recorder.capture(actions);
    world.step(actions);
    stats.afterStep();
    recorder.afterStep();
    onTick?.(world, actions);
  }

  return {
    result: world.result,
    stats: stats.finish(),
    timings,
    replay: recorder.finish(),
    seat: world.actors.map(p => p.id),
  };
}
