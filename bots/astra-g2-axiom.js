/*
 * AXIOM / 天枢 — GPT-6 Astra 开发者 Boss Gen2
 * 基于 Gen1 裁决者的公开观测模型；单文件 CommonJS，无运行时依赖。
 * 战略目标保持 + 进展反馈 + 可中断滚动控制；拦截/反弹/压制；路径竞速与风险道具决策。
 * 不访问引擎/对手代码，不修改赛制、预算或物理。每局由竞技场重建作用域。
 */
'use strict';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const angleDiff = a => Math.atan2(Math.sin(a), Math.cos(a));
const sq = v => v * v;
const hypot = Math.hypot;
const DIRECTIONS = [[0, -1, 'top'], [1, 0, 'right'], [0, 1, 'bottom'], [-1, 0, 'left']];
const now = typeof performance === 'object' ? () => performance.now() : () => Date.now();
const memory = { geometry: null, enemies: new Map(), mines: new Map(), forecasts: new Map(), aim: null,
  previous: null, lastShot: 0, samples: [], blocked: 0, objective: null, reposition: null,
  lastSwitch: -1, side: 1, graph: null };

// ---------- 几何与局内空间索引 ----------
class Geometry {
  constructor(map) {
    this.walls = map.walls;
    this.size = map.cellSize;
    this.cols = map.cols; this.rows = map.rows;
    this.width = map.width; this.height = map.height;
    this.binSize = 64;
    this.bw = Math.ceil(map.width / this.binSize) + 1;
    this.bh = Math.ceil(map.height / this.binSize) + 1;
    this.bins = Array.from({ length: this.bw * this.bh }, () => []);
    this.planes = [];
    const planes = new Set();
    for (const w of this.walls) {
      const box = { ...w, loX: Math.min(w.x1, w.x2), hiX: Math.max(w.x1, w.x2),
        loY: Math.min(w.y1, w.y2), hiY: Math.max(w.y1, w.y2), vertical: w.x1 === w.x2 };
      const c0 = clamp(Math.floor((box.loX - 20) / 64), 0, this.bw - 1);
      const c1 = clamp(Math.floor((box.hiX + 20) / 64), 0, this.bw - 1);
      const r0 = clamp(Math.floor((box.loY - 20) / 64), 0, this.bh - 1);
      const r1 = clamp(Math.floor((box.hiY + 20) / 64), 0, this.bh - 1);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.bins[r * this.bw + c].push(box);
      const key = (box.vertical ? 'x' : 'y') + (box.vertical ? w.x1 : w.y1);
      if (!planes.has(key)) { planes.add(key); this.planes.push({ vertical: box.vertical, value: box.vertical ? w.x1 : w.y1 }); }
    }
  }
  near(x, y) {
    return this.bins[clamp(Math.floor(y / 64), 0, this.bh - 1) * this.bw + clamp(Math.floor(x / 64), 0, this.bw - 1)];
  }
  resolve(p, radius = 16) {
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      for (const w of this.near(p.x, p.y)) {
        const px = clamp(p.x, w.loX, w.hiX), py = clamp(p.y, w.loY, w.hiY);
        const dx = p.x - px, dy = p.y - py, d2 = dx * dx + dy * dy;
        if (d2 >= radius * radius) continue;
        const d = Math.sqrt(d2);
        if (d > 0) { p.x += dx * (radius / d - 1); p.y += dy * (radius / d - 1); }
        else if (w.vertical) p.x += w.y2 > w.y1 ? -radius : radius;
        else p.y += w.x2 > w.x1 ? radius : -radius;
        changed = true;
      }
      if (!changed) break;
    }
    return p;
  }
  bulletStep(b, dt, radius) {
    const steps = Math.max(1, Math.ceil(hypot(b.vx, b.vy) * dt / radius));
    for (let step = 0; step < steps; step++) {
      b.x += b.vx * dt / steps; b.y += b.vy * dt / steps;
      for (const w of this.near(b.x, b.y)) {
        const px = clamp(b.x, w.loX, w.hiX), py = clamp(b.y, w.loY, w.hiY);
        const dx = b.x - px, dy = b.y - py, d2 = dx * dx + dy * dy;
        if (d2 >= radius * radius) continue;
        const d = Math.sqrt(d2);
        const nx = d ? dx / d : w.vertical ? (w.y2 > w.y1 ? -1 : 1) : 0;
        const ny = d ? dy / d : w.vertical ? 0 : (w.x2 > w.x1 ? 1 : -1);
        b.x += nx * (radius - d); b.y += ny * (radius - d);
        const v = 2 * (b.vx * nx + b.vy * ny);
        b.vx -= v * nx; b.vy -= v * ny; b.bounces++;
      }
    }
    b.age += dt;
  }
  // 射线与墙的胶囊碰撞：射击时半径 3，激光时半径 0，通行判断时半径 17。
  cast(x, y, dx, dy, maxLength, radius = 0) {
    let best = maxLength, hit = null;
    for (const w of this.walls) {
      const vertical = w.x1 === w.x2;
      const lo = vertical ? Math.min(w.y1, w.y2) : Math.min(w.x1, w.x2);
      const hi = vertical ? Math.max(w.y1, w.y2) : Math.max(w.x1, w.x2);
      const axis = vertical ? dx : dy;
      if (Math.abs(axis) > 1e-9) {
        const wall = vertical ? w.x1 : w.y1;
        const t = (wall - Math.sign(axis) * radius - (vertical ? x : y)) / axis;
        const cross = (vertical ? y : x) + (vertical ? dy : dx) * t;
        if (t > 1e-5 && t < best && cross >= lo && cross <= hi) {
          best = t; hit = { t, nx: vertical ? -Math.sign(dx) : 0, ny: vertical ? 0 : -Math.sign(dy), wall: w };
        }
      }
      if (radius > 0) {
        for (let end = 0; end < 2; end++) {
          const cx = end ? w.x2 : w.x1, cy = end ? w.y2 : w.y1;
          const ox = x - cx, oy = y - cy, proj = ox * dx + oy * dy;
          if (proj >= 0) continue;
          const disc = proj * proj - (ox * ox + oy * oy - radius * radius);
          if (disc < 0) continue;
          const t = -proj - Math.sqrt(disc);
          if (t > 1e-5 && t < best) {
            best = t; hit = { t, nx: (x + dx * t - cx) / radius, ny: (y + dy * t - cy) / radius, wall: w };
          }
        }
      }
    }
    return hit;
  }
  clear(a, b, radius = 17) {
    const dx = b.x - a.x, dy = b.y - a.y, distance = hypot(dx, dy);
    return distance < 0.01 || !this.cast(a.x, a.y, dx / distance, dy / distance, distance, radius);
  }
  muzzle(p, angle, offset) {
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const hit = this.cast(p.x, p.y, dx, dy, offset, 0);
    const distance = hit ? hit.t - 4 : offset;
    return { x: p.x + dx * distance, y: p.y + dy * distance, angle };
  }
  trace(p, angle, length, radius, maxBounces = 6) {
    let x = p.x, y = p.y, dx = Math.cos(angle), dy = Math.sin(angle), traveled = 0;
    const segments = [];
    for (let i = 0; i <= maxBounces && traveled < length - 0.01; i++) {
      const hit = this.cast(x, y, dx, dy, length - traveled, radius);
      const distance = hit ? hit.t : length - traveled;
      segments.push({ x, y, ex: x + dx * distance, ey: y + dy * distance, dx, dy, length: distance, start: traveled, bounce: i });
      traveled += distance;
      if (!hit) break;
      x += dx * distance; y += dy * distance;
      const v = 2 * (dx * hit.nx + dy * hit.ny);
      dx -= v * hit.nx; dy -= v * hit.ny;
      x += dx * 0.005; y += dy * 0.005;
    }
    return segments;
  }
}

