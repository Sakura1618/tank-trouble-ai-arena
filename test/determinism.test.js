import test from 'node:test';
import assert from 'node:assert/strict';
import { ArenaWorld } from '../engine/world.js';
import { hashMaze, hashWorld } from '../engine/hash.js';
import { dcos, dsin, wrapTau } from '../engine/detmath.js';
import { Rng, botSeedFor, deriveSeeds, normalizeSeed } from '../engine/rng.js';
import { getRuleset, RULESETS, rulesetHash } from '../rulesets/index.js';
import { classic, entrants, party } from './helpers.js';

function scripted(tick, index) {
  return { move: (tick >> 5) % 3 - 1, turn: ((tick >> 4) + index) % 3 - 1, fire: tick % 40 === index, special: tick % 90 === 0 };
}

function play(ruleset, seed, list = entrants(4), ticks = 900) {
  const world = new ArenaWorld(list, { ruleset, seed });
  for (let t = 0; t < ticks && !world.result; t++) {
    world.step(Object.fromEntries(world.actors.map((p, i) => [p.id, scripted(t, i)])));
  }
  return world;
}

test('相同种子和动作序列得到逐位相同的结果', () => {
  for (const ruleset of [classic, party]) {
    assert.equal(hashWorld(play(ruleset, 99)), hashWorld(play(ruleset, 99)));
  }
});

test('不同种子产生不同地图', () => {
  const hashes = new Set();
  for (let seed = 0; seed < 50; seed++) hashes.add(hashMaze(new ArenaWorld(entrants(2), { ruleset: classic, seed }).maze));
  assert.equal(hashes.size, 50);
});

test('结果与传入选手的顺序无关', () => {
  const a = entrants(4);
  const b = [...a].reverse();
  const worldA = new ArenaWorld(a, { ruleset: classic, seed: 5 });
  const worldB = new ArenaWorld(b, { ruleset: classic, seed: 5 });
  assert.deepEqual(worldA.actors.map(p => p.id), worldB.actors.map(p => p.id));
  assert.equal(hashWorld(worldA), hashWorld(worldB));
});

test('随机流互相独立：换出生种子不改变地图', () => {
  const base = new ArenaWorld(entrants(2), { ruleset: classic, seed: 7 });
  const other = new ArenaWorld(entrants(2), { ruleset: classic, seed: 7, seeds: { spawnSeed: 123 } });
  assert.equal(hashMaze(base.maze), hashMaze(other.maze));
  assert.notEqual(hashWorld(base), hashWorld(other));
});

test('换边：同图同出生点，只交换席位', () => {
  const a = new ArenaWorld(entrants(2), { ruleset: classic, seed: 11, seatRotation: 0 });
  const b = new ArenaWorld(entrants(2), { ruleset: classic, seed: 11, seatRotation: 1 });
  assert.equal(hashMaze(a.maze), hashMaze(b.maze));
  const spot = (world, id) => { const t = world.byId.get(id).tank; return [t.x, t.y, t.angle]; };
  assert.deepEqual(spot(a, 'p0'), spot(b, 'p1'));
  assert.deepEqual(spot(a, 'p1'), spot(b, 'p0'));
});

test('引擎不碰全局随机数和墙钟', () => {
  const random = Math.random;
  const now = Date.now;
  Math.random = () => { throw new Error('引擎调用了 Math.random'); };
  Date.now = () => { throw new Error('引擎调用了 Date.now'); };
  try {
    play(party, 3, entrants(4), 1800);
    play(classic, 3, entrants(2), 600);
  } finally {
    Math.random = random;
    Date.now = now;
  }
});

test('基准尺寸：双人局 9×7，四人局按面积放大', () => {
  assert.deepEqual([new ArenaWorld(entrants(2), { ruleset: classic, seed: 1 }).maze.cols, new ArenaWorld(entrants(2), { ruleset: classic, seed: 1 }).maze.rows], [9, 7]);
  const four = new ArenaWorld(entrants(4), { ruleset: classic, seed: 1 }).maze;
  assert.deepEqual([four.cols, four.rows], [13, 10]);
});

