/*
 * 织局者 / WEAVER — ChatGPT Gen1
 * Closed-book entrant, written against AI_Starter_Kit API v1.
 * No dependencies, engine access, opponent code, timers or external services.
 * Position, gun direction and finite projectile capacity are separate resources.
 */
'use strict';

const { abs, min, max, cos, sin, sqrt, atan2, floor, ceil, round, PI } = Math;
const TAU = PI * 2;
const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
const wrap = a => { a %= TAU; return a > PI ? a - TAU : a < -PI ? a + TAU : a; };
const hypot = Math.hypot;
const sign = (x, eps = 0.06) => x > eps ? 1 : x < -eps ? -1 : 0;
const sq = x => x * x;
let geo = null;
let mem = null;

function reset(s) {
  mem = { lastTick: -1, calls: 0, id: s.self.id, previous: { move: 0, turn: 0 },
    enemies: Object.create(null), mines: Object.create(null), lastShot: -180,
    goalKey: '', goalSince: 0, travelSign: 1, aim: null, aimTick: -100,
    stuck: 0, lastPos: null, escapeUntil: -1, flank: ((floor(s.self.x / 96) +
      floor(s.self.y / 96)) & 1) ? 1 : -1, anchor: null, progressTick: s.tick };
}

// Spatial bins make ray and disk queries depend mostly on local geometry.
function buildGeometry(map) {
  const size = map.cellSize, cols = map.cols, rows = map.rows;
  const bins = Array.from({ length: cols * rows }, () => []);
  const walls = map.walls.map(w => ({ x0: min(w.x1, w.x2),
    x1: max(w.x1, w.x2), y0: min(w.y1, w.y2),
    y1: max(w.y1, w.y2), vertical: w.x1 === w.x2 }));
  const xs = new Set(), ys = new Set();
  walls.forEach((w, i) => {
    if (w.vertical) xs.add(w.x0); else ys.add(w.y0);
    for (let r = clamp(floor((w.y0 - 24) / size), 0, rows - 1);
      r <= clamp(floor((w.y1 + 24) / size), 0, rows - 1); r++) {
      for (let c = clamp(floor((w.x0 - 24) / size), 0, cols - 1);
        c <= clamp(floor((w.x1 + 24) / size), 0, cols - 1); c++) bins[r * cols + c].push(i);
    }
  });
  return { walls, bins, seen: new Int32Array(walls.length), stamp: 1,
    cols, rows, size, width: map.width, height: map.height,
    xs: [...xs], ys: [...ys], count: map.walls.length, fields: new Map(), cells: map.cells };
}

function binAt(x, y) {
  return geo.bins[clamp(floor(y / geo.size), 0, geo.rows - 1) * geo.cols +
    clamp(floor(x / geo.size), 0, geo.cols - 1)];
}

// First collision against axis-aligned wall segments. r=0 for optical rays;
// a small expanded box is a conservative corner approximation for projectiles.
function rayWall(x, y, dx, dy, length, r = 0) {
  const g = geo, stamp = ++g.stamp;
  let c = clamp(floor(x / g.size), 0, g.cols - 1);
  let row = clamp(floor(y / g.size), 0, g.rows - 1);
  const sx = dx >= 0 ? 1 : -1, sy = dy >= 0 ? 1 : -1;
  const incX = abs(dx) > 1e-10 ? g.size / abs(dx) : Infinity;
  const incY = abs(dy) > 1e-10 ? g.size / abs(dy) : Infinity;
  let tx = abs(dx) > 1e-10 ? ((c + (sx > 0 ? 1 : 0)) * g.size - x) / dx : Infinity;
  let ty = abs(dy) > 1e-10 ? ((row + (sy > 0 ? 1 : 0)) * g.size - y) / dy : Infinity;
  let best = length + 1e-7, fx = false, fy = false, index = -1;
  for (let guard = 0; guard < g.cols + g.rows + 6; guard++) {
    const list = g.bins[row * g.cols + c];
    for (let j = 0; j < list.length; j++) {
      const wi = list[j]; if (g.seen[wi] === stamp) continue; g.seen[wi] = stamp;
      const w = g.walls[wi];
      let ax = -Infinity, bx = Infinity, ay = -Infinity, by = Infinity;
      if (abs(dx) < 1e-10) { if (x < w.x0 - r || x > w.x1 + r) continue; }
      else { ax = (w.x0 - r - x) / dx; bx = (w.x1 + r - x) / dx; if (ax > bx) [ax, bx] = [bx, ax]; }
      if (abs(dy) < 1e-10) { if (y < w.y0 - r || y > w.y1 + r) continue; }
      else { ay = (w.y0 - r - y) / dy; by = (w.y1 + r - y) / dy; if (ay > by) [ay, by] = [by, ay]; }
      let near = max(ax, ay); const far = min(bx, by);
      if (near > far + 1e-7 || far < 1e-5 || near > best + 1e-5) continue;
      if (near < 1e-5) {
        // Starting within an expanded wall band permits leaving or sliding,
        // never a shortcut through the wall that the real tank cannot follow.
        const ox = x - clamp(x, w.x0, w.x1), oy = y - clamp(y, w.y0, w.y1);
        if (r <= 0 || ox * dx + oy * dy >= -1e-8) continue;
        near = 1e-5;
      }
      const nx = w.vertical, ny = !w.vertical;
      if (near < best - 1e-5) { best = near; fx = nx; fy = ny; index = wi; }
      else { fx = fx || nx; fy = fy || ny; }
    }
    const edge = min(tx, ty);
    if (best <= edge + 1e-6 || edge > length) break;
    if (tx < ty - 1e-7) { c += sx; tx += incX; }
    else if (ty < tx - 1e-7) { row += sy; ty += incY; }
    else { c += sx; row += sy; tx += incX; ty += incY; }
    if (c < 0 || c >= g.cols || row < 0 || row >= g.rows) break;
  }
  return index < 0 ? null : { d: min(length, best), fx, fy, index };
}

function clearSegment(x, y, ex, ey, radius = 0) {
  const d = hypot(ex - x, ey - y);
  return d < 0.001 || !rayWall(x, y, (ex - x) / d, (ey - y) / d, d, radius);
}