function segmentDistance2(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const u = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return sq(x - ax - dx * u) + sq(y - ay - dy * u);
}

// ---------- 公开观测的历史记忆和对手运动模型 ----------
function trackEnemies(s, g) {
  const enemies = [];
  for (const e of s.enemies) {
    if (!e.alive) continue;
    const previous = memory.enemies.get(e.id);
    const omega = previous ? clamp(angleDiff(e.angle - previous.angle) / s.dt, -3, 3) : 0;
    const turning = previous ? previous.turning * 0.65 + omega * 0.35 : 0;
    const speed = clamp(e.vx * Math.cos(e.angle) + e.vy * Math.sin(e.angle), -s.physics.moveSpeed, s.physics.moveSpeed);
    const model = previous || { future: Array.from({ length: 91 }, () => ({})), linear: Array.from({ length: 91 }, () => ({})) };
    Object.assign(model, e, { turning, speed, angularVelocity: omega });
    const curved = { x: e.x, y: e.y, angle: e.angle }, linear = { x: e.x, y: e.y };
    for (let i = 0; i <= 90; i++) {
      Object.assign(model.future[i], curved);
      Object.assign(model.linear[i], { x: linear.x, y: linear.y, angle: e.angle });
      curved.angle += turning * Math.exp(-i / 20) / 30;
      curved.x += Math.cos(curved.angle) * speed / 30; curved.y += Math.sin(curved.angle) * speed / 30;
      linear.x += e.vx / 30; linear.y += e.vy / 30;
      g.resolve(curved); g.resolve(linear);
    }
    memory.enemies.set(e.id, model); enemies.push(model);
  }
  return enemies;
}
function future(e, seconds, linear = false) {
  const list = linear ? e.linear : e.future;
  const index = clamp(seconds * 30, 0, list.length - 1);
  const a = list[Math.floor(index)], b = list[Math.ceil(index)], t = index % 1;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle: a.angle + angleDiff(b.angle - a.angle) * t };
}
function trackMines(s) {
  const visible = new Set(s.mines.map(m => m.id));
  for (const m of s.mines) memory.mines.set(m.id, { ...m, born: s.time - m.age });
  const fadeEnd = s.physics.mine.armDelay + s.physics.mine.visibleTime + s.physics.mine.fadeTime;
  for (const [id, m] of memory.mines) {
    const age = s.time - m.born;
    const shouldBeVisible = age < fadeEnd - s.dt * 1.5;
    const someoneTripped = age > s.physics.mine.armDelay && [s.self, ...s.enemies].some(p => hypot(p.x - m.x, p.y - m.y) < s.physics.mine.triggerRadius - 2);
    if (!visible.has(id) && (shouldBeVisible || someoneTripped)) memory.mines.delete(id);
    else m.age = age;
  }
  return [...memory.mines.values()];
}

