// 物理回归：方案要求的九个场景，加上修复过的假法线和二次反射。

import test from 'node:test';
import assert from 'node:assert/strict';
import { Bullet } from '../engine/bullet.js';
import { Tank } from '../engine/tank.js';
import { generateMaze } from '../engine/maze.js';
import { Rng } from '../engine/rng.js';
import { distanceToSegment, resolveCircleWalls, segmentVsSegmentParam } from '../engine/geometry.js';
import { arena, box, classic, DT, stepWith, wall } from './helpers.js';

const R = classic.tank.radius;
const bulletRules = { ...classic.bullet, tickRate: classic.tickRate };

const near = (actual, expected, epsilon = 1e-9) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} ≠ ${expected}`);

function drive(tank, walls, move, turn, ticks) {
  for (let i = 0; i < ticks; i++) tank.update(DT, walls, { move, turn });
}

function clearance(x, y, walls) {
  return Math.min(...walls.map(w => distanceToSegment(x, y, w.x1, w.y1, w.x2, w.y2)));
}

test('场景 1：坦克正面撞墙后贴住墙面，不穿透也不回弹', () => {
  const walls = box(400, 400);
  const tank = new Tank(100, 200, Math.PI, '#000000', classic);
  drive(tank, walls, 1, 0, 120);
  near(tank.x, R);
  near(tank.y, 200, 1e-6);
  const settled = tank.x;
  drive(tank, walls, 1, 0, 30);
  assert.equal(tank.x, settled);
});

test('场景 2：沿墙滑动穿过墙段接缝时不被顶偏', () => {
  // 一面长墙由多段组成，正是地图的真实结构。
  const walls = [wall(0, 0, 96, 0), wall(96, 0, 192, 0), wall(192, 0, 288, 0), wall(288, 0, 384, 0)];
  const tank = new Tank(20, R + 4, -0.2, '#000000', classic);
  let previousX = tank.x;
  let wobble = 0;
  for (let i = 0; i < 120; i++) {
    tank.update(DT, walls, { move: 1, turn: 0 });
    const stepX = tank.x - previousX;
    previousX = tank.x;
    if (tank.y <= R + 1e-9) wobble = Math.max(wobble, Math.abs(stepX - 2 * Math.cos(0.2)));
  }
  near(tank.y, R);
  assert.ok(wobble < 1e-9, `沿墙速度出现 ${wobble}px 的波动`);
});

test('场景 3：坦克顶进墙角后稳定停住', () => {
  const walls = box(400, 400);
  const tank = new Tank(100, 100, Math.PI * 1.25, '#000000', classic);
  drive(tank, walls, 1, 0, 150);
  near(tank.x, R);
  near(tank.y, R);
  const { x, y } = tank;
  drive(tank, walls, 1, 0, 30);
  assert.deepEqual([tank.x, tank.y], [x, y]);
});

test('场景 4：贴墙原地旋转不改变位置', () => {
  const walls = box(400, 400);
  const tank = new Tank(R, 200, 0, '#000000', classic);
  drive(tank, walls, 0, 1, 180);
  assert.deepEqual([tank.x, tank.y], [R, 200]);
  assert.ok(tank.angle >= 0 && tank.angle < Math.PI * 2);
});

test('场景 5：两辆坦克互相顶住时不穿模、不弹跳', () => {
  const world = arena({ walls: box(400, 200), tanks: [{ x: 100, y: 100, angle: 0 }, { x: 300, y: 100, angle: Math.PI }] });
  const push = { move: 1, turn: 0, fire: false, special: false };
  const positions = [];
  for (let i = 0; i < 180; i++) {
    stepWith(world, { p0: push, p1: push });
    positions.push(world.byId.get('p0').tank.x);
  }
  const [a, b] = world.actors.map(p => p.tank);
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= R * 2 - 1e-9);
  const tail = positions.slice(-30);
  assert.equal(Math.max(...tail) - Math.min(...tail), 0, '对顶时位置应完全静止');
  assert.ok(world.byId.get('p0').motion.tankX !== 0, '诊断应记录互推修正');
});

test('场景 5b：被顶到墙上的坦克不会被挤穿墙', () => {
  const world = arena({ walls: box(400, 200), tanks: [{ x: 60, y: 100, angle: 0 }, { x: R + 1, y: 100, angle: 0 }] });
  const push = { move: 1, turn: 0, fire: false, special: false };
  for (let i = 0; i < 180; i++) {
    stepWith(world, { p0: { ...push, move: -1 } });
    const victim = world.byId.get('p1').tank;
    assert.ok(victim.x >= R - 1e-9, `第 ${i} Tick 被挤到 ${victim.x}`);
  }
});

test('场景 6：极小角度掠射按镜面反射，不穿墙', () => {
  const walls = [wall(0, 100, 2000, 100)];
  const speed = classic.bullet.speed;
  const angle = 0.01;
  const b = new Bullet(0, 90, speed * Math.cos(angle), speed * Math.sin(angle), null, bulletRules);
  for (let i = 0; i < 600 && b.bounces === 0; i++) b.update(DT, walls);
  assert.equal(b.bounces, 1);
  near(b.vx, speed * Math.cos(angle), 1e-6);
  near(b.vy, -speed * Math.sin(angle), 1e-6);
  assert.ok(b.y < 100);
  for (let i = 0; i < 60; i++) b.update(DT, walls);
  assert.equal(b.bounces, 1, '离开墙面后不应再次反射');
});

test('场景 7：炮弹射进直角墙角后原路返回', () => {
  const walls = box(300, 300);
  const v = classic.bullet.speed / Math.SQRT2;
  const b = new Bullet(100, 100, -v, -v, null, bulletRules);
  for (let i = 0; i < 120 && b.bounces < 2; i++) b.update(DT, walls);
  assert.equal(b.bounces, 2);
  near(b.vx, v, 1e-6);
  near(b.vy, v, 1e-6);
});

test('场景 7b：墙段接缝不产生假法线', () => {
  // 炮弹擦着两段墙的公共端点撞上去，反射必须是干净的水平墙反射。
  const walls = [wall(0, 100, 96, 100), wall(96, 100, 192, 100)];
  const speed = classic.bullet.speed;
  for (const x of [90, 95, 96, 97, 102]) {
    const b = new Bullet(x, 80, 0, speed, null, bulletRules);
    for (let i = 0; i < 60 && b.bounces === 0; i++) b.update(DT, walls);
    assert.equal(b.bounces, 1);
    near(b.vx, 0, 1e-9);
    near(b.vy, -speed, 1e-9);
  }
});

test('场景 8：随机迷宫里连续反弹 10 秒，炮弹从不穿墙、不减速', () => {
  const rng = new Rng(20261106);
  const options = { ...classic.map, wallHp: 5 };
  for (let m = 0; m < 12; m++) {
    const maze = generateMaze(9, 7, 'sparse', rng, options);
    for (let n = 0; n < 12; n++) {
      const a = rng.next() * Math.PI * 2;
      const cell = 96;
      const speed = classic.bullet.speed;
      const b = new Bullet((rng.int(9) + 0.5) * cell, (rng.int(7) + 0.5) * cell, Math.cos(a) * speed, Math.sin(a) * speed, null, bulletRules);
      for (let t = 0; t < 600 && !b.dead; t++) {
        const px = b.x;
        const py = b.y;
        b.update(DT, maze.walls);
        if (b.dead) break;
        for (const w of maze.walls) {
          assert.equal(segmentVsSegmentParam(px, py, b.x, b.y, w.x1, w.y1, w.x2, w.y2), null, `第 ${t} Tick 穿墙`);
        }
        assert.ok(b.x > 0 && b.y > 0 && b.x < 9 * cell && b.y < 7 * cell);
        near(Math.hypot(b.vx, b.vy), speed, 1e-6);
      }
      assert.ok(b.dead, '炮弹应在寿命结束时消失');
    }
  }
});

test('场景 9：同一 Tick 互相命中判为同归于尽', () => {
  const walls = box(600, 200);
  const world = arena({ walls, tanks: [{ x: 100, y: 100, angle: 0 }, { x: 500, y: 100, angle: Math.PI }] });
  const shoot = { move: 0, turn: 0, fire: true, special: false };
  const hold = { move: 0, turn: 0, fire: false, special: false };
  stepWith(world, { p0: shoot, p1: shoot });
  for (let i = 0; i < 300 && !world.result; i++) stepWith(world, { p0: hold, p1: hold });
  assert.equal(world.result.reason, 'mutual');
  assert.equal(world.result.winnerId, null);
  assert.deepEqual(world.actors.map(p => p.kills), [1, 1]);
});

test('场景 9b：一枚炮弹只结算一个目标', () => {
  const walls = box(600, 200);
  const world = arena({ walls, tanks: [{ x: 100, y: 100, angle: 0 }, { x: 300, y: 100, angle: 0 }, { x: 340, y: 100, angle: 0 }] });
  stepWith(world, { p0: { move: 0, turn: 0, fire: true, special: false } });
  for (let i = 0; i < 120 && world.alive.length === 3; i++) stepWith(world, {});
  assert.equal(world.alive.length, 2);
  assert.equal(world.bullets.length, 0);
});

test('贴墙开炮：炮弹不穿到墙背面，弹回来能打死自己', () => {
  const walls = box(400, 400);
  const world = arena({ walls, tanks: [{ x: R + 1, y: 200, angle: Math.PI }, { x: 300, y: 60, angle: 0 }] });
  stepWith(world, { p0: { move: 0, turn: 0, fire: true, special: false } });
  const fire = world.events.find(e => e.type === 'fire');
  assert.ok(fire.x > 0, '炮口被压回墙内侧');
  assert.equal(world.result.winnerId, 'p1');
  assert.equal(world.events.find(e => e.type === 'death').classification, 'suicide');
  assert.equal(world.byId.get('p1').kills, 0);
});

test('resolveCircleWalls：任意位置解算后都满足最小间距', () => {
  const rng = new Rng(7);
  const maze = generateMaze(9, 7, 'sparse', rng, { ...classic.map, wallHp: 5 });
  for (let i = 0; i < 500; i++) {
    const x = R + rng.next() * (9 * 96 - 2 * R);
    const y = R + rng.next() * (7 * 96 - 2 * R);
    const fixed = resolveCircleWalls(x, y, R, maze.walls);
    assert.ok(clearance(fixed.x, fixed.y, maze.walls) >= R - 1e-6);
  }
});