function pushWalls(p, radius) {
  p.x = clamp(p.x, radius, geo.width - radius);
  p.y = clamp(p.y, radius, geo.height - radius);
  for (let pass = 0; pass < 2; pass++) {
    const list = binAt(p.x, p.y);
    for (let k = 0; k < list.length; k++) {
      const w = geo.walls[list[k]];
      const qx = clamp(p.x, w.x0, w.x1), qy = clamp(p.y, w.y0, w.y1);
      const dx = p.x - qx, dy = p.y - qy, dd = dx * dx + dy * dy;
      if (dd >= radius * radius) continue;
      if (dd > 1e-10) { const f = radius / sqrt(dd) - 1; p.x += dx * f; p.y += dy * f; }
      else if (w.vertical) p.x += radius * (p.x >= w.x0 ? 1 : -1);
      else p.y += radius * (p.y >= w.y0 ? 1 : -1);
    }
  }
}

function advance(p, move, turn, dt, ph) {
  p.a = wrap(p.a + turn * ph.turnSpeed * dt);
  p.x += cos(p.a) * move * ph.moveSpeed * dt;
  p.y += sin(p.a) * move * ph.moveSpeed * dt;
  pushWalls(p, ph.tankRadius);
  return p;
}

function muzzle(p, a, ph) {
  const dx = cos(a), dy = sin(a);
  const wall = rayWall(p.x, p.y, dx, dy, ph.muzzleOffset);
  const offset = wall ? max(0, wall.d - ph.bulletRadius - 1) : ph.muzzleOffset;
  return { x: p.x + dx * offset, y: p.y + dy * offset, dx, dy, offset };
}

// Reflected ray segments carry cumulative distance, so time is unambiguous.
function trace(x, y, dx, dy, distance, radius, maxBounces) {
  const segments = [];
  let done = 0;
  for (let bounce = 0; bounce <= maxBounces && done < distance - 1e-5; bounce++) {
    const hit = rayWall(x, y, dx, dy, distance - done, radius);
    const len = hit ? hit.d : distance - done;
    segments.push({ x, y, dx, dy, len, start: done, bounce });
    done += len;
    if (!hit) break;
    x += dx * len; y += dy * len;
    if (hit.fx) dx = -dx;
    if (hit.fy) dy = -dy;
    x += dx * 0.002; y += dy * 0.002;
  }
  return segments;
}

function lineCircle(seg, x, y, radius) {
  const rx = x - seg.x, ry = y - seg.y;
  const along = rx * seg.dx + ry * seg.dy;
  const perp2 = rx * rx + ry * ry - along * along;
  if (perp2 > radius * radius || along + radius < 0 || along - radius > seg.len) return null;
  const edge = sqrt(max(0, radius * radius - perp2));
  if (along + edge < 0) return null;
  const enter = max(0, along - edge);
  return enter <= seg.len ? { enter, margin: radius - sqrt(max(0, perp2)) } : null;
}

function cellIndex(x, y) {
  return clamp(floor(y / geo.size), 0, geo.rows - 1) * geo.cols + clamp(floor(x / geo.size), 0, geo.cols - 1);
}

function distances(target) {
  if (geo.fields.has(target)) return geo.fields.get(target);
  const dist = new Int16Array(geo.rows * geo.cols); dist.fill(-1);
  const q = new Int32Array(dist.length); let head = 0, tail = 1; q[0] = target; dist[target] = 0;
  while (head < tail) {
    const i = q[head++], r = floor(i / geo.cols), c = i % geo.cols, w = geo.cells[r][c];
    const neighbors = [!w.top && r > 0 ? i - geo.cols : -1, !w.right && c + 1 < geo.cols ? i + 1 : -1,
      !w.bottom && r + 1 < geo.rows ? i + geo.cols : -1, !w.left && c > 0 ? i - 1 : -1];
    for (const j of neighbors) if (j >= 0 && dist[j] < 0) { dist[j] = dist[i] + 1; q[tail++] = j; }
  }
  if (geo.fields.size > 16) geo.fields.clear();
  geo.fields.set(target, dist); return dist;
}

function route(x, y, target) {
  if (clearSegment(x, y, target.x, target.y, 18)) return [{ x: target.x, y: target.y }];
  let cur = cellIndex(x, y); const dst = cellIndex(target.x, target.y), field = distances(dst);
  if (field[cur] < 0) return [{ x, y }];
  const points = [{ x: (cur % geo.cols + 0.5) * geo.size, y: (floor(cur / geo.cols) + 0.5) * geo.size }];
  for (let n = 0; n < 16 && cur !== dst; n++) {
    const r = floor(cur / geo.cols), c = cur % geo.cols, w = geo.cells[r][c];
    const ns = [!w.top && r > 0 ? cur - geo.cols : -1, !w.right && c + 1 < geo.cols ? cur + 1 : -1,
      !w.bottom && r + 1 < geo.rows ? cur + geo.cols : -1, !w.left && c > 0 ? cur - 1 : -1];
    let next = -1;
    for (const j of ns) if (j >= 0 && field[j] >= 0 && field[j] < field[cur]) { next = j; break; }
    if (next < 0) break;
    cur = next; points.push({ x: (cur % geo.cols + 0.5) * geo.size, y: (floor(cur / geo.cols) + 0.5) * geo.size });
  }
  if (cur === dst) points.push({ x: target.x, y: target.y });
  let far = 0;
  for (let i = points.length - 1; i >= 0; i--) if (clearSegment(x, y, points[i].x, points[i].y, 18)) { far = i; break; }
  return points.slice(far);
}