// ---------- 战略层：实际进展反馈、路径竞速和有承诺期限的目标 ----------
function feedback(s) {
  const old = memory.samples[memory.samples.length - 1];
  if (memory.previous && old) {
    const actual = hypot(s.self.vx, s.self.vy) * s.dt;
    const requested = Math.abs(memory.previous.move) * s.physics.moveSpeed * s.dt;
    memory.blocked = requested > 0.7 && actual < requested * 0.22 ? memory.blocked + 1 : Math.max(0, memory.blocked - 2);
  }
  if (s.tick % 6 === 0) {
    memory.samples.push({ x: s.self.x, y: s.self.y, time: s.time });
    while (memory.samples.length && s.time - memory.samples[0].time > 1.8) memory.samples.shift();
  }
  const first = memory.samples[0] || s.self;
  const displacement = hypot(s.self.x - first.x, s.self.y - first.y);
  return { blocked: memory.blocked > 16, stale: s.time > 2 && s.time - memory.lastShot > 2.2 && displacement < 24,
    displacement, quiet: s.time - memory.lastShot };
}
function graphFor(s) {
  if (memory.graph && memory.graph.walls === s.map.walls.length) return memory.graph;
  const { cols, rows, cellSize: size, cells } = s.map, count = cols * rows;
  const neighbors = Array.from({ length: count }, () => []);
  const centers = Array.from({ length: count }, (_, i) => ({ x: (i % cols + 0.5) * size, y: (Math.floor(i / cols) + 0.5) * size }));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    for (const [dc, dr, wall] of DIRECTIONS) {
      const nc = c + dc, nr = r + dr;
      if (nc >= 0 && nr >= 0 && nc < cols && nr < rows && !cells[r][c][wall]) neighbors[r * cols + c].push(nr * cols + nc);
    }
  }
  const trees = new Map();
  const cellOf = p => clamp(Math.floor(p.y / size), 0, rows - 1) * cols + clamp(Math.floor(p.x / size), 0, cols - 1);
  const tree = start => {
    if (trees.has(start)) return trees.get(start);
    const dist = new Int32Array(count).fill(-1), prev = new Int32Array(count).fill(-1), queue = new Int32Array(count);
    let head = 0, tail = 1; queue[0] = start; dist[start] = 0;
    while (head < tail) {
      const at = queue[head++];
      for (const next of neighbors[at]) if (dist[next] < 0) { dist[next] = dist[at] + 1; prev[next] = at; queue[tail++] = next; }
    }
    const result = { dist, prev }; trees.set(start, result); return result;
  };
  return memory.graph = { walls: s.map.walls.length, count, neighbors, centers, cellOf, tree, size };
}
function navigate(s, g, enemies, mines, danger, progress) {
  const graph = graphFor(s), { cellOf, centers, tree, size } = graph;
  const start = cellOf(s.self), fromSelf = tree(start);
  const distance = (from, to) => {
    const direct = hypot(from.x - to.x, from.y - to.y);
    if (g.clear(from, to, 18)) return direct;
    const a = cellOf(from), b = cellOf(to), steps = tree(a).dist[b];
    return steps < 0 ? Infinity : Math.max(direct, steps * size + hypot(from.x - centers[a].x, from.y - centers[a].y) + hypot(to.x - centers[b].x, to.y - centers[b].y) - size * 0.55);
  };
  const routeTo = goal => {
    const route = [];
    for (let at = cellOf(goal); at !== start && at !== -1; at = fromSelf.prev[at]) route.push(centers[at]);
    route.reverse(); route.push(goal); return route;
  };
  const waypointTo = goal => {
    if (g.clear(s.self, goal, 18) && !mines.some(m => segmentDistance2(m.x, m.y, s.self.x, s.self.y, goal.x, goal.y) < 47 * 47)) return goal;
    const route = routeTo(goal);
    let point = centers[start];
    for (const p of route.slice(0, 5)) {
      if (!g.clear(s.self, p, 18) || mines.some(m => segmentDistance2(m.x, m.y, s.self.x, s.self.y, p.x, p.y) < 47 * 47)) break;
      point = p;
    }
    if (hypot(point.x - s.self.x, point.y - s.self.y) < 7 && route.length) point = route[0];
    return point;
  };
  let target = enemies[0], bestEnemy = Infinity;
  for (const e of enemies) {
    const cost = distance(s.self, e) + (e.shield && !s.self.shield ? 100 : 0) - (memory.targetId === e.id ? 65 : 0);
    if (cost < bestEnemy) { bestEnemy = cost; target = e; }
  }
  memory.targetId = target.id;
  const enemyDistance = hypot(target.x - s.self.x, target.y - s.self.y);
  let goal = target, pickup = false, utility = 0, key = null;
  for (const p of s.powerups) {
    if (p.type === 'shield' && s.self.shieldTime > 2.8) continue;
    if (p.type !== 'shield' && p.type !== 'laser' && s.self.laserShots) continue;
    if (p.type === 'mine' && (s.self.scatterShots || s.self.mineCharges)) continue;
    const ownDistance = distance(s.self, p), waypoint = waypointTo(p);
    const heading = Math.atan2(waypoint.y - s.self.y, waypoint.x - s.self.x);
    const turn = Math.min(Math.abs(angleDiff(heading - s.self.angle)), Math.abs(angleDiff(heading + Math.PI - s.self.angle))) / s.physics.turnSpeed;
    const eta = Math.max(0, ownDistance - 28) / s.physics.moveSpeed + turn * 0.55;
    let enemyEta = Infinity;
    for (const e of enemies) enemyEta = Math.min(enemyEta, Math.max(0, distance(e, p) - 28) / s.physics.moveSpeed);
    let risk = 0;
    // 对竞速路线的近期可达位置进行弹道检查；不把欧氏距离当成穿墙速度。
    const dx = waypoint.x - s.self.x, dy = waypoint.y - s.self.y, len = hypot(dx, dy);
    for (let f = 6; f <= 66; f += 6) {
      const t = f * s.dt, fraction = Math.min(1, Math.max(0, t - turn * 0.4) * s.physics.moveSpeed / (len || 1));
      const x = s.self.x + dx * fraction, y = s.self.y + dy * fraction;
      for (const b of danger.threats) {
        if (!b.active[f]) continue;
        const gap = hypot(x - b.points[f * 2], y - b.points[f * 2 + 1]);
        // 远期直线路径可以被局部控制绕开，不能与 MPC 的致命碰撞罚分重复计成必死。
        if (gap < 42) risk = Math.max(risk, (42 - gap) * (b.speculative ? 1.5 : t < 0.25 ? 16 : 4) / (0.5 + t));
      }
    }
    for (const m of mines) if (segmentDistance2(m.x, m.y, s.self.x, s.self.y, waypoint.x, waypoint.y) < 55 * 55 || hypot(m.x - p.x, m.y - p.y) < 65) risk += 240;
    for (const e of enemies) {
      if (e.laserShots && e.cooldown < 0.3 && g.clear(e, waypoint, 1)) risk += 80;
      if (hypot(e.x - p.x, e.y - p.y) < 90 && e.cooldown < 0.3 && g.clear(e, p, 2)) risk += 65;
    }
    if (s.self.shieldTime > Math.min(eta, 1.2)) risk *= 0.45;
    const candidateKey = p.type + ':' + p.x + ':' + p.y;
    const held = memory.objective && memory.objective.key === candidateKey;
    const value = { shield: 330, laser: 480, scatter: 270, mine: 100 }[p.type];
    let score = value - ownDistance * 0.8 - risk;
    if (enemyEta + 0.3 < eta) score -= Math.min(240, 60 + (eta - enemyEta) * 65);
    else if (p.type === 'laser' && enemyEta < eta + 1.1) score += 65;
    if (enemyDistance < 110 && g.clear(s.self, target, 3) && p.type !== 'shield') score -= 95;
    if (held && s.time < memory.objective.until && risk < 200) score += 65;
    if (score > utility) { utility = score; goal = p; pickup = true; key = candidateKey; }
  }
  if (pickup) {
    if (!memory.objective || memory.objective.key !== key) memory.objective = { key, until: s.time + 1.2 };
    memory.reposition = null;
  } else {
    memory.objective = null;
    // 一直瞄准却没有攻击/位移进展时，主动换射击位置。保持目标而非每帧换边。
    if (memory.reposition && (s.time > memory.reposition.until || hypot(s.self.x - memory.reposition.x, s.self.y - memory.reposition.y) < 22)) memory.reposition = null;
    if (!memory.reposition && (progress.stale || progress.blocked)) {
      const facing = Math.atan2(target.y - s.self.y, target.x - s.self.x);
      let best = -Infinity, selected = null;
      const candidates = [];
      for (const index of graph.neighbors[start]) candidates.push(centers[index]);
      for (const delta of [0.7, -0.7, 1.35, -1.35, 2.2, -2.2, Math.PI]) {
        const angle = facing + delta * memory.side;
        candidates.push(g.resolve({ x: s.self.x + Math.cos(angle) * 90, y: s.self.y + Math.sin(angle) * 90 }, 19));
      }
      for (const p of candidates) {
        const travel = hypot(p.x - s.self.x, p.y - s.self.y);
        if (travel < 42 || !g.clear(s.self, p, 18) || mines.some(m => hypot(m.x - p.x, m.y - p.y) < 65)) continue;
        const range = hypot(p.x - target.x, p.y - target.y);
        const open = g.clear(p, target, 3), side = Math.sign(Math.sin(Math.atan2(p.y - s.self.y, p.x - s.self.x) - facing));
        const score = (open ? 70 : 0) - Math.abs(range - 130) * 0.32 - distance(p, target) * 0.12 + (side === memory.side ? 12 : 0) + travel * 0.12;
        if (score > best) { best = score; selected = p; }
      }
      if (selected) { memory.reposition = { ...selected, until: s.time + 1.5 }; memory.side *= -1; }
    }
    if (memory.reposition) goal = memory.reposition;
  }
  let waypoint = waypointTo(goal);
  const intent = pickup ? key : memory.reposition ? 'reposition:' + goal.x + ':' + goal.y : 'combat:' + target.id;
  return { target, waypoint, goal, pickup, intent, reposition: !!memory.reposition, distance: enemyDistance, progress };
}

