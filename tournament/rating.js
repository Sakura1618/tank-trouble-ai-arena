// 评分与置信区间。
// 不用逐场更新的 Elo：它的结果依赖比赛顺序，并行赛程和重新排序都会改变排名。
// 这里对全部结果做 Bradley–Terry 极大似然拟合，再换算到 Elo 刻度，结果与顺序无关。

import { Rng } from '../engine/rng.js';

const ELO_SCALE = 400 / Math.LN10;
const BASE_ELO = 1500;

// Wilson 区间：小样本和接近 0/1 的胜率比正态近似可靠。
export function wilson(score, n, z = 1.96) {
  if (n === 0) return { low: 0, high: 1 };
  const p = score / n;
  const denominator = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

// pairs: [{ a, b, score }]，score 是 a 的得分（1/0.5/0）。
export function fitElo(players, pairs, iterations = 300) {
  const index = new Map(players.map((id, i) => [id, i]));
  const n = players.length;
  const wins = new Float64Array(n);
  const games = Array.from({ length: n }, () => new Float64Array(n));
  for (const { a, b, score } of pairs) {
    const i = index.get(a);
    const j = index.get(b);
    wins[i] += score;
    wins[j] += 1 - score;
    games[i][j]++;
    games[j][i]++;
  }
  // 对每对选手加一点虚拟平局：全胜或全负时估计值不发散。
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j && games[i][j] > 0) { games[i][j] += 0.5; wins[i] += 0.25; }
    }
  }
  let gamma = new Float64Array(n).fill(1);
  for (let iter = 0; iter < iterations; iter++) {
    const next = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let denominator = 0;
      for (let j = 0; j < n; j++) {
        if (i !== j && games[i][j] > 0) denominator += games[i][j] / (gamma[i] + gamma[j]);
      }
      next[i] = denominator > 0 ? wins[i] / denominator : gamma[i];
    }
    let logSum = 0;
    for (let i = 0; i < n; i++) logSum += Math.log(Math.max(next[i], 1e-12));
    const scale = Math.exp(logSum / n);
    for (let i = 0; i < n; i++) next[i] = Math.max(next[i], 1e-12) / scale;
    gamma = next;
  }
  return Object.fromEntries(players.map((id, i) => [id, BASE_ELO + ELO_SCALE * Math.log(gamma[i])]));
}

// 按“组”重采样：同图换边的两局强相关，拆开采样会把区间算窄。
export function bootstrapElo(players, groups, { samples = 200, seed = 1 } = {}) {
  const rng = new Rng(seed);
  const draws = Object.fromEntries(players.map(id => [id, []]));
  for (let s = 0; s < samples; s++) {
    const pairs = [];
    for (let i = 0; i < groups.length; i++) pairs.push(...groups[rng.int(groups.length)]);
    const ratings = fitElo(players, pairs, 100);
    for (const id of players) draws[id].push(ratings[id]);
  }
  return Object.fromEntries(players.map(id => {
    const sorted = draws[id].sort((a, b) => a - b);
    return [id, { low: sorted[Math.floor(samples * 0.025)], high: sorted[Math.ceil(samples * 0.975) - 1] }];
  }));
}

// 名次：存活者最高，其次死得越晚越高，同 Tick 阵亡并列；判负永远垫底。
export function placements(match) {
  const { result, stats } = match;
  const timeOf = id => {
    const player = result.players.find(p => p.id === id);
    if (player.forfeit) return -1;
    return player.alive ? Infinity : stats[id].deathTick ?? 0;
  };
  const ids = result.players.map(p => p.id);
  return Object.fromEntries(ids.map(id => [id, 1 + ids.filter(other => timeOf(other) > timeOf(id)).length]));
}

// 比赛得分归一化到 [0,1]。双人局：胜 1、平 0.5、负 0；判负不得分。
export function matchScores(match) {
  const place = placements(match);
  const ids = Object.keys(place);
  if (ids.length === 1) return { [ids[0]]: 1 };
  const out = {};
  for (const id of ids) {
    const beaten = ids.filter(other => other !== id && place[other] > place[id]).length;
    const tied = ids.filter(other => other !== id && place[other] === place[id]).length;
    const forfeited = match.result.players.find(p => p.id === id).forfeit;
    out[id] = forfeited ? 0 : (beaten + tied * 0.5) / (ids.length - 1);
  }
  return out;
}

export function pairwise(match, keyOf) {
  const place = placements(match);
  const ids = Object.keys(place);
  const pairs = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = keyOf(ids[i]);
      const b = keyOf(ids[j]);
      if (a === b) continue;
      const score = place[ids[i]] < place[ids[j]] ? 1 : place[ids[i]] > place[ids[j]] ? 0 : 0.5;
      pairs.push({ a, b, score });
    }
  }
  return pairs;
}