function prepareEnemies(s) {
  const result = [];
  for (const e of s.enemies) {
    if (!e.alive) continue;
    const old = mem.enemies[e.id];
    const elapsed = old ? max(s.dt, (s.tick - old.tick) * s.dt) : s.dt;
    const omega = old ? clamp(wrap(e.angle - old.angle) / elapsed, -s.physics.turnSpeed, s.physics.turnSpeed) : 0;
    let vx = clamp(e.vx, -s.physics.moveSpeed, s.physics.moveSpeed), vy = clamp(e.vy, -s.physics.moveSpeed, s.physics.moveSpeed);
    const speed = hypot(vx, vy);
    if (speed > s.physics.moveSpeed) { vx *= s.physics.moveSpeed / speed; vy *= s.physics.moveSpeed / speed; }
    const avx = old ? old.avx * 0.65 + vx * 0.35 : vx;
    const avy = old ? old.avy * 0.65 + vy * 0.35 : vy;
    const jitter = old ? old.jitter * 0.8 + hypot(vx - old.vx, vy - old.vy) * 0.2 : 0;
    mem.enemies[e.id] = { tick: s.tick, angle: e.angle, vx, vy, avx, avy, jitter };
    const m = { e, vx, vy, jitter, omega, dist: hypot(e.x - s.self.x, e.y - s.self.y), xs: [], ys: [] };
    const p = { x: e.x, y: e.y, a: e.angle };
    const movement = clamp((vx * cos(e.angle) + vy * sin(e.angle)) / s.physics.moveSpeed, -1, 1);
    const turn = (old && abs(omega) < 2.7 && jitter < 35) ? omega / s.physics.turnSpeed : 0;
    const steadyMove = jitter > 65 ? clamp((avx * cos(e.angle) + avy * sin(e.angle)) / s.physics.moveSpeed, -1, 1) : movement;
    m.xs.push(p.x); m.ys.push(p.y);
    for (let k = 1; k <= 25; k++) {
      // First 0.1 seconds uses actual velocity; later extrapolation is deliberately modest.
      if (k === 1) { p.x += vx * 0.1; p.y += vy * 0.1; pushWalls(p, s.physics.tankRadius); }
      else { advance(p, steadyMove, turn * max(0, 1 - k / 20), 0.05, s.physics);
        advance(p, steadyMove, turn * max(0, 1 - k / 20), 0.05, s.physics); }
      m.xs.push(p.x); m.ys.push(p.y);
    }
    result.push(m);
  }
  result.sort((a, b) => a.dist - b.dist); return result;
}

function enemyAt(m, time) {
  const f = clamp(time * 10, 0, 24.999), i = floor(f), a = f - i;
  return { x: m.xs[i] * (1 - a) + m.xs[i + 1] * a, y: m.ys[i] * (1 - a) + m.ys[i + 1] * a };
}

function chooseGoal(s, models) {
  const me = s.self, here = cellIndex(me.x, me.y), from = distances(here), ph = s.physics;
  let best = null, previous = null;
  const choices = [];
  for (const m of models) {
    const hops = from[cellIndex(m.e.x, m.e.y)]; if (hops < 0) continue;
    const dist = max(m.dist, hops * geo.size * 0.8);
    choices.push({ type: 'enemy', key: m.e.id, x: m.e.x, y: m.e.y, model: m,
      value: 115 / (1 + dist / 320) + (m.e.shield ? -12 : 0) });
  }
  for (const p of s.powerups) {
    const hops = from[cellIndex(p.x, p.y)]; if (hops < 0) continue;
    const d = max(hypot(me.x - p.x, me.y - p.y), hops * geo.size * 0.8);
    let value = p.type === 'laser' ? 440 : p.type === 'shield' ? (me.shield ? 95 : 280) : p.type === 'scatter' ? 230 : 90;
    if (me.laserShots > 0 && p.type !== 'laser' && p.type !== 'shield') value = 5;
    if (me.scatterShots > 0 && p.type === 'mine') value = 12;
    const toward = atan2(p.y - me.y, p.x - me.x);
    const turnTime = min(abs(wrap(toward - me.angle)), abs(wrap(toward + PI - me.angle))) / ph.turnSpeed;
    const eta = max(0, d - 30) / ph.moveSpeed + turnTime * 0.6;
    let otherEta = Infinity;
    const field = distances(cellIndex(p.x, p.y));
    for (const m of models) {
      const eh = field[cellIndex(m.e.x, m.e.y)]; if (eh >= 0)
        otherEta = min(otherEta, max(hypot(m.e.x - p.x, m.e.y - p.y), eh * geo.size * 0.8) / ph.moveSpeed);
    }
    let score = value / (1 + eta * 0.65);
    if (otherEta + 0.7 < eta) score *= 0.6;
    if (p.type === 'laser' && abs(otherEta - eta) < 1.4) score *= 1.15;
    choices.push({ type: 'pickup', key: p.type + ':' + p.x + ':' + p.y, x: p.x, y: p.y, value: score, pickup: p });
  }
  for (const c of choices) {
    if (c.key === mem.goalKey) previous = c;
    if (!best || c.value > best.value) best = c;
  }
  if (!best) best = { type: 'idle', key: 'idle', x: me.x, y: me.y, value: 0 };
  if (previous && best.key !== previous.key && best.value < previous.value * 1.25 + 10 && s.tick - mem.goalSince < 45) best = previous;
  if (mem.goalKey !== best.key) { mem.goalKey = best.key; mem.goalSince = s.tick; }
  let target = { x: best.x, y: best.y };
  if (best.type === 'enemy' && clearSegment(me.x, me.y, target.x, target.y, 0)) {
    const e = best.model.e, d = hypot(target.x - me.x, target.y - me.y);
    const ownCan = me.laserShots > 0 || me.scatterShots > 0 || me.bulletsActive < ph.maxBullets;
    const enemyCan = e.laserShots > 0 || e.scatterShots > 0 || e.bulletsActive < ph.maxBullets;
    let desired = !ownCan && enemyCan ? 205 : ownCan && !enemyCan ? 78 : me.scatterShots > 0 ? 105 : 140;
    if (e.shield && !me.shield) desired += 45;
    if (me.shield && !e.shield && ownCan) desired -= 35;
    const deadband = 12;
    if (abs(d - desired) < deadband) target = { x: me.x, y: me.y };
    else if (d > 1) target = { x: e.x + (me.x - e.x) * desired / d, y: e.y + (me.y - e.y) * desired / d };
    if (s.tick - mem.lastShot > 150 && ownCan && d < 300) {
      const side = mem.flank, tx = target.x - (e.y - me.y) / max(1, d) * 65 * side;
      const ty = target.y + (e.x - me.x) / max(1, d) * 65 * side;
      if (clearSegment(me.x, me.y, tx, ty, 18) && tx > 20 && ty > 20 && tx < geo.width - 20 && ty < geo.height - 20)
        target = { x: tx, y: ty };
    }
  }
  target.x = clamp(target.x, 19, geo.width - 19); target.y = clamp(target.y, 19, geo.height - 19);
  pushWalls(target, ph.tankRadius + 2);
  best.path = route(me.x, me.y, target);
  best.destination = target;
  best.tail = new Float64Array(best.path.length);
  for (let i = best.path.length - 2; i >= 0; i--)
    best.tail[i] = best.tail[i + 1] + hypot(best.path[i].x - best.path[i + 1].x, best.path[i].y - best.path[i + 1].y);
  return best;
}

function weaponFor(me) { return me.laserShots > 0 ? 'laser' : me.scatterShots > 0 ? 'scatter' : 'bullet'; }