// ---------- 射击：运动拦截、镜像反弹解与命中概率 ----------
function shotValue(path, enemies, s, delay = 0) {
  let best = 0, target = null, impact = 0;
  for (const e of enemies) {
    let value = 0, hitTime = 0;
    for (const seg of path) {
      let along = clamp((e.x - seg.x) * seg.dx + (e.y - seg.y) * seg.dy, 0, seg.length), t;
      for (let k = 0; k < 3; k++) {
        t = delay + (seg.start + along) / s.physics.bulletSpeed;
        const p = future(e, t);
        along = clamp((p.x - seg.x) * seg.dx + (p.y - seg.y) * seg.dy, 0, seg.length);
      }
      if (t > 2.7) continue;
      const p = future(e, t), straight = future(e, t, true);
      const sigma = 6 + Math.min(6, t * 3);
      const d2 = segmentDistance2(p.x, p.y, seg.x, seg.y, seg.ex, seg.ey);
      const l2 = segmentDistance2(straight.x, straight.y, seg.x, seg.y, seg.ex, seg.ey);
      const still2 = segmentDistance2(e.x, e.y, seg.x, seg.y, seg.ex, seg.ey);
      const chance = d => Math.exp(-sq(Math.max(0, Math.sqrt(d) - 12)) / (2 * sigma * sigma));
      const probability = 0.60 * chance(d2) + 0.30 * chance(l2) + 0.10 * chance(still2);
      const v = probability / (1 + t * 1.45) * (e.shield ? 0.82 : 1) * Math.pow(0.88, seg.bounce);
      if (v > value) { value = v; hitTime = t; }
    }
    if (value > best) { best = value; target = e; impact = hitTime; }
  }
  return { score: best, target, impact };
}
// 命中之外的收益：弹道在敌人近期活动区域形成封锁。没有路径接近就没有压制价值。
function pressureValue(path, enemies, s) {
  let best = 0;
  for (const e of enemies) for (const seg of path) {
    const along = clamp((e.x - seg.x) * seg.dx + (e.y - seg.y) * seg.dy, 0, seg.length);
    const t = (seg.start + along) / s.physics.bulletSpeed;
    if (t > 1.9) continue;
    const p = future(e, Math.min(t, 0.75));
    const distance = Math.sqrt(segmentDistance2(p.x, p.y, seg.x, seg.y, seg.ex, seg.ey));
    if (distance > 74) continue;
    const coverage = Math.max(0, 1 - distance / 74) / (1 + t * 0.65) * Math.pow(0.85, seg.bounce);
    best = Math.max(best, coverage);
  }
  return best;
}
function laserHit(path, origin, enemies, dt) {
  for (const seg of path) {
    let hit = null, alongBest = Infinity;
    for (const e of [...enemies, { ...origin, id: '@self' }]) {
      if (e.id === '@self' && seg.bounce === 0) continue;
      const p = e.future ? future(e, dt) : e;
      const along = clamp((p.x - seg.x) * seg.dx + (p.y - seg.y) * seg.dy, 0, seg.length);
      const d = hypot(p.x - seg.x - seg.dx * along, p.y - seg.y - seg.dy * along);
      if (d < 15.3 && along < alongBest) { hit = e; alongBest = along; }
    }
    if (hit) return hit;
  }
  return null;
}
function chooseAim(s, g, enemies, nav, deadline) {
  const self = s.self, laser = self.laserShots > 0, radius = laser ? 0 : s.physics.bulletRadius;
  const candidates = [], dedup = new Set();
  const add = (angle, rank) => {
    const key = Math.round(angleDiff(angle) * 1500);
    if (!dedup.has(key)) { dedup.add(key); candidates.push({ angle, rank }); }
  };
  add(self.angle, -1);
  if (memory.aim) add(memory.aim.angle, -0.5);
  const closePlanes = g.planes.map(p => ({ ...p, distance: Math.abs(p.value - (p.vertical ? self.x : self.y)) })).sort((a, b) => a.distance - b.distance).slice(0, 12);
  const priority = enemies.slice().sort((a, b) => (a.id === nav.target.id ? -1 : b.id === nav.target.id ? 1 : hypot(a.x - self.x, a.y - self.y) - hypot(b.x - self.x, b.y - self.y))).slice(0, 5);
  for (const e of priority) {
    const d = hypot(e.x - self.x, e.y - self.y);
    for (const linear of [false, true]) {
      let t = laser ? s.dt : Math.max(0, (d - s.physics.muzzleOffset) / s.physics.bulletSpeed);
      let p = e;
      for (let i = 0; i < 4; i++) {
        p = future(e, t, linear);
        t = laser ? s.dt : Math.max(0, (hypot(p.x - self.x, p.y - self.y) - s.physics.muzzleOffset) / s.physics.bulletSpeed);
      }
      const angle = Math.atan2(p.y - self.y, p.x - self.x);
      add(angle, d / 1000); add(angle - 0.045, d / 1000 + 0.1); add(angle + 0.045, d / 1000 + 0.1);
    }
    add(Math.atan2(e.y - self.y, e.x - self.x), d / 1000 + 0.05);
    for (const a of closePlanes) {
      for (const b of [null, ...closePlanes.slice(0, 5)]) {
        if (a === b || (b && a.vertical === b.vertical && a.value === b.value)) continue;
        let t = laser ? s.dt : Math.min(2.2, (d + a.distance) / 180), image;
        for (let iteration = 0; iteration < 2; iteration++) {
          image = { ...future(e, t) };
          // 逆序展开两次镜像；实际弹道再检查有限墙段是否真的可达。
          for (const plane of b ? [b, a] : [a]) {
            const key = plane.vertical ? 'x' : 'y';
            const surface = plane.value + (self[key] < plane.value ? -radius : radius);
            image[key] = 2 * surface - image[key];
          }
          t = laser ? s.dt : (hypot(image.x - self.x, image.y - self.y) - 36) / 180;
        }
        const length = hypot(image.x - self.x, image.y - self.y);
        if (length > (laser ? s.physics.laser.maxLength : 510)) continue;
        const angle = Math.atan2(image.y - self.y, image.x - self.x);
        add(angle, length / 500 + Math.abs(angleDiff(angle - self.angle)) * 0.4 + (b ? 0.3 : 0));
      }
    }
  }
  candidates.sort((a, b) => a.rank - b.rank);
  let retained = null;
  let best = { angle: Math.atan2(nav.target.y - self.y, nav.target.x - self.x), score: 0, utility: -1, target: nav.target };
  for (let i = 0; i < Math.min(candidates.length, laser ? 65 : 42); i++) {
    if (i > 6 && now() > deadline) break;
    const { angle } = candidates[i], rotation = Math.abs(angleDiff(angle - self.angle)) / s.physics.turnSpeed;
    const muzzle = g.muzzle(self, angle, s.physics.muzzleOffset);
    const path = g.trace(muzzle, angle, laser ? s.physics.laser.maxLength : 510, radius, laser ? s.physics.laser.maxBounces : 5);
    let value;
    if (laser) {
      const victim = laserHit(path, self, enemies, s.dt + rotation * 0.45);
      value = { score: victim && victim.id !== '@self' ? (victim.shield ? 0.72 : 1.6) : 0, target: victim, impact: 0 };
    } else {
      value = shotValue(path, enemies, s, rotation * 0.45);
      const pressure = self.bulletsActive < 3 ? pressureValue(path, priority, s) : 0;
      value.score = Math.max(value.score, pressure * 0.32);
      // 贴墙出膛或立即折返的射线不要长期争夺瞄准权；最终仍逐步模拟自弹安全。
      if (hypot(muzzle.x - self.x, muzzle.y - self.y) < 20 || (path.length > 1 && path[0].length < 35 && segmentDistance2(self.x, self.y, path[1].x, path[1].y, path[1].ex, path[1].ey) < 22 * 22)) value.score *= 0.15;
    }
    const utility = value.score / (1 + rotation * 0.65) - rotation * 0.015;
    if (memory.aim && Math.abs(angleDiff(angle - memory.aim.angle)) < 0.001) retained = { ...value, angle, utility, path };
    if (utility > best.utility) best = { ...value, angle, utility, path };
  }
  if (!laser && retained && retained.score > 0.13 && retained.utility > best.utility - 0.035) best = retained;
  memory.aim = best;
  return best;
}

