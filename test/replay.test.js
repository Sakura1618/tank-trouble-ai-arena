import test from 'node:test';
import assert from 'node:assert/strict';
import { ArenaWorld } from '../engine/world.js';
import { IDLE_ACTION, normalizeAction } from '../engine/controls.js';
import { decodeRuns, encodeRuns, packAction, ReplayRecorder, ReplaySession, unpackAction, verifyReplay } from '../replay/format.js';
import { classic, entrants, party } from './helpers.js';

function record(ruleset = classic, seed = 31, ticks = 800, forfeit = null) {
  const list = entrants(3);
  const world = new ArenaWorld(list, { ruleset, seed });
  const recorder = new ReplayRecorder(world, { entrants: list });
  for (let t = 0; t < ticks && !world.result; t++) {
    if (forfeit && t === forfeit.tick) {
      recorder.addForfeit(forfeit.id, { code: 'script_error', message: '测试' });
      world.forfeit(forfeit.id, { code: 'script_error', message: '测试' });
      world.settle();
      if (world.result) break;
    }
    const actions = {};
    world.actors.forEach((p, i) => {
      actions[p.id] = p.tank.alive ? normalizeAction({ move: (t >> 4) % 3 - 1, turn: ((t >> 3) + i) % 3 - 1, fire: t % 50 === i * 7, special: t % 70 === 0 }) : IDLE_ACTION;
    });
    recorder.capture(actions);
    world.step(actions);
    recorder.afterStep();
  }
  world.result ??= { winnerId: null, reason: 'timeout', ticks: world.tick, players: [] };
  return recorder.finish();
}

test('动作编码覆盖全部 36 种组合', () => {
  for (const move of [-1, 0, 1]) {
    for (const turn of [-1, 0, 1]) {
      for (const fire of [false, true]) {
        for (const special of [false, true]) {
          const action = { move, turn, fire, special };
          assert.deepEqual(unpackAction(packAction(action)), action);
        }
      }
    }
  }
});

test('行程编码可逆，且对长时间不变的动作很紧凑', () => {
  const values = [4, 4, 4, 13, 13, 4, 0];
  assert.deepEqual(decodeRuns(encodeRuns(values)), values);
  assert.equal(encodeRuns(new Array(3600).fill(4)).length, 2);
});

test('录像重算与原比赛逐位一致', () => {
  for (const ruleset of [classic, party]) {
    const replay = record(ruleset);
    assert.ok(verifyReplay(JSON.parse(JSON.stringify(replay))).ok);
  }
});

test('判负事件在正确的 Tick 重放', () => {
  const replay = record(classic, 8, 600, { tick: 120, id: 'p1' });
  assert.ok(verifyReplay(replay).ok);
  const session = new ReplaySession(replay);
  while (session.step());
  assert.equal(session.world.byId.get('p1').forfeit.code, 'script_error');
});

test('改一个动作就能被检查点发现，并报告分叉位置', () => {
  const replay = record();
  // 开局全员存活，改这一 Tick 一定会改变后续状态。
  for (const id of Object.keys(replay.actions)) {
    const runs = decodeRuns(replay.actions[id]);
    runs[5] = packAction({ move: 1, turn: 1, fire: true, special: false });
    replay.actions[id] = encodeRuns(runs);
  }
  const report = verifyReplay(replay);
  assert.equal(report.ok, false);
  assert.ok(report.firstMismatchTick >= 5);
});

test('破墙规则下每帧保留当时的墙耐久', async () => {
  const { snapshotWorld } = await import('../viewer/render/frame.js');
  const world = new ArenaWorld(entrants(2), { ruleset: party, seed: 1 });
  const before = snapshotWorld(world);
  world.maze.walls.find(w => !w.border).hp = 1;
  assert.equal(before.walls.find(w => !w.border).hp, party.wall.hp);
});

test('规则集指纹不符时拒绝回放', () => {
  const replay = record();
  replay.ruleset.hash = '0000000000000000';
  assert.throws(() => verifyReplay(replay), /规则集/);
});

test('非录像文件被拒绝', () => {
  assert.throws(() => verifyReplay({ format: 'x' }), /录像/);
});

test('60 秒双人比赛录像保持在几十 KB 以内', () => {
  const replay = record(classic, 2, 3600);
  assert.ok(JSON.stringify(replay).length < 64 * 1024);
});