function laserAssessment(p, angle, s, models, delay, strict) {
  const ph = s.physics, mu = muzzle(p, angle, ph);
  const segments = trace(mu.x, mu.y, mu.dx, mu.dy, ph.laser.maxLength, 0, ph.laser.maxBounces);
  for (const seg of segments) {
    let first = Infinity, score = 0, target = null;
    if (seg.bounce > 0) {
      const self = lineCircle(seg, p.x, p.y, ph.tankRadius + 1.5);
      if (self) first = self.enter;
    }
    for (let k = 0; k < models.length; k++) {
      const m = models[k], q = enemyAt(m, delay);
      const hit = lineCircle(seg, q.x, q.y, ph.tankRadius);
      if (hit && hit.enter < first) {
        first = hit.enter; target = m;
        const uncertainty = strict ? 2.5 : 2 + min(7, delay * 12);
        score = clamp((hit.margin - uncertainty + 4) / 10, 0, 1) * (m.e.shield ? 0.72 : 1);
      }
    }
    if (first < Infinity) return { quality: target ? score : -1, target, time: 0, segments, selfHit: !target };
  }
  return { quality: 0, target: null, time: 0, segments, selfHit: false };
}

// Relative closest approach along two short simultaneous line segments.
function approach(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = ax - cx, ry = ay - cy, vx = bx - ax - dx + cx, vy = by - ay - dy + cy;
  const f = clamp(-(rx * vx + ry * vy) / (vx * vx + vy * vy + 1e-12), 0, 1);
  return { d: hypot(rx + f * vx, ry + f * vy), f };
}

function ballisticAssessment(p, angle, s, models, delay, limit = 360) {
  const ph = s.physics, mu = muzzle(p, angle, ph);
  const segments = trace(mu.x, mu.y, mu.dx, mu.dy, limit, ph.bulletRadius, 8);
  let quality = 0, when = Infinity, target = null;
  for (const seg of segments) {
    const t0 = seg.start / ph.bulletSpeed, t1 = (seg.start + seg.len) / ph.bulletSpeed;
    const n = max(1, ceil((t1 - t0) / 0.16));
    for (let j = 0; j < n; j++) {
      const u0 = j / n, u1 = (j + 1) / n;
      const b0x = seg.x + seg.dx * seg.len * u0, b0y = seg.y + seg.dy * seg.len * u0;
      const b1x = seg.x + seg.dx * seg.len * u1, b1y = seg.y + seg.dy * seg.len * u1;
      const a = t0 + (t1 - t0) * u0, b = t0 + (t1 - t0) * u1;
      for (let k = 0; k < models.length; k++) {
        const m = models[k], e0 = enemyAt(m, delay + a), e1 = enemyAt(m, delay + b);
        const near = approach(b0x, b0y, b1x, b1y, e0.x, e0.y, e1.x, e1.y);
        const t = a + (b - a) * near.f;
        const uncertainty = 3 + t * (8 + min(32, m.jitter * 0.25));
        let q = clamp((ph.tankRadius + ph.bulletRadius + uncertainty * 0.35 - near.d) / (9 + uncertainty * 0.6), 0, 1);
        q *= 1 / (1 + 0.4 * t + delay * 0.45);
        // Stable positions are also plausible when an adversary changes controls.
        if (t > 0.12) {
          const still = approach(b0x, b0y, b1x, b1y, m.e.x, m.e.y, m.e.x, m.e.y);
          q = max(q, clamp((19 - still.d) / 18, 0, 1) * 0.52 / (1 + t));
        }
        if (q > quality) { quality = q; when = t; target = m; }
      }
    }
  }
  return { quality, time: when, target, segments, mu };
}

function leadTime(rx, ry, vx, vy, speed, offset) {
  const a = vx * vx + vy * vy - speed * speed;
  const b = 2 * (rx * vx + ry * vy - speed * offset), c = rx * rx + ry * ry - offset * offset;
  if (c <= 0) return 0;
  if (abs(a) < 1e-6) return b < 0 ? clamp(-c / b, 0, 2) : 1;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return min(1.6, hypot(rx, ry) / speed);
  const t1 = (-b - sqrt(disc)) / (2 * a), t2 = (-b + sqrt(disc)) / (2 * a);
  return clamp(min(t1 >= 0 ? t1 : Infinity, t2 >= 0 ? t2 : Infinity), 0, 2.2);
}

function chooseAim(s, models, goal) {
  const me = s.self, ph = s.physics, weapon = weaponFor(me), laser = weapon === 'laser';
  if (!models.length) return { angle: me.angle, quality: 0, target: null };
  const candidates = [], used = new Set();
  function add(angle, distance, owner) {
    angle = wrap(angle); const key = round(angle * 550);
    if (used.has(key)) return; used.add(key);
    const turn = abs(wrap(angle - me.angle)) / ph.turnSpeed;
    candidates.push({ angle, rank: turn * 110 + distance * (laser ? 0.07 : 0.17), owner });
  }
  add(me.angle, 0, null);
  if (mem.aim) add(mem.aim.angle, 1, null);
  const xs = geo.xs.slice().sort((a, b) => abs(a - me.x) - abs(b - me.x)).slice(0, 8);
  const ys = geo.ys.slice().sort((a, b) => abs(a - me.y) - abs(b - me.y)).slice(0, 8);
  const selected = models.slice(0, laser ? 4 : 3);
  for (const m of selected) {
    function image(sx, ox, sy, oy, stationary = false) {
      let x = sx * m.e.x + ox, y = sy * m.e.y + oy;
      const d = hypot(x - me.x, y - me.y);
      if (d > (laser ? ph.laser.maxLength + ph.muzzleOffset : 560)) return;
      const rough = atan2(y - me.y, x - me.x);
      const delay = min(0.7, abs(wrap(rough - me.angle)) / ph.turnSpeed);
      const velx = stationary ? 0 : sx * m.vx, vely = stationary ? 0 : sy * m.vy;
      const t = laser ? s.dt + delay : s.dt + delay + leadTime(x - me.x, y - me.y, velx, vely, ph.bulletSpeed, ph.muzzleOffset);
      const predicted = stationary ? m.e : enemyAt(m, t);
      x = sx * predicted.x + ox; y = sy * predicted.y + oy;
      add(atan2(y - me.y, x - me.x), d, m);
    }
    image(1, 0, 1, 0); image(1, 0, 1, 0, true);
    for (const x of xs) image(-1, 2 * x, 1, 0);
    for (const y of ys) image(1, 0, -1, 2 * y);
    for (const x of xs) for (const y of ys) image(-1, 2 * x, -1, 2 * y);
    for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) {
      image(1, 2 * (xs[i] - xs[j]), 1, 0); image(1, 2 * (xs[j] - xs[i]), 1, 0);
    }
    for (let i = 0; i < ys.length; i++) for (let j = i + 1; j < ys.length; j++) {
      image(1, 0, 1, 2 * (ys[i] - ys[j])); image(1, 0, 1, 2 * (ys[j] - ys[i]));
    }
  }
  candidates.sort((a, b) => a.rank - b.rank);
  let best = null, bestValue = -Infinity;
  const pose = { x: me.x, y: me.y, a: me.angle };
  const amount = mem.calls < 2 ? (laser ? 32 : 16) : (laser ? 100 : 52);
  for (let i = 0; i < min(amount, candidates.length); i++) {
    const c = candidates[i], delay = abs(wrap(c.angle - me.angle)) / ph.turnSpeed;
    const assessment = laser ? laserAssessment(pose, c.angle, s, selected, min(delay, 0.8) + s.dt, false) :
      ballisticAssessment(pose, c.angle, s, selected, min(delay, 0.7) + s.dt, 350);
    let value = assessment.quality * (laser ? 8 : 6) - delay * 0.85;
    if (mem.aim && abs(wrap(c.angle - mem.aim.angle)) < 0.12) value += 0.24;
    if (assessment.quality > 0 && value > bestValue) {
      bestValue = value; best = { angle: c.angle, quality: assessment.quality, target: assessment.target, weapon };
    }
  }
  if (!best) {
    const m = goal.model || models[0], q = enemyAt(m, laser ? s.dt : min(0.9, m.dist / ph.bulletSpeed));
    best = { angle: atan2(q.y - me.y, q.x - me.x), quality: 0, target: m, weapon };
  }
  mem.aim = { angle: best.angle, quality: best.quality, targetId: best.target ? best.target.e.id : null, weapon };
  mem.aimTick = s.tick; return best;
}