test('出生点两两至少相隔两格，且都在场内', () => {
  for (let seed = 0; seed < 200; seed++) {
    const world = new ArenaWorld(entrants(4), { ruleset: classic, seed });
    const tanks = world.actors.map(p => p.tank);
    for (let i = 0; i < tanks.length; i++) {
      for (let j = i + 1; j < tanks.length; j++) {
        assert.ok(Math.hypot(tanks[i].x - tanks[j].x, tanks[i].y - tanks[j].y) >= 2 * 96 - 1e-9);
      }
    }
  }
});

test('地图全连通且有掩体', () => {
  for (let seed = 0; seed < 300; seed++) {
    const { maze } = new ArenaWorld(entrants(2), { ruleset: classic, seed });
    const seen = new Set(['0,0']);
    const stack = [[0, 0]];
    while (stack.length) {
      const [c, r] = stack.pop();
      for (const [dc, dr, side] of [[0, -1, 'top'], [1, 0, 'right'], [0, 1, 'bottom'], [-1, 0, 'left']]) {
        const key = `${c + dc},${r + dr}`;
        if (maze.cells[r][c][side] || seen.has(key)) continue;
        seen.add(key);
        stack.push([c + dc, r + dr]);
      }
    }
    assert.equal(seen.size, maze.cols * maze.rows);
    assert.ok(maze.walls.filter(w => !w.border).length >= 142 * classic.map.minDensity);
  }
});

test('确定性三角函数与原生结果误差在 2 ulp 内', () => {
  const rng = new Rng(1);
  for (let i = 0; i < 20000; i++) {
    const x = (rng.next() - 0.5) * 40;
    assert.ok(Math.abs(dsin(x) - Math.sin(x)) < 5e-16);
    assert.ok(Math.abs(dcos(x) - Math.cos(x)) < 5e-16);
  }
  assert.equal(dsin(0), 0);
  assert.equal(dcos(0), 1);
  assert.equal(wrapTau(-0.5), Math.PI * 2 - 0.5);
});

test('种子：数字、数字字符串、任意字符串都能归一化', () => {
  assert.equal(normalizeSeed(42), 42);
  assert.equal(normalizeSeed('42'), 42);
  assert.equal(normalizeSeed('alpha'), normalizeSeed('alpha'));
  assert.throws(() => normalizeSeed(''));
  assert.throws(() => normalizeSeed(NaN));
  assert.notEqual(deriveSeeds(1).mapSeed, deriveSeeds(1).spawnSeed);
  assert.notEqual(botSeedFor(1, 'a'), botSeedFor(1, 'b'));
});

test('sfc32 输出稳定，改算法会被这里拦下', () => {
  const rng = new Rng(12345);
  assert.deepEqual([rng.uint(), rng.uint(), rng.uint()], GOLDEN.rng);
});

test('classic-v1 已冻结：规则和生成结果与基线一致', () => {
  assert.equal(rulesetHash(getRuleset('classic-v1')), GOLDEN.rulesetHash);
  assert.equal(hashMaze(new ArenaWorld(entrants(2), { ruleset: classic, seed: 12345 }).maze), GOLDEN.mazeHash);
  assert.equal(hashWorld(play(classic, 12345, entrants(2), 600)), GOLDEN.worldHash);
});

test('规则集深度冻结，运行中无法被改动', () => {
  assert.throws(() => { 'use strict'; RULESETS['classic-v1'].tank.moveSpeed = 999; }, TypeError);
  assert.throws(() => getRuleset('nope'));
});

// 这些值是 classic-v1 的发布基线。变化意味着旧录像失效：应新建规则集版本，而不是改这里。
const GOLDEN = {
  rng: [1836715410, 4293266890, 3456613160],
  rulesetHash: '6e4762b268e43d07',
  mazeHash: 'aa52b6999d628fcb',
  worldHash: 'f5d25b9577bb946c',
};
