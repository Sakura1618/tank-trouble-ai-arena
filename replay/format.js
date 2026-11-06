// 录像格式：只存比赛的“原因”——规则、种子、参赛者、每 Tick 动作，
// 回放时重新跑一遍引擎。一局 60 秒双人比赛通常只有几 KB。
// 周期性状态哈希是复现的证据：引擎、规则或数学一旦漂移，校验会精确报告从第几 Tick 开始分叉。

import { ArenaWorld } from '../engine/world.js';
import { hashWorld } from '../engine/hash.js';
import { getRuleset, rulesetHash } from '../rulesets/index.js';

export const REPLAY_FORMAT = 'tank-arena-replay';
export const REPLAY_VERSION = 1;
export const CHECKPOINT_TICKS = 300;

export function packAction({ move, turn, fire, special }) {
  return (move + 1) + 3 * (turn + 1) + (fire ? 9 : 0) + (special ? 18 : 0);
}

export function unpackAction(value) {
  return {
    move: (value % 3) - 1,
    turn: (Math.floor(value / 3) % 3) - 1,
    fire: Math.floor(value / 9) % 2 === 1,
    special: Math.floor(value / 18) === 1,
  };
}

// 行程编码：[value, count, value, count, ...]
export function encodeRuns(values) {
  const runs = [];
  for (const value of values) {
    if (runs.length && runs[runs.length - 2] === value) runs[runs.length - 1]++;
    else runs.push(value, 1);
  }
  return runs;
}

export function decodeRuns(runs) {
  const values = [];
  for (let i = 0; i < runs.length; i += 2) {
    for (let n = 0; n < runs[i + 1]; n++) values.push(runs[i]);
  }
  return values;
}

export class ReplayRecorder {
  // setup: 构造 ArenaWorld 需要的全部参数，加上 entrants 的 sourceHash。
  constructor(world, setup) {
    this.world = world;
    this.setup = setup;
    this.actions = Object.fromEntries(world.actors.map(p => [p.id, []]));
    this.forfeits = [];
    this.checkpoints = [{ tick: 0, hash: hashWorld(world) }];
  }

  addForfeit(id, fault) {
    this.forfeits.push({ tick: this.world.tick, id, code: fault.code, message: fault.message ?? '' });
  }

  // 记录归一化后的请求动作。控制门是确定性的，回放时会重新计算。
  capture(actions) {
    for (const p of this.world.actors) this.actions[p.id].push(packAction(actions[p.id]));
  }

  afterStep() {
    if (this.world.tick % CHECKPOINT_TICKS === 0) this.checkpoints.push({ tick: this.world.tick, hash: hashWorld(this.world) });
  }

  finish() {
    const { world, setup } = this;
    return {
      format: REPLAY_FORMAT,
      version: REPLAY_VERSION,
      ruleset: { id: world.ruleset.id, hash: rulesetHash(world.ruleset) },
      seed: world.seeds.seed,
      seeds: setup.seeds ?? null,
      maxSeconds: setup.maxSeconds ?? null,
      mapStyle: setup.mapStyle ?? null,
      seatRotation: setup.seatRotation ?? 0,
      entrants: setup.entrants.map(({ id, name, color, sourceHash, label }) => ({ id, name, color, sourceHash: sourceHash ?? null, label: label ?? null })),
      actions: Object.fromEntries(Object.entries(this.actions).map(([id, values]) => [id, encodeRuns(values)])),
      forfeits: this.forfeits,
      checkpoints: this.checkpoints,
      result: world.result,
      finalHash: hashWorld(world),
    };
  }
}

export function assertReplay(replay) {
  if (replay?.format !== REPLAY_FORMAT) throw new Error('不是竞技场录像文件');
  if (replay.version !== REPLAY_VERSION) throw new Error(`不支持的录像版本：${replay.version}`);
  const ruleset = getRuleset(replay.ruleset.id);
  const hash = rulesetHash(ruleset);
  if (hash !== replay.ruleset.hash) {
    throw new Error(`规则集 ${replay.ruleset.id} 已变化：录像 ${replay.ruleset.hash}，当前 ${hash}`);
  }
  return ruleset;
}

// 可逐 Tick 推进的回放会话，校验和网页回放共用。
export class ReplaySession {
  constructor(replay, { recording = false } = {}) {
    const ruleset = assertReplay(replay);
    this.replay = replay;
    this.world = new ArenaWorld(replay.entrants, {
      ruleset, seed: replay.seed, seeds: replay.seeds ?? undefined,
      maxSeconds: replay.maxSeconds ?? undefined, mapStyle: replay.mapStyle ?? undefined,
      seatRotation: replay.seatRotation, recording,
    });
    this.actions = Object.fromEntries(Object.entries(replay.actions).map(([id, runs]) => [id, decodeRuns(runs)]));
    this.forfeits = [...replay.forfeits];
  }

  applyForfeits() {
    const { world } = this;
    const due = this.forfeits.filter(f => f.tick === world.tick);
    for (const f of due) world.forfeit(f.id, { code: f.code, message: f.message, timeout: f.code.endsWith('_timeout') });
    if (due.length) world.settle();
  }

  // 推进一个 Tick；比赛结束返回 false。
  step() {
    const { world } = this;
    if (world.result) return false;
    this.applyForfeits();
    if (world.result) return false;
    const actions = {};
    for (const p of world.actors) actions[p.id] = unpackAction(this.actions[p.id][world.tick] ?? 4);
    world.step(actions);
    return !world.result;
  }
}

// 从头重算整局，逐检查点比对。ok=false 时 firstMismatchTick 是最早发现分叉的检查点。
export function verifyReplay(replay) {
  const session = new ReplaySession(replay);
  const { world } = session;
  const checkpoints = new Map(replay.checkpoints.map(c => [c.tick, c.hash]));
  const check = () => {
    const expected = checkpoints.get(world.tick);
    return expected === undefined || expected === hashWorld(world);
  };
  if (!check()) return { ok: false, firstMismatchTick: 0, reason: 'initial_state' };
  while (session.step()) {
    if (!check()) return { ok: false, firstMismatchTick: world.tick, reason: 'checkpoint' };
  }
  if (!world.result) session.step();
  const finalHash = hashWorld(world);
  if (finalHash !== replay.finalHash) return { ok: false, firstMismatchTick: world.tick, reason: 'final_state' };
  if (JSON.stringify(world.result.winnerId) !== JSON.stringify(replay.result.winnerId) || world.result.ticks !== replay.result.ticks) {
    return { ok: false, firstMismatchTick: world.tick, reason: 'result' };
  }
  return { ok: true, ticks: world.tick, checkpoints: replay.checkpoints.length, finalHash };
}