function rememberMines(s) {
  const seen = new Set(), ph = s.physics.mine;
  for (const m of s.mines) {
    seen.add(m.id);
    mem.mines[m.id] = { id: m.id, x: m.x, y: m.y, birth: s.time - m.age, ownerId: m.ownerId };
  }
  const hiddenAt = ph.armDelay + ph.visibleTime + ph.fadeTime;
  const result = [];
  for (const key of Object.keys(mem.mines)) {
    const m = mem.mines[key], age = s.time - m.birth;
    if (!seen.has(m.id) && age < hiddenAt - 0.04) { delete mem.mines[key]; continue; }
    if (hypot(m.x - s.self.x, m.y - s.self.y) < 260) result.push({ ...m, age });
  }
  return result;
}

function prepareThreats(s, models) {
  const ph = s.physics, times = [0, s.dt];
  // The first two calls use a smaller search while the VM compiles hot paths.
  // Safety still runs every Tick; no warm-up workload or extra time entitlement.
  for (let i = 1; i <= (mem.calls < 2 ? 16 : 24); i++) times.push(s.dt + i * 0.05);
  const horizon = times[times.length - 1], bins = Array.from({ length: times.length - 1 }, () => []);
  const reach = (ph.moveSpeed + ph.bulletSpeed) * horizon + 48;
  const active = s.bullets.filter(b => b.age < ph.bulletLifetime && hypot(b.x - s.self.x, b.y - s.self.y) < reach);
  active.sort((a, b) => sq(a.x - s.self.x) + sq(a.y - s.self.y) - sq(b.x - s.self.x) - sq(b.y - s.self.y));
  // Very crowded arenas get a bounded nearest-threat budget, not unbounded work.
  for (let bi = 0; bi < min(72, active.length); bi++) {
    const bullet = active[bi], speed = hypot(bullet.vx, bullet.vy);
    if (speed < 0.001) continue;
    const end = min(horizon, ph.bulletLifetime - bullet.age);
    const segments = trace(bullet.x, bullet.y, bullet.vx / speed, bullet.vy / speed, end * speed, ph.bulletRadius, 30);
    for (const seg of segments) {
      let a = seg.start / speed, b = (seg.start + seg.len) / speed;
      if (bullet.ownerId === s.self.id && bullet.bounces + seg.bounce === 0) a = max(a, ph.selfHitGrace - bullet.age);
      if (a >= b) continue;
      for (let step = 0; step < bins.length; step++) {
        const from = max(a, times[step]), to = min(b, times[step + 1]);
        if (to <= from) continue;
        const f0 = (from - times[step]) / (times[step + 1] - times[step]);
        const f1 = (to - times[step]) / (times[step + 1] - times[step]);
        bins[step].push({ id: bullet.id, f0, f1, time: from,
          x0: seg.x + seg.dx * (from * speed - seg.start), y0: seg.y + seg.dy * (from * speed - seg.start),
          x1: seg.x + seg.dx * (to * speed - seg.start), y1: seg.y + seg.dy * (to * speed - seg.start) });
      }
    }
  }
  const laserBeams = [];
  for (const m of models.slice(0, 6)) if (m.e.laserShots > 0) {
    const p = enemyAt(m, s.dt), pose = { x: p.x, y: p.y, a: m.e.angle };
    for (const delta of [0, -0.05, 0.05, -0.15, 0.15, -0.32, 0.32]) {
      const a = m.e.angle + delta, mu = muzzle(pose, a, ph);
      laserBeams.push({ enemy: m, ready: max(m.e.cooldown, abs(delta) / ph.turnSpeed),
        segments: trace(mu.x, mu.y, mu.dx, mu.dy, ph.laser.maxLength, 0, ph.laser.maxBounces) });
    }
  }
  return { times, bins, horizon, laserBeams, mines: rememberMines(s), count: active.length };
}

function navigationControl(p, env, direction, pathIndex) {
  const path = env.goal.path;
  let index = pathIndex;
  while (index < path.length - 1 && hypot(p.x - path[index].x, p.y - path[index].y) < 19) index++;
  const point = path[index], d = hypot(point.x - p.x, point.y - p.y);
  if (d < 5) return { move: 0, turn: clamp(wrap(env.aim.angle - p.a) * 5, -1, 1), index };
  const bearing = atan2(point.y - p.y, point.x - p.x);
  const desired = bearing + (direction < 0 ? PI : 0), error = wrap(desired - p.a);
  const turn = clamp(error * 4.8, -1, 1);
  let move = abs(error) > 1.2 ? 0 : direction * sq(max(0, cos(error)));
  if (d < 22 && index === path.length - 1) move *= clamp(d / 18, 0, 1);
  return { move, turn, index };
}

