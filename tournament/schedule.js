// 赛程：把模式展开成确定的比赛列表。同一组参数永远展开出同样的赛程。
// 一个 group 是“同图同出生点、只换席位”的一组比赛，地图和出生优势在组内抵消。

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { hashString } from '../engine/rng.js';
import { ROOT } from './bots.js';

export function seedList(suite, count) {
  return Array.from({ length: count }, (_, i) => hashString(`${suite}:${i}`));
}

// 基准种子集随仓库发布，所有版本在同样的地图上比较。
export function loadSuite(id) {
  const file = path.join(ROOT, 'benchmarks', `${id}.json`);
  if (!fs.existsSync(file)) throw new Error(`找不到基准集：${id}`);
  const suite = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { ...suite, seeds: suite.seeds ?? seedList(suite.id, suite.count) };
}

// 留出集：种子由本机私有盐派生，不进仓库，日常调参看不到，用来发现对训练地图的过拟合。
export function holdoutSeeds(resultsDir, count) {
  const saltFile = path.join(resultsDir, '.holdout-salt');
  let salt = process.env.ARENA_HOLDOUT_SALT;
  if (!salt) {
    if (!fs.existsSync(saltFile)) {
      fs.mkdirSync(resultsDir, { recursive: true });
      fs.writeFileSync(saltFile, randomBytes(16).toString('hex'));
    }
    salt = fs.readFileSync(saltFile, 'utf8').trim();
  }
  return seedList(`holdout:${salt}`, count);
}

function matchesFor(lineup, seeds, { rotations, mode }) {
  const out = [];
  seeds.forEach((seed, seedIndex) => {
    for (let rotation = 0; rotation < rotations; rotation++) {
      out.push({ mode, group: `${lineup.map(e => e.id).join('|')}:${seedIndex}`, seed, seatRotation: rotation, lineup });
    }
  });
  return out;
}

const entrant = (bot, id = bot.id) => ({ id, key: bot.id, name: bot.name, color: bot.color, sourceHash: bot.hash });

export function duel(a, b, seeds) {
  return matchesFor([entrant(a), entrant(b)], seeds, { rotations: 2, mode: 'duel' });
}

// 自己打自己：先后手胜率应接近 50%，差距大说明出生位或席位存在偏差。
export function mirror(bot, seeds) {
  return matchesFor([entrant(bot, `${bot.id}#1`), entrant(bot, `${bot.id}#2`)], seeds, { rotations: 2, mode: 'mirror' });
}

export function melee(bots, seeds) {
  return matchesFor(bots.map(b => entrant(b)), seeds, { rotations: bots.length, mode: 'melee' });
}

export function gauntlet(challenger, pool, seeds) {
  return pool.filter(b => b.id !== challenger.id).flatMap(b => duel(challenger, b, seeds))
    .map(m => ({ ...m, mode: 'gauntlet' }));
}

export function roundRobin(bots, seeds) {
  const out = [];
  for (let i = 0; i < bots.length; i++) {
    for (let j = i + 1; j < bots.length; j++) out.push(...duel(bots[i], bots[j], seeds));
  }
  return out.map(m => ({ ...m, mode: 'round-robin' }));
}

export function numberMatches(matches) {
  return matches.map((m, index) => ({ ...m, index }));
}