// ---------- 1.2 秒弹道预测，保持 60 Hz 碰撞步长 ----------
function predictThreats(s, g, enemies) {
  const frames = 72, threats = [];
  const incoming = [...s.bullets];
  // 近距离必须在炮弹生成之前躲开炮口：等弹体出现在观察里可能已来不及。
  for (const e of enemies) {
    if (e.laserShots || e.cooldown > 0.12 || (e.bulletsActive >= 5 && !e.scatterShots)) continue;
    const distance = hypot(s.self.x - e.x, s.self.y - e.y);
    if (distance > 230 || !g.clear(e, s.self, 2)) continue;
    for (const offset of e.scatterShots ? [-0.26, 0, 0.26] : distance < 150 ? [0, -0.075, 0.075] : [0]) {
      const heading = e.angle + clamp(e.angularVelocity, -3, 3) * s.dt + offset;
      const muzzle = g.muzzle(e, heading, s.physics.muzzleOffset);
      incoming.push({ id: 'potential-' + e.id + '-' + offset, ownerId: e.id,
        x: muzzle.x, y: muzzle.y, vx: Math.cos(heading) * s.physics.bulletSpeed,
        vy: Math.sin(heading) * s.physics.bulletSpeed, age: 0, bounces: 0, speculative: true,
        weight: offset && !e.scatterShots ? 0.45 : 1 });
    }
  }
  for (const original of incoming) {
    // 距离上界：来不及进入控制范围的弹体无需逐步推演。
    if (hypot(original.x - s.self.x, original.y - s.self.y) > (s.physics.bulletSpeed + s.physics.moveSpeed) * 1.2 + 60) continue;
    const b = { ...original };
    let forecast = memory.forecasts.get(b.id);
    if (!forecast) { forecast = { points: new Float64Array((frames + 1) * 2), active: new Uint8Array(frames + 1) }; memory.forecasts.set(b.id, forecast); }
    const { points, active } = forecast;
    points[0] = b.x; points[1] = b.y;
    for (let f = 1; f <= frames; f++) {
      g.bulletStep(b, s.dt, s.physics.bulletRadius);
      points[f * 2] = b.x; points[f * 2 + 1] = b.y;
      active[f] = b.age < s.physics.bulletLifetime && !(b.ownerId === s.self.id && b.bounces === 0 && b.age < s.physics.selfHitGrace) ? 1 : 0;
    }
    threats.push({ id: b.id, points, active, speculative: !!b.speculative, weight: b.weight || 1 });
  }
  const currentIds = new Set(incoming.map(b => b.id));
  for (const id of memory.forecasts.keys()) if (!currentIds.has(id)) memory.forecasts.delete(id);
  const lasers = [];
  for (const e of enemies) {
    const laserPickup = !e.laserShots && s.powerups.find(p => p.type === 'laser' && hypot(p.x - e.x, p.y - e.y) < 60 && g.clear(e, p, 17));
    if ((!e.laserShots && !laserPickup) || e.cooldown >= 0.35) continue;
    const ready = laserPickup ? { ...e, cooldown: Math.max(e.cooldown, (hypot(laserPickup.x - e.x, laserPickup.y - e.y) - 32) / s.physics.moveSpeed) } : e;
    for (const offset of [0, -s.physics.turnSpeed * s.dt, s.physics.turnSpeed * s.dt]) {
      const angle = e.angle + offset, muzzle = g.muzzle(e, angle, s.physics.muzzleOffset);
      lasers.push({ enemy: ready, weight: (offset ? 0.65 : 1) * (laserPickup ? 0.6 : 1), path: g.trace(muzzle, angle, s.physics.laser.maxLength, 0, s.physics.laser.maxBounces) });
    }
  }
  return { threats, lasers };
}