function controlFor(plan, p, time, env, pathIndex) {
  if (plan.kind === 'nav') return navigationControl(p, env, plan.direction, pathIndex);
  if (plan.kind === 'aim') return { move: plan.move, turn: clamp(wrap(env.aim.angle - p.a) / (env.s.physics.turnSpeed * 0.12), -1, 1), index: pathIndex };
  if (plan.kind === 'heading') return { move: plan.move, turn: clamp(wrap(plan.angle - p.a) * 5, -1, 1), index: pathIndex };
  if (plan.kind === 'pulse' && time >= plan.duration) return navigationControl(p, env, env.direction, pathIndex);
  return { move: plan.move, turn: plan.turn, index: pathIndex };
}

function futureFireCost(p, time, s, models) {
  let cost = 0;
  for (let i = 0; i < min(5, models.length); i++) {
    const m = models[i], e = m.e;
    if (e.cooldown > time + 0.05 || (!e.laserShots && !e.scatterShots && e.bulletsActive >= s.physics.maxBullets)) continue;
    const pos = enemyAt(m, min(time, 0.45)), d = hypot(p.x - pos.x, p.y - pos.y);
    if (d > 290) continue;
    const bearing = atan2(p.y - pos.y, p.x - pos.x);
    const error = abs(wrap(bearing - (e.angle + m.omega * min(time, 0.12))));
    const cone = atan2(22, max(1, d)) + (e.laserShots ? 0.12 : e.scatterShots ? 0.32 : 0.04);
    const reachable = s.physics.turnSpeed * min(time, e.laserShots ? 0.22 : 0.1);
    if (error > cone + reachable || !clearSegment(pos.x, pos.y, p.x, p.y)) continue;
    const readiness = clamp((cone + reachable - error) / max(0.1, cone), 0, 1);
    const urgency = e.laserShots ? 12 : d < 75 ? 8 : 2.2;
    cost += readiness * urgency / (1 + time * 1.8) * (s.self.shield && s.self.shieldTime > time ? 0.45 : 1);
  }
  return cost;
}

function evaluateMotion(plan, env) {
  const { s, models, threats, goal, aim } = env, ph = s.physics, times = threats.times;
  const p = { x: s.self.x, y: s.self.y, a: s.self.angle };
  let pathIndex = 0, firstAction = null, firstHit = Infinity, nearCost = 0, assumedCost = 0, scrape = 0;
  let absorbed = null, totalTravel = 0, progressArea = 0;
  const initialRemaining = hypot(p.x - goal.path[0].x, p.y - goal.path[0].y) + goal.tail[0];
  const frames = [{ x: p.x, y: p.y, a: p.a, time: 0 }];
  for (let k = 0; k < times.length - 1; k++) {
    const begin = times[k], end = times[k + 1], h = end - begin;
    const prevx = p.x, prevy = p.y;
    const u = controlFor(plan, p, begin, env, pathIndex); pathIndex = u.index;
    if (k === 0) firstAction = { move: clamp(u.move, -1, 1), turn: clamp(u.turn, -1, 1) };
    // Substeps keep wall and curvature predictions close to the public 60Hz order.
    const sub = max(1, round(h / s.dt));
    for (let j = 0; j < sub; j++) advance(p, u.move, u.turn, h / sub, ph);
    let contact = 0;
    for (let j = 0; j < min(8, models.length); j++) {
      const q = enemyAt(models[j], end), dx = p.x - q.x, dy = p.y - q.y, d = hypot(dx, dy);
      if (d < ph.tankRadius * 2 && d > 1e-7) {
        const f = (ph.tankRadius * 2 - d) * 0.5 / d;
        p.x += dx * f; p.y += dy * f; contact += 0.06;
      }
    }
    if (contact) pushWalls(p, ph.tankRadius);
    while (pathIndex < goal.path.length - 1 && hypot(p.x - goal.path[pathIndex].x, p.y - goal.path[pathIndex].y) < 19) pathIndex++;
    const remaining = hypot(p.x - goal.path[pathIndex].x, p.y - goal.path[pathIndex].y) + goal.tail[pathIndex];
    progressArea += (initialRemaining - remaining) * h;
    const moved = hypot(p.x - prevx, p.y - prevy);
    totalTravel += moved;
    scrape += max(0, abs(u.move) * ph.moveSpeed * h - moved) * 0.025 + contact;
    for (const b of threats.bins[k]) {
      if (b.id === absorbed) continue;
      const q = approach(prevx + (p.x - prevx) * b.f0, prevy + (p.y - prevy) * b.f0,
        prevx + (p.x - prevx) * b.f1, prevy + (p.y - prevy) * b.f1, b.x0, b.y0, b.x1, b.y1);
      const t = begin + h * (b.f0 + q.f * (b.f1 - b.f0));
      const radius = ph.tankRadius + ph.bulletRadius;
      if (q.d < radius + 0.8) {
        if (s.self.shield && s.self.shieldTime > t && absorbed === null) absorbed = b.id;
        else firstHit = min(firstHit, t);
      }
      if (q.d < radius + 24) nearCost += sq(clamp((radius + 24 - q.d) / 24, 0, 1)) * h / (0.35 + t) * 3;
    }
    for (const mine of threats.mines) {
      if (mine.age + end < ph.mine.armDelay) continue;
      const d = hypot(p.x - mine.x, p.y - mine.y);
      let danger = ph.mine.triggerRadius + 2;
      for (let ei = 0; ei < min(5, models.length); ei++) {
        const ep = enemyAt(models[ei], end);
        if (hypot(ep.x - mine.x, ep.y - mine.y) < ph.mine.triggerRadius + 8) { danger = ph.mine.blastRadius + 3; break; }
      }
      if (d < danger) {
        const key = 'm' + mine.id;
        if (s.self.shield && s.self.shieldTime > end && (absorbed === null || absorbed === key)) absorbed = key;
        else firstHit = min(firstHit, end);
      } else if (d < danger + 20) nearCost += (danger + 20 - d) * 0.015;
    }
    if (k < 13 && k % 2 === 0) for (const beam of threats.laserBeams) {
      if (beam.ready > end + 0.06) continue;
      let hit = false;
      for (const seg of beam.segments) if (lineCircle(seg, p.x, p.y, ph.tankRadius + 4)) { hit = true; break; }
      if (hit) assumedCost += (s.self.shield ? 1 : 6) * h / (0.12 + end);
    }
    if (k % 5 === 0) assumedCost += futureFireCost(p, end, s, models) * 0.2;
    frames.push({ x: p.x, y: p.y, a: p.a, time: end });
  }
  const wp = goal.path[pathIndex];
  const progress = initialRemaining - hypot(p.x - wp.x, p.y - wp.y) - goal.tail[pathIndex];
  const targetDistance = hypot(p.x - goal.destination.x, p.y - goal.destination.y);
  let score = progress * (goal.type === 'pickup' ? 0.085 : 0.060);
  // Stage progress prevents "wait now, do everything later" MPC procrastination.
  score += progressArea / threats.horizon * 0.035;
  if (goal.type === 'pickup' && targetDistance < 31) score += 4;
  const ready = s.self.laserShots > 0 || s.self.scatterShots > 0 || s.self.bulletsActive < ph.maxBullets;
  const gunError = abs(wrap(aim.angle - p.a));
  const pose0Error = abs(wrap(aim.angle - s.self.angle));
  score += (pose0Error - gunError) * (ready ? (s.self.laserShots ? 3.1 : 1.6) : 0.45);
  if (ready) score += max(0, cos(gunError)) * aim.quality * (s.self.laserShots ? 4 : 1.8);
  // Only meaningful reversals are penalized; tiny steering corrections are fine.
  const pm = sign(mem.previous.move, 0.15), pt = sign(mem.previous.turn, 0.18);
  if (pm && sign(firstAction.move, 0.15) === -pm) score -= 0.85;
  if (pt && sign(firstAction.turn, 0.18) === -pt) score -= 0.3;
  score -= abs(firstAction.move - mem.previous.move) * 0.08;
  score -= abs(firstAction.turn - mem.previous.turn) * 0.05;
  score -= scrape + nearCost + assumedCost;
  if (mem.stuck > 9 && abs(firstAction.move) > 0.5 && totalTravel < 12) score -= 9;
  if (mem.escapeUntil > s.tick && totalTravel > 45) score += min(1.5, totalTravel / 100);
  // Wall proximity is an option cost, not a prohibition on wall-following.
  const edge = min(p.x, p.y, geo.width - p.x, geo.height - p.y);
  if (edge < 24) score -= (24 - edge) * 0.09;
  if (absorbed !== null) score -= 3;
  const tier = firstHit < 0.38 ? 2 : firstHit < Infinity ? 1 : 0;
  if (firstHit < Infinity) score -= 100 / (0.1 + firstHit);
  return { plan, action: firstAction, frames, firstHit, tier, score };
}

