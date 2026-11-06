/*
 * SOVEREIGN / 裁决者 — Tank Trouble Arena v1 挑战者基准
 * 作者：本竞技场开发者。单文件 CommonJS，无运行时依赖。
 * 只使用公开观测：局内弹道模拟、对手运动估计、反弹瞄准、预测控制、道具争夺。
 * 不访问引擎/对手代码，不修改赛制、预算或物理。每局由竞技场重建作用域。
 */
'use strict';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const angleDiff = a => Math.atan2(Math.sin(a), Math.cos(a));
const sq = v => v * v;
const hypot = Math.hypot;
const DIRECTIONS = [[0, -1, 'top'], [1, 0, 'right'], [0, 1, 'bottom'], [-1, 0, 'left']];
const now = typeof performance === 'object' ? () => performance.now() : () => Date.now();
const memory = { geometry: null, enemies: new Map(), mines: new Map(), forecasts: new Map(), aim: null, previous: null, lastShot: -100 };

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
    const turning = previous ? previous.turning * 0.35 + omega * 0.65 : 0;
    const speed = clamp(e.vx * Math.cos(e.angle) + e.vy * Math.sin(e.angle), -s.physics.moveSpeed, s.physics.moveSpeed);
    const model = previous || { future: Array.from({ length: 91 }, () => ({})), linear: Array.from({ length: 91 }, () => ({})) };
    Object.assign(model, e, { turning, speed });
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

// ---------- 导航：全图代价搜索、道具争夺和对手选择 ----------
function navigate(s, g, enemies, mines) {
  const { cols, rows, cellSize: size, cells } = s.map, count = cols * rows;
  const cellOf = p => clamp(Math.floor(p.y / size), 0, rows - 1) * cols + clamp(Math.floor(p.x / size), 0, cols - 1);
  const center = i => ({ x: (i % cols + 0.5) * size, y: (Math.floor(i / cols) + 0.5) * size });
  const start = cellOf(s.self), dist = new Float64Array(count).fill(Infinity), prev = new Int16Array(count).fill(-1), used = new Uint8Array(count);
  const mineCosts = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const p = center(i);
    for (const m of mines) { const d = hypot(p.x - m.x, p.y - m.y); if (d < 85) mineCosts[i] += Math.max(0, 85 - d) * 8; }
  }
  dist[start] = 0;
  for (let n = 0; n < count; n++) {
    let at = -1, best = Infinity;
    for (let i = 0; i < count; i++) if (!used[i] && dist[i] < best) { at = i; best = dist[i]; }
    if (at < 0) break;
    used[at] = 1;
    const r = Math.floor(at / cols), c = at % cols;
    for (const [dc, dr, wall] of DIRECTIONS) {
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows || cells[r][c][wall]) continue;
      const next = nr * cols + nc, cost = best + size + mineCosts[next];
      if (cost < dist[next]) { dist[next] = cost; prev[next] = at; }
    }
  }
  const pathDistance = p => g.clear(s.self, p) ? hypot(p.x - s.self.x, p.y - s.self.y) : dist[cellOf(p)] + 35;
  let target = enemies[0], bestEnemy = Infinity;
  for (const e of enemies) {
    const cost = pathDistance(e) + (e.shield && !s.self.shield ? 100 : 0) + (e.laserShots ? 35 : 0) - (memory.targetId === e.id ? 30 : 0);
    if (cost < bestEnemy) { bestEnemy = cost; target = e; }
  }
  memory.targetId = target.id;
  let goal = target, utility = -Infinity, pickup = false;
  const enemyDistance = hypot(target.x - s.self.x, target.y - s.self.y);
  for (const p of s.powerups) {
    if (p.type === 'mine' && (s.self.laserShots || s.self.scatterShots || s.self.mineCharges)) continue;
    if (p.type === 'shield' && s.self.shieldTime > 2.5) continue;
    const cost = pathDistance(p);
    let value = { shield: 390, laser: 330, scatter: 290, mine: 125 }[p.type] - cost;
    if (enemyDistance < 145 && g.clear(s.self, target, 3) && p.type !== 'shield') value -= 210;
    if (s.self.laserShots && p.type !== 'shield') value -= 280;
    const competing = Math.min(...enemies.map(e => hypot(e.x - p.x, e.y - p.y)));
    if (competing + 55 < cost) value -= 100;
    if (value > utility && value > 0) { utility = value; goal = p; pickup = true; }
  }
  let waypoint = goal;
  if (!g.clear(s.self, goal, 18) || mines.some(m => segmentDistance2(m.x, m.y, s.self.x, s.self.y, goal.x, goal.y) < 45 * 45)) {
    const route = [];
    for (let at = cellOf(goal); at !== start && at !== -1; at = prev[at]) route.push(center(at));
    route.reverse();
    waypoint = center(start);
    for (const p of route.slice(0, 5)) {
      if (!g.clear(s.self, p, 18)) break;
      if (mines.some(m => segmentDistance2(m.x, m.y, s.self.x, s.self.y, p.x, p.y) < 45 * 45)) break;
      waypoint = p;
    }
    if (hypot(waypoint.x - s.self.x, waypoint.y - s.self.y) < 7 && route.length) waypoint = route[0];
  }
  return { target, waypoint, goal, pickup, distance: enemyDistance };
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
  for (const e of enemies) {
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
    const closePlanes = g.planes.map(p => ({ ...p, distance: Math.abs(p.value - (p.vertical ? self.x : self.y)) })).sort((a, b) => a.distance - b.distance).slice(0, 12);
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
    } else value = shotValue(path, enemies, s, rotation * 0.45);
    const utility = value.score / (1 + rotation * 0.65) - rotation * 0.015;
    if (utility > best.utility) best = { ...value, angle, utility, path };
  }
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
    for (const offset of e.scatterShots ? [-0.26, 0, 0.26] : [0]) {
      const heading = e.angle + clamp(e.turning, -3, 3) * s.dt + offset;
      const muzzle = g.muzzle(e, heading, s.physics.muzzleOffset);
      incoming.push({ id: 'potential-' + e.id + '-' + offset, ownerId: e.id,
        x: muzzle.x, y: muzzle.y, vx: Math.cos(heading) * s.physics.bulletSpeed,
        vy: Math.sin(heading) * s.physics.bulletSpeed, age: 0, bounces: 0, speculative: true });
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
    threats.push({ id: b.id, points, active, speculative: !!b.speculative });
  }
  const currentIds = new Set(incoming.map(b => b.id));
  for (const id of memory.forecasts.keys()) if (!currentIds.has(id)) memory.forecasts.delete(id);
  const lasers = [];
  for (const e of enemies) if (e.laserShots && e.cooldown < 0.35) {
    for (const offset of [0, -s.physics.turnSpeed * s.dt, s.physics.turnSpeed * s.dt]) {
      const angle = e.angle + offset, muzzle = g.muzzle(e, angle, s.physics.muzzleOffset);
      lasers.push({ enemy: e, weight: offset ? 0.65 : 1, path: g.trace(muzzle, angle, s.physics.laser.maxLength, 0, s.physics.laser.maxBounces) });
    }
  }
  return { threats, lasers };
}