// ---------- 模型预测控制：前进/倒车/停转、三段动作和受威胁轨迹比较 ----------
function drive(p, control, s, g, frame, enemies) {
  if (control.phases) control = control.phases[Math.min(control.phases.length - 1, Math.floor((frame - 1 + (control.offset || 0)) / 12))];
  let heading = control.heading;
  const goalDistance = control.goal ? hypot(control.goal.x - p.x, control.goal.y - p.y) : Infinity;
  if (control.goal && goalDistance > 5) heading = Math.atan2(control.goal.y - p.y, control.goal.x - p.x) + (control.move < 0 ? Math.PI : 0);
  const error = angleDiff(heading - p.angle), turn = clamp(error / (s.physics.turnSpeed * s.dt), -1, 1);
  const move = goalDistance < 7 || (control.gate && Math.abs(error) > 1.1) ? 0 : control.move;
  p.angle += turn * s.physics.turnSpeed * s.dt;
  p.x += Math.cos(p.angle) * move * s.physics.moveSpeed * s.dt;
  p.y += Math.sin(p.angle) * move * s.physics.moveSpeed * s.dt;
  g.resolve(p, s.physics.tankRadius);
  for (const e of enemies) {
    const ep = e.future[Math.min(90, Math.round(frame / 2))], dx = p.x - ep.x, dy = p.y - ep.y, d = hypot(dx, dy);
    if (d < s.physics.tankRadius * 2 && d > 0.001) {
      p.x += dx / d * (32 - d) * 0.5; p.y += dy / d * (32 - d) * 0.5; g.resolve(p);
    }
  }
  return frame === 1 ? { move, turn } : null;
}
function simulateControl(control, s, g, enemies, mines, danger, nav, aim, keepPath = false) {
  const p = { x: s.self.x, y: s.self.y, angle: s.self.angle };
  let cost = 0, fatalRisk = 0, possibleRisk = 0, nearRisk = 0, laserRisk = 0, gunRisk = 0, closeRisk = 0, moved = 0, shieldSpent = false;
  const struck = new Set(), path = keepPath ? [{ ...p }] : null;
  const horizon = 66;
  let shotWindow = false, collected = false;
  let firstAction;
  for (let f = 1; f <= horizon; f++) {
    const oldX = p.x, oldY = p.y;
    const action = drive(p, control, s, g, f, enemies);
    if (f === 1) firstAction = action;
    moved += hypot(p.x - oldX, p.y - oldY);
    if (path) path.push({ ...p });
    if (nav.pickup && !collected && hypot(p.x - nav.goal.x, p.y - nav.goal.y) < s.physics.tankRadius + s.physics.powerupRadius) {
      // 战略选中之后，执行层也必须兑现“进入拾取半径”这个离散事件。
      // 收益有界；一次真实致命碰撞的代价仍高出几个数量级。
      cost -= ({ laser: 85, shield: 60, scatter: 42, mine: 16 }[nav.goal.type]) / (1 + f * s.dt * 0.5);
      collected = true;
    }
    if (f > 8 && f % 2) continue;
    const t = f * s.dt, weight = 1 / (0.45 + t), shield = s.self.shield && s.self.shieldTime > t && !shieldSpent;
    for (const b of danger.threats) {
      if (!b.active[f] || struck.has(b.id)) continue;
      const bx = b.points[f * 2], by = b.points[f * 2 + 1];
      const d2 = sq(p.x - bx) + sq(p.y - by);
      if (d2 < 22 * 22) {
        struck.add(b.id);
        if (b.speculative) possibleRisk = Math.max(possibleRisk, (shield ? 12 : 450) * weight * b.weight);
        else if (shield && !shieldSpent) { shieldSpent = true; cost += 120; }
        else fatalRisk = Math.max(fatalRisk, 100000 - f * 700);
      }
      if (d2 < 44 * 44) nearRisk = Math.max(nearRisk, sq(Math.max(0, 44 - Math.sqrt(d2))) * weight * (shield ? 0.02 : b.speculative ? 0.05 : 0.16));
    }
    for (const m of mines) {
      if (m.age + t < s.physics.mine.armDelay) continue;
      const d = hypot(p.x - m.x, p.y - m.y);
      const radius = enemies.some(e => hypot(e.x - m.x, e.y - m.y) < 95) ? 62 : 43;
      if (d < radius) cost += (shield ? 6 : 500) * weight;
      else if (d < radius + 22) nearRisk = Math.max(nearRisk, (radius + 22 - d) * 3);
    }
    if (!shield && t < 0.5) {
      for (const beam of danger.lasers) {
        if (beam.enemy.cooldown > t + s.dt) continue;
        for (const seg of beam.path) {
          const d = Math.sqrt(segmentDistance2(p.x, p.y, seg.x, seg.y, seg.ex, seg.ey));
          laserRisk = Math.max(laserRisk, Math.max(0, 28 - d) * beam.weight * (t < 0.12 ? 180 : 22));
        }
      }
      for (const e of enemies) {
        const ep = e.future[Math.round(f / 2)], dx = p.x - ep.x, dy = p.y - ep.y, d = hypot(dx, dy);
        if (d > 170 || e.cooldown > t + 0.08 || (e.bulletsActive >= 5 && !e.scatterShots)) continue;
        const facing = Math.abs(angleDiff(Math.atan2(dy, dx) - ep.angle));
        if (facing < 0.28) gunRisk = Math.max(gunRisk, (1 - d / 200) * (1 - facing / 0.28) * (e.scatterShots ? 55 : 24));
      }
    }
    if (!shield && f % 6 === 0) {
      for (const e of enemies) {
        const ep = e.future[Math.round(f / 2)], distance = hypot(ep.x - p.x, ep.y - p.y);
        const exclusion = e.scatterShots ? 110 : 95;
        if (distance < exclusion && g.clear(p, ep, 2)) {
          closeRisk = Math.max(closeRisk, sq(exclusion - distance) / (35 * (0.4 + t)));
        }
      }
    }
    if (f === 6 || f === 12 || f === 24) {
      cost += 0.06 * hypot(nav.waypoint.x - p.x, nav.waypoint.y - p.y);
      if (aim.score > 0.2) cost += Math.abs(angleDiff(aim.angle - p.angle)) * (nav.pickup ? 3 : 10);
      // 把“在途中真正获得一次开火窗口”计入收益，避免只比较遥远终点的朝向。
      if (!shotWindow && aim.score > 0.20 && s.self.cooldown <= t &&
          (s.self.laserShots || s.self.scatterShots || s.self.bulletsActive < s.physics.maxBullets)) {
        const error = Math.abs(angleDiff(aim.angle - p.angle));
        if (error < 0.14) { cost -= aim.score * (s.self.laserShots ? 95 : 65) * Math.exp(-sq(error / 0.11)) / (1 + t); shotWindow = true; }
      }
    }
  }
  const startDistance = hypot(nav.waypoint.x - s.self.x, nav.waypoint.y - s.self.y), endDistance = hypot(nav.waypoint.x - p.x, nav.waypoint.y - p.y);
  cost += ((collected ? 0 : endDistance) - startDistance) * (nav.pickup ? 0.8 : aim.score < 0.18 ? 0.72 : 0.44);
  const target = nav.target, ep = future(target, horizon * s.dt);
  const range = hypot(ep.x - p.x, ep.y - p.y);
  const aimError = Math.abs(angleDiff(aim.angle - p.angle));
  if (aim.score > 0.12) cost += aimError * (s.self.laserShots ? 70 : nav.pickup ? 13 : 24) * Math.min(1, aim.score * 3);
  if (!nav.pickup && g.clear(s.self, target, 3)) {
    const ideal = s.self.shield ? 65 : target.shield ? 200 : target.scatterShots ? 130 : 95;
    if (range < ideal) cost += (ideal - range) * (target.shield ? 0.5 : 0.8);
  }
  if (firstAction.move && moved < 20) cost += 25 + (nav.progress.blocked ? 18 : 0);
  if (nav.reposition) cost += endDistance * 0.28;
  if (danger.threats.length) {
    // 贴进死角会丢失下一次躲避的自由度；只在存在弹幕时计算附近墙的软代价。
    let nearWalls = 0;
    for (const wall of g.near(p.x, p.y)) {
      const clearance = Math.sqrt(segmentDistance2(p.x, p.y, wall.x1, wall.y1, wall.x2, wall.y2));
      if (clearance < 35) nearWalls += (35 - clearance) / 19;
    }
    cost += Math.max(0, nearWalls - 0.65) * 14;
  }
  cost += Math.abs(firstAction.turn) * 0.15;
  if (memory.previous) {
    if (firstAction.move * memory.previous.move < 0) cost += 8;
    if (firstAction.turn * memory.previous.turn < 0) cost += 3;
  }
  return { cost: cost + fatalRisk + possibleRisk + nearRisk + laserRisk + gunRisk + closeRisk,
    risk: fatalRisk + possibleRisk + nearRisk + laserRisk, fatalRisk, laserRisk, control, action: firstAction, path, moved };
}
function chooseMovement(s, g, enemies, mines, danger, nav, aim, deadline) {
  const a = s.self.angle, navAngle = Math.atan2(nav.waypoint.y - s.self.y, nav.waypoint.x - s.self.x);
  const candidates = [
    { move: 1, heading: navAngle, goal: nav.waypoint, gate: true },
    { move: -1, heading: navAngle + Math.PI, goal: nav.waypoint, gate: true },
    { move: 0, heading: aim.angle }, { move: 1, heading: aim.angle }, { move: -1, heading: aim.angle },
    { move: 0.45, heading: aim.angle }, { move: -0.45, heading: aim.angle },
    { move: 0, heading: a }, { move: 1, heading: a }, { move: -1, heading: a },
  ];
  for (const delta of [-Math.PI / 2, -Math.PI / 3, Math.PI / 3, Math.PI / 2]) {
    candidates.push({ move: 1, heading: a + delta }, { move: -1, heading: a + delta });
  }
  // 保留的是已经向前推进一 Tick 的方案，不能永久重播分段计划的第一帧。
  const continuing = memory.previous && memory.previous.control;
  if (continuing) candidates.unshift(continuing);
  const ranked = [];
  for (let i = 0; i < candidates.length; i++) {
    if (i > 7 && now() > deadline) break;
    ranked.push(simulateControl(candidates[i], s, g, enemies, mines, danger, nav, aim));
  }
  ranked.sort((a, b) => a.cost - b.cost);
  let best = ranked[0];
  // 三段束搜索：先比较第一段，再搜索可改变前进/倒车和航向的后续动作。
  // 允许“先躲后瞄”和 S 形脱离，而不是要求一条固定圆弧躲过所有炮弹。
  const follow = candidates.filter(c => !c.phases).slice(0, 8);
  let beam = ranked.slice(0, 3);
  for (let depth = 1; depth <= 2 && best.risk > 70; depth++) {
    const expanded = [];
    for (const candidate of beam) {
      const prefix = candidate.control.phases ? candidate.control.phases.slice(0, depth) : [candidate.control];
      for (const next of follow) {
        if (now() > deadline) break;
        const option = simulateControl({ phases: [...prefix, next], offset: candidate.control.offset || 0 }, s, g, enemies, mines, danger, nav, aim);
        expanded.push(option);
        if (option.cost < best.cost) best = option;
      }
      if (now() > deadline) break;
    }
    if (!expanded.length) break;
    expanded.sort((a, b) => a.cost - b.cost);
    beam = expanded.slice(0, 2);
  }
  const incumbent = continuing && ranked.find(option => option.control === continuing);
  if (incumbent && memory.previous.intent === nav.intent && !nav.progress.blocked && !nav.progress.stale && incumbent.risk < 1000) {
    const improvement = incumbent.cost - best.cost;
    const threshold = s.time - memory.lastSwitch < 0.10 ? 18 : 6;
    if (improvement < threshold && incumbent.fatalRisk <= best.fatalRisk && incumbent.laserRisk <= best.laserRisk + 3) best = incumbent;
  }
  if (best.control !== continuing) memory.lastSwitch = s.time;
  return simulateControl(best.control, s, g, enemies, mines, danger, nav, aim, true);
}

