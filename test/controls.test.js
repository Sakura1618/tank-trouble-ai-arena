import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectionGate, normalizeAction, TankControl, validateAction } from '../engine/controls.js';
import { arena, box, classic, stepWith } from './helpers.js';

const STEP = classic.tank.moveSpeed / classic.tickRate;
const dwell = classic.controls.reverseDwellTicks;

test('数字化：小数按四舍五入归入三档，死区内为 0', () => {
  assert.deepEqual(normalizeAction({ move: 0.85, turn: -0.65 }), { move: 1, turn: -1, fire: false, special: false });
  assert.deepEqual(normalizeAction({ move: 0.45, turn: 0.49 }), { move: 0, turn: 0, fire: false, special: false });
  assert.deepEqual(normalizeAction({ move: -0.5, turn: 0.5, fire: true }), { move: -1, turn: 1, fire: true, special: false });
});

test('非法动作判错，不静默裁剪', () => {
  for (const bad of [null, [], { move: 2 }, { turn: NaN }, { fire: 1 }, { special: 'yes' }, { move: Infinity }]) {
    assert.throws(() => validateAction(bad), { code: 'invalid_action' });
  }
  assert.deepEqual(validateAction({}), { move: 0, turn: 0, fire: false, special: false });
});

test('反向门：紧贴上次行驶方向的反向被拦成停车', () => {
  const gate = new DirectionGate(8);
  assert.equal(gate.apply(1, 0), 1);
  assert.equal(gate.apply(-1, 1), 0);
  assert.equal(gate.apply(-1, 8), 0);
  assert.equal(gate.apply(-1, 9), -1);
});

test('反向门：同向和停车永远立即生效', () => {
  const gate = new DirectionGate(8);
  assert.equal(gate.apply(1, 0), 1);
  assert.equal(gate.apply(0, 1), 0);
  assert.equal(gate.apply(1, 2), 1);
  assert.equal(gate.apply(0, 3), 0);
});

test('反向门：静止够久后反向零延迟，正常操控无感', () => {
  const gate = new DirectionGate(8);
  gate.apply(1, 0);
  for (let t = 1; t <= 8; t++) gate.apply(0, t);
  assert.equal(gate.apply(-1, 9), -1);
});

test('反向门：dwell=0 时退化为逐 Tick 直通', () => {
  const gate = new DirectionGate(0);
  assert.equal(gate.apply(1, 0), 1);
  assert.equal(gate.apply(-1, 1), -1);
  assert.equal(gate.apply(1, 2), 1);
});

test('无惯性：起步第一 Tick 就是满速，松手立刻停', () => {
  const world = arena({ walls: box(800, 200), tanks: [{ x: 100, y: 100, angle: 0 }, { x: 700, y: 100, angle: 0 }] });
  const tank = world.byId.get('p0').tank;
  stepWith(world, { p0: { move: 1, turn: 0, fire: false, special: false } });
  assert.ok(Math.abs(tank.x - 100 - STEP) < 1e-9);
  const stopped = tank.x;
  stepWith(world, {});
  assert.equal(tank.x, stopped);
});

test('60Hz 交替请求不再产生逐 Tick 倒退', () => {
  const world = arena({ walls: box(800, 200), tanks: [{ x: 400, y: 100, angle: 0 }, { x: 700, y: 60, angle: 0 }] });
  const actor = world.byId.get('p0');
  let reversals = 0;
  let last = 0;
  for (let t = 0; t < 120; t++) {
    const before = actor.tank.x;
    stepWith(world, { p0: { move: t % 2 ? -1 : 1, turn: 0, fire: false, special: false } });
    const direction = Math.sign(actor.tank.x - before);
    if (direction !== 0 && last !== 0 && direction !== last) reversals++;
    if (direction !== 0) last = direction;
  }
  assert.equal(reversals, 0);
  assert.ok(actor.control.actionFlipCount >= 50, '诊断仍要如实记录脚本的请求翻转');
});

test('持续反向只付出一次停顿', () => {
  const world = arena({ walls: box(800, 200), tanks: [{ x: 400, y: 100, angle: 0 }, { x: 700, y: 60, angle: 0 }] });
  const tank = world.byId.get('p0').tank;
  for (let t = 0; t < 30; t++) stepWith(world, { p0: { move: 1, turn: 0, fire: false, special: false } });
  const before = tank.x;
  let stoppedTicks = 0;
  for (let t = 0; t < dwell + 1; t++) {
    const x = tank.x;
    stepWith(world, { p0: { move: -1, turn: 0, fire: false, special: false } });
    if (tank.x === x) stoppedTicks++;
  }
  assert.equal(stoppedTicks, dwell);
  assert.ok(tank.x < before);
});

test('TankControl 记录请求与实际执行的差异', () => {
  const control = new TankControl(classic.controls, classic.tickRate);
  control.apply({ move: 1, turn: 0 }, 0);
  const applied = control.apply({ move: -1, turn: 0 }, 1);
  assert.deepEqual(applied, { move: 0, turn: 0 });
  assert.equal(control.requestedMove, -1);
  assert.equal(control.appliedMove, 0);
  assert.equal(control.actionFlipCount, 1);
});