function chooseMotion(s, models, goal, aim, threats) {
  const wp = goal.path[0], bearing = atan2(wp.y - s.self.y, wp.x - s.self.x);
  function cost(direction) {
    const heading = wrap(bearing + (direction < 0 ? PI : 0));
    return abs(wrap(heading - s.self.angle)) / s.physics.turnSpeed + abs(wrap(heading - aim.angle)) * 0.18;
  }
  let direction = cost(1) < cost(-1) ? 1 : -1;
  if (cost(mem.travelSign) < cost(direction) + 0.15) direction = mem.travelSign;
  mem.travelSign = direction;
  const env = { s, models, goal, aim, threats, direction };
  const candidates = [{ kind: 'nav', direction }, { kind: 'nav', direction: -direction },
    { kind: 'aim', move: 0 }, { kind: 'aim', move: -1 }, { kind: 'aim', move: 1 }];
  if (mem.calls >= 2) candidates.push({ kind: 'aim', move: -0.45 }, { kind: 'aim', move: 0.45 },
    { kind: 'pulse', move: mem.previous.move, turn: mem.previous.turn, duration: 0.14 });
  for (const move of [-1, 0, 1]) for (const turn of (mem.calls < 2 ? [-1, 0, 1] : [-1, -0.45, 0, 0.45, 1])) {
    candidates.push({ kind: 'constant', move, turn });
    if (mem.calls >= 2 && move && abs(turn) === 1) candidates.push({ kind: 'pulse', move, turn, duration: 0.24 });
  }
  if (mem.stuck > 8) {
    const center = { x: (cellIndex(s.self.x, s.self.y) % geo.cols + 0.5) * geo.size,
      y: (floor(cellIndex(s.self.x, s.self.y) / geo.cols) + 0.5) * geo.size };
    const a = atan2(center.y - s.self.y, center.x - s.self.x);
    candidates.push({ kind: 'heading', move: 1, angle: a }, { kind: 'heading', move: -1, angle: a + PI });
  }
  let best = null; const results = [];
  for (const plan of candidates) {
    const result = evaluateMotion(plan, env);
    results.push(result);
    if (!best || result.tier < best.tier || (result.tier === best.tier && result.score > best.score)) best = result;
  }
  // Validate actual next-Tick firing opportunities before selecting movement.
  // In particular, never rotate away from an already valid reflected laser hit.
  results.sort((a, b) => a.tier - b.tier || b.score - a.score);
  const ready = s.self.cooldown <= s.dt + 1e-8 &&
    (s.self.laserShots > 0 || s.self.scatterShots > 0 || s.self.bulletsActive < s.physics.maxBullets);
  if (ready) {
    const finalists = results.slice(0, 4);
    const stationary = results.find(r => r.plan.kind === 'constant' && r.plan.move === 0 && r.plan.turn === 0);
    if (stationary && !finalists.includes(stationary)) finalists.push(stationary);
    for (const candidate of finalists) {
      if (candidate.tier > best.tier) continue;
      candidate.plannedFire = shouldFire(s, models, candidate);
      if (candidate.plannedFire) candidate.score += s.self.laserShots > 0 ? 32 : s.self.scatterShots > 0 ? 4 : 2.5;
      if (candidate.score > best.score || (candidate === best && candidate.plannedFire)) best = candidate;
    }
  }
  return best;
}

function poseAt(frames, time) {
  if (time <= 0) return frames[0];
  for (let i = 1; i < frames.length; i++) if (frames[i].time >= time) {
    const a = frames[i - 1], b = frames[i], f = (time - a.time) / (b.time - a.time);
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, a: a.a + wrap(b.a - a.a) * f };
  }
  return frames[frames.length - 1];
}