function safeToFire(s, g, enemies, movement) {
  const p = movement.path[1];
  // 公开顺序为先拾取、再开火：踏上散射道具的同 Tick 必须检查三枚弹，而非旧武器。
  let laser = s.self.laserShots > 0, scatter = s.self.scatterShots > 0;
  for (const pickup of s.powerups) if (hypot(p.x - pickup.x, p.y - pickup.y) < s.physics.tankRadius + s.physics.powerupRadius) {
    if (pickup.type !== 'shield') { laser = pickup.type === 'laser'; scatter = pickup.type === 'scatter'; }
    break;
  }
  if (s.self.cooldown > s.dt || (!laser && !scatter && s.self.bulletsActive >= s.physics.maxBullets)) return false;
  if (laser) {
    const muzzle = g.muzzle(p, p.angle, s.physics.muzzleOffset);
    const hit = laserHit(g.trace(muzzle, p.angle, s.physics.laser.maxLength, 0, s.physics.laser.maxBounces), p, enemies, s.dt);
    return !!hit && hit.id !== '@self';
  }
  const angles = scatter ? [p.angle - s.physics.scatter.spreadAngle, p.angle, p.angle + s.physics.scatter.spreadAngle] : [p.angle];
  let score = 0, pressure = 0;
  for (const angle of angles) {
    const muzzle = g.muzzle(p, angle, s.physics.muzzleOffset);
    const trace = g.trace(muzzle, angle, 510, s.physics.bulletRadius, 5);
    score = Math.max(score, shotValue(trace, enemies, s).score);
    pressure = Math.max(pressure, pressureValue(trace, enemies, s));
    const b = { ...muzzle, vx: Math.cos(angle) * s.physics.bulletSpeed, vy: Math.sin(angle) * s.physics.bulletSpeed, age: 0, bounces: 0 };
    for (let f = 1; f < movement.path.length; f++) {
      g.bulletStep(b, s.dt, s.physics.bulletRadius);
      const own = movement.path[f];
      if ((b.bounces || b.age >= s.physics.selfHitGrace) && hypot(b.x - own.x, b.y - own.y) < 23) return false;
      // 若预测先打中敌人，该弹体已被吸收，不再虚构后续自伤。
      if (enemies.some(e => { const target = future(e, f * s.dt); return hypot(b.x - target.x, b.y - target.y) < 18; })) break;
    }
  }
  const reserve = scatter ? 0 : s.self.bulletsActive;
  const threshold = reserve >= 4 ? 0.65 : reserve >= 3 ? 0.42 : reserve >= 2 ? 0.25 : 0.17;
  const cadence = score > 0.45 || scatter ? 0.16 : score > 0.28 ? 0.30 : 0.65;
  const suppression = reserve < 2 && pressure > 0.40 && score > 0.035 && s.time - memory.lastShot > 0.8;
  return (score > threshold && s.time - memory.lastShot >= cadence) || suppression;
}
function deployMine(s, g, enemies, movement) {
  if (!s.self.mineCharges || s.self.deployCooldown > s.dt || movement.action.move <= 0) return false;
  const p = movement.path[1], back = s.physics.tankRadius + s.physics.mine.discRadius + 4;
  const mine = g.resolve({ x: p.x - Math.cos(p.angle) * back, y: p.y - Math.sin(p.angle) * back }, s.physics.mine.discRadius);
  const end = movement.path[60];
  if (hypot(end.x - mine.x, end.y - mine.y) < s.physics.mine.blastRadius + 18) return false;
  return enemies.some(e => hypot(e.x - mine.x, e.y - mine.y) < 170) || s.self.mineHoldTime < 1.5;
}