// ---------- 模型预测控制：前进/倒车/停转、三段动作和受威胁轨迹比较 ----------
function drive(p, control, s, g, frame, enemies) {
  if (control.phases) control = control.phases[Math.min(control.phases.length - 1, Math.floor((frame - 1) / 12))];
  let heading = control.heading;
  if (control.goal) heading = Math.atan2(control.goal.y - p.y, control.goal.x - p.x) + (control.move < 0 ? Math.PI : 0);
  const error = angleDiff(heading - p.angle), turn = clamp(error / (s.physics.turnSpeed * s.dt), -1, 1);
  const move = control.gate && Math.abs(error) > 1.1 ? 0 : control.move;
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
  const horizon = keepPath ? 66 : 48;
  let firstAction;
  for (let f = 1; f <= horizon; f++) {
    const oldX = p.x, oldY = p.y;
    const action = drive(p, control, s, g, f, enemies);
    if (f === 1) firstAction = action;
    moved += hypot(p.x - oldX, p.y - oldY);
    if (path) path.push({ ...p });
    if (f > 8 && f % 2) continue;
    const t = f * s.dt, weight = 1 / (0.45 + t), shield = s.self.shield && s.self.shieldTime > t && !shieldSpent;
    for (const b of danger.threats) {
      if (!b.active[f] || struck.has(b.id)) continue;
      const bx = b.points[f * 2], by = b.points[f * 2 + 1];
      const d2 = sq(p.x - bx) + sq(p.y - by);
      if (d2 < 22 * 22) {
        struck.add(b.id);
        if (b.speculative) possibleRisk = Math.max(possibleRisk, (shield ? 12 : 450) * weight);
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
    }
  }
  const startDistance = hypot(nav.waypoint.x - s.self.x, nav.waypoint.y - s.self.y), endDistance = hypot(nav.waypoint.x - p.x, nav.waypoint.y - p.y);
  cost += (endDistance - startDistance) * (nav.pickup ? 0.65 : 0.44);
  const target = nav.target, ep = future(target, horizon * s.dt);
  const range = hypot(ep.x - p.x, ep.y - p.y);
  const aimError = Math.abs(angleDiff(aim.angle - p.angle));
  if (aim.score > 0.12) cost += aimError * (s.self.laserShots ? 60 : 20) * Math.min(1, aim.score * 3);
  if (!nav.pickup && g.clear(s.self, target, 3)) {
    const ideal = s.self.shield ? 65 : target.shield ? 200 : target.scatterShots ? 130 : 95;
    if (range < ideal) cost += (ideal - range) * (target.shield ? 0.5 : 0.8);
  }
  if (firstAction.move && moved < 20) cost += 25;
  cost += Math.abs(firstAction.turn) * 0.15;
  if (memory.previous) {
    if (firstAction.move * memory.previous.move < 0) cost += 1.4;
    if (firstAction.turn * memory.previous.turn < 0) cost += 0.4;
  }
  return { cost: cost + fatalRisk + possibleRisk + nearRisk + laserRisk + gunRisk + closeRisk, control, action: firstAction, path, moved };
}
function chooseMovement(s, g, enemies, mines, danger, nav, aim, deadline) {
  const a = s.self.angle, navAngle = Math.atan2(nav.waypoint.y - s.self.y, nav.waypoint.x - s.self.x);
  const candidates = [
    { move: 1, heading: navAngle, goal: nav.waypoint, gate: true },
    { move: -1, heading: navAngle + Math.PI, goal: nav.waypoint, gate: true },
    { move: 0, heading: aim.angle }, { move: 1, heading: aim.angle }, { move: -1, heading: aim.angle },
    { move: 0, heading: a }, { move: 1, heading: a }, { move: -1, heading: a },
  ];
  for (const delta of [-Math.PI / 2, -Math.PI / 3, Math.PI / 3, Math.PI / 2]) {
    candidates.push({ move: 1, heading: a + delta }, { move: -1, heading: a + delta });
  }
  if (memory.previous) candidates.unshift(memory.previous.control);
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
  for (let depth = 1; depth <= 2 && best.cost > 20; depth++) {
    const expanded = [];
    for (const candidate of beam) {
      const prefix = candidate.control.phases ? candidate.control.phases.slice(0, depth) : [candidate.control];
      for (const next of follow) {
        if (now() > deadline) break;
        const option = simulateControl({ phases: [...prefix, next] }, s, g, enemies, mines, danger, nav, aim);
        expanded.push(option);
        if (option.cost < best.cost) best = option;
      }
      if (now() > deadline) break;
    }
    if (!expanded.length) break;
    expanded.sort((a, b) => a.cost - b.cost);
    beam = expanded.slice(0, 2);
  }
  return simulateControl(best.control, s, g, enemies, mines, danger, nav, aim, true);
}

function safeToFire(s, g, enemies, movement) {
  const p = movement.path[1], laser = s.self.laserShots > 0;
  if (s.self.cooldown > s.dt || (!laser && !s.self.scatterShots && s.self.bulletsActive >= s.physics.maxBullets)) return false;
  if (laser) {
    const muzzle = g.muzzle(p, p.angle, s.physics.muzzleOffset);
    const hit = laserHit(g.trace(muzzle, p.angle, s.physics.laser.maxLength, 0, s.physics.laser.maxBounces), p, enemies, s.dt);
    return !!hit && hit.id !== '@self';
  }
  const angles = s.self.scatterShots ? [p.angle - s.physics.scatter.spreadAngle, p.angle, p.angle + s.physics.scatter.spreadAngle] : [p.angle];
  let score = 0;
  for (const angle of angles) {
    const muzzle = g.muzzle(p, angle, s.physics.muzzleOffset);
    const trace = g.trace(muzzle, angle, 510, s.physics.bulletRadius, 5);
    score = Math.max(score, shotValue(trace, enemies, s).score);
    const b = { ...muzzle, vx: Math.cos(angle) * s.physics.bulletSpeed, vy: Math.sin(angle) * s.physics.bulletSpeed, age: 0, bounces: 0 };
    for (let f = 1; f < movement.path.length; f++) {
      g.bulletStep(b, s.dt, s.physics.bulletRadius);
      const own = movement.path[f];
      if ((b.bounces || b.age >= s.physics.selfHitGrace) && hypot(b.x - own.x, b.y - own.y) < 23) return false;
      // 若预测先打中敌人，该弹体已被吸收，不再虚构后续自伤。
      if (enemies.some(e => { const target = future(e, f * s.dt); return hypot(b.x - target.x, b.y - target.y) < 18; })) break;
    }
  }
  const reserve = s.self.scatterShots ? 0 : s.self.bulletsActive;
  const threshold = reserve >= 4 ? 0.70 : reserve >= 3 ? 0.45 : reserve >= 2 ? 0.27 : 0.22;
  const cadence = score > 0.45 || s.self.scatterShots ? 0.16 : score > 0.28 ? 0.30 : 0.65;
  return score > threshold && s.time - memory.lastShot >= cadence;
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
    const nav = navigate(s, g, enemies, mines);
    const aim = chooseAim(s, g, enemies, nav, started + 1.6);
    const danger = predictThreats(s, g, enemies);
    const movement = chooseMovement(s, g, enemies, mines, danger, nav, aim, started + 4.5);
    const fire = safeToFire(s, g, enemies, movement);
    if (fire) memory.lastShot = s.time;
    memory.previous = { ...movement.action, control: movement.control };
    return { ...movement.action, fire, special: deployMine(s, g, enemies, movement) };
  },
};