function ownShotSafe(segments, motion, s) {
  const ph = s.physics, speed = ph.bulletSpeed, frames = motion.frames;
  const end = min(1.1, frames[frames.length - 1].time - s.dt);
  for (const seg of segments) {
    let lo = seg.start / speed, hi = min(end, (seg.start + seg.len) / speed);
    if (seg.bounce === 0) lo = max(lo, ph.selfHitGrace);
    if (lo > hi) continue;
    const steps = max(1, ceil((hi - lo) / 0.045));
    for (let k = 0; k < steps; k++) {
      const a = lo + (hi - lo) * k / steps, b = lo + (hi - lo) * (k + 1) / steps;
      const p0 = poseAt(frames, a + s.dt), p1 = poseAt(frames, b + s.dt);
      const bx0 = seg.x + seg.dx * (a * speed - seg.start), by0 = seg.y + seg.dy * (a * speed - seg.start);
      const bx1 = seg.x + seg.dx * (b * speed - seg.start), by1 = seg.y + seg.dy * (b * speed - seg.start);
      if (approach(p0.x, p0.y, p1.x, p1.y, bx0, by0, bx1, by1).d < ph.tankRadius + ph.bulletRadius + 2) return false;
    }
  }
  return true;
}

function shouldFire(s, models, motion) {
  const me = s.self, ph = s.physics, p = motion.frames[1];
  if (me.cooldown > s.dt + 1e-8 || !models.length) return false;
  let weapon = weaponFor(me);
  // Do not accidentally spend a just-collected laser using a bullet lead solution.
  for (const power of s.powerups) if (power.type !== 'shield' &&
    hypot(power.x - p.x, power.y - p.y) <= ph.tankRadius + ph.powerupRadius + 2) {
    const after = power.type === 'laser' ? 'laser' : power.type === 'scatter' ? 'scatter' : 'bullet';
    if (after !== weapon) return false;
  }
  if (weapon === 'bullet' && me.bulletsActive >= ph.maxBullets) return false;
  if (weapon === 'laser') {
    const shot = laserAssessment(p, p.a, s, models, s.dt, true);
    return !shot.selfHit && shot.quality >= 0.55;
  }
  const offsets = weapon === 'scatter' ? [-ph.scatter.spreadAngle, 0, ph.scatter.spreadAngle] : [0];
  let best = 0, bestTime = Infinity, sum = 0;
  for (const offset of offsets) {
    const shot = ballisticAssessment(p, p.a + offset, s, models.slice(0, 6), s.dt, 370);
    if (!ownShotSafe(shot.segments, motion, s)) return false;
    if (shot.quality > best) { best = shot.quality; bestTime = shot.time; }
    sum += shot.quality;
  }
  if (weapon === 'scatter') return best >= 0.40 || sum >= 0.75;
  let threshold = me.bulletsActive >= ph.maxBullets - 1 ? 0.78 : me.bulletsActive >= 3 ? 0.66 : 0.48;
  if (bestTime < 0.20) threshold -= 0.12;
  if (me.bulletsActive <= 1 && s.tick - mem.lastShot > 210 && bestTime < 1.4) threshold -= 0.10;
  return best >= threshold;
}

function shouldMine(s, models, motion) {
  const ph = s.physics, me = s.self;
  if (me.mineCharges <= 0 || me.deployCooldown > s.dt || !models.length) return false;
  if (motion.frames[motion.frames.length - 1].time < ph.mine.armDelay + 0.10) return false;
  const p = motion.frames[1], mine = { x: p.x - cos(p.a) * 29, y: p.y - sin(p.a) * 29 };
  // Conservative placement: never depend on undocumented wall-push details.
  if (!clearSegment(p.x, p.y, mine.x, mine.y, ph.mine.discRadius)) return false;
  for (const frame of motion.frames) if (frame.time > ph.mine.armDelay - 0.10 &&
    hypot(frame.x - mine.x, frame.y - mine.y) < ph.mine.blastRadius + 12) return false;
  const nearest = models[0];
  return nearest.dist < 220 && hypot(nearest.e.x - mine.x, nearest.e.y - mine.y) < nearest.dist + 5;
}

function update(s) {
  if (!mem || mem.id !== s.self.id || s.tick <= mem.lastTick) reset(s);
  if (!geo || geo.width !== s.map.width || geo.height !== s.map.height || geo.count !== s.map.walls.length || s.tick === 0)
    geo = buildGeometry(s.map);
  geo.cells = s.map.cells;
  if (mem.lastPos) {
    const actual = hypot(s.self.x - mem.lastPos.x, s.self.y - mem.lastPos.y);
    const expected = abs(mem.previous.move) * s.physics.moveSpeed * s.dt;
    mem.stuck = expected > 0.8 && actual < expected * 0.25 ? mem.stuck + 1 : max(0, mem.stuck - 2);
    if (mem.stuck >= 10) mem.escapeUntil = s.tick + 20;
  }
  if (!mem.anchor) mem.anchor = { x: s.self.x, y: s.self.y };
  if (hypot(s.self.x - mem.anchor.x, s.self.y - mem.anchor.y) > 55) {
    mem.anchor = { x: s.self.x, y: s.self.y }; mem.progressTick = s.tick;
  } else if (s.tick - mem.progressTick > 210) { mem.flank = -mem.flank; mem.progressTick = s.tick; }
  const models = prepareEnemies(s);
  const goal = chooseGoal(s, models);
  const weapon = weaponFor(s.self);
  let aim;
  const capped = weapon === 'bullet' && s.self.bulletsActive >= s.physics.maxBullets;
  const recalc = weapon === 'laser' || !mem.aim || mem.aim.weapon !== weapon ||
    s.tick - mem.aimTick >= (capped ? 15 : 4);
  if (recalc) aim = chooseAim(s, models, goal);
  else aim = { ...mem.aim, target: models.find(m => m.e.id === mem.aim.targetId) || models[0] };
  const threats = prepareThreats(s, models);
  const motion = chooseMotion(s, models, goal, aim, threats);
  const action = { move: clamp(motion.action.move, -1, 1), turn: clamp(motion.action.turn, -1, 1),
    fire: motion.plannedFire !== undefined ? motion.plannedFire : shouldFire(s, models, motion),
    special: shouldMine(s, models, motion) };
  if (action.fire) mem.lastShot = s.tick;
  mem.previous = { move: action.move, turn: action.turn };
  mem.lastPos = { x: s.self.x, y: s.self.y }; mem.lastTick = s.tick; mem.calls++;
  return action;
}

module.exports = { update };