module.exports = {
  update(s) {
    const started = now();
    if (!memory.geometry || memory.geometry.walls.length !== s.map.walls.length) memory.geometry = new Geometry(s.map);
    const g = memory.geometry;
    const enemies = trackEnemies(s, g), mines = trackMines(s);
    if (!enemies.length) return { move: 0, turn: 0, fire: false, special: false };
    const danger = predictThreats(s, g, enemies);
    const progress = feedback(s);
    const nav = navigate(s, g, enemies, mines, danger, progress);
    const aim = chooseAim(s, g, enemies, nav, started + 2.1);
    const movement = chooseMovement(s, g, enemies, mines, danger, nav, aim, started + 5.0);
    const fire = safeToFire(s, g, enemies, movement);
    if (fire) memory.lastShot = s.time;
    let nextControl = movement.control;
    if (nextControl.phases) {
      const offset = (nextControl.offset || 0) + 1;
      nextControl = offset >= 12 && nextControl.phases.length > 1 ? { phases: nextControl.phases.slice(1), offset: offset - 12 } : { ...nextControl, offset };
      if (nextControl.phases.length === 1) nextControl = nextControl.phases[0];
    }
    memory.previous = { ...movement.action, control: nextControl, intent: nav.intent };
    return { ...movement.action, fire, special: deployMine(s, g, enemies, movement) };
  },
};
