// 开发者演示选手：寻路、简单提前瞄准、短时轨迹采样躲弹。
// 单文件，完全依据公开观测工作，不读取其他脚本或引擎对象。
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
function wallDistance(x, y, w) {
  const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
  const k = Math.max(0, Math.min(1, ((x - w.x1) * dx + (y - w.y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - w.x1 - k * dx, y - w.y1 - k * dy);
}
function clear(a, b, walls, radius) {
  const n = Math.max(1, Math.ceil(Math.hypot(a.x - b.x, a.y - b.y) / 10));
  for (let i = 0; i <= n; i++) if (walls.some(w => wallDistance(a.x + (b.x - a.x) * i / n, a.y + (b.y - a.y) * i / n, w) < radius)) return false;
  return true;
}
function waypoint(map, self, goal) {
  const size = map.cellSize, cols = map.cols;
  const start = Math.floor(self.y / size) * cols + Math.floor(self.x / size);
  const end = Math.floor(goal.y / size) * cols + Math.floor(goal.x / size);
  const seen = new Map([[start, null]]), queue = [start];
  for (let head = 0; head < queue.length && !seen.has(end); head++) {
    const at = queue[head], r = Math.floor(at / cols), c = at % cols;
    for (const [dc, dr, wall] of [[0, -1, 'top'], [1, 0, 'right'], [0, 1, 'bottom'], [-1, 0, 'left']]) {
      const nc = c + dc, nr = r + dr, next = nr * cols + nc;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= map.rows || map.cells[r][c][wall] || seen.has(next)) continue;
      seen.set(next, at); queue.push(next);
    }
  }
  if (start === end || !seen.has(end)) return goal;
  let next = end;
  while (seen.get(next) !== start) next = seen.get(next);
  return { x: (next % cols + 0.5) * size, y: (Math.floor(next / cols) + 0.5) * size };
}
let dodgeUntil = 0, dodge = { move: 0, turn: 0 };
module.exports = {
  update(s) {
    const me = s.self, walls = s.map.walls, radius = s.physics.tankRadius;
    const foes = s.enemies.filter(e => e.alive).sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y));
    if (!foes.length) return {};
    const foe = foes[0], distance = Math.hypot(foe.x - me.x, foe.y - me.y);
    const lead = Math.min(0.7, distance / s.physics.bulletSpeed) * 0.65;
    const aimAt = { x: foe.x + foe.vx * lead, y: foe.y + foe.vy * lead };
    let goal = clear(me, aimAt, walls, radius + 2) ? aimAt : waypoint(s.map, me, foe);
    if (!clear(me, goal, walls, radius)) goal = { x: (Math.floor(me.x / s.map.cellSize) + 0.5) * s.map.cellSize,
      y: (Math.floor(me.y / s.map.cellSize) + 0.5) * s.map.cellSize };
    const error = wrap(Math.atan2(goal.y - me.y, goal.x - me.x) - me.angle);
    let move = Math.abs(error) < 0.9 ? 1 : 0;
    let turn = Math.max(-1, Math.min(1, error / (s.physics.turnSpeed * s.dt)));
    const threats = s.bullets.filter(b => {
      if (b.ownerId === me.id && b.bounces === 0 && b.age < s.physics.selfHitGrace) return false;
      const dx = b.x - me.x, dy = b.y - me.y;
      const t = Math.max(0, Math.min(0.8, -(dx * b.vx + dy * b.vy) / (b.vx * b.vx + b.vy * b.vy)));
      return Math.hypot(dx + b.vx * t, dy + b.vy * t) < radius + 32 && Math.hypot(dx, dy) < 200;
    });
    if (threats.length && s.time >= dodgeUntil) {
      let best = -Infinity;
      for (const mv of [1, -1, 0]) for (const tr of [-1, 0, 1]) {
        let x = me.x, y = me.y, angle = me.angle, score = 1000;
        for (let i = 1; i <= 10; i++) {
          angle += tr * s.physics.turnSpeed * 0.05;
          x += Math.cos(angle) * mv * s.physics.moveSpeed * 0.05;
          y += Math.sin(angle) * mv * s.physics.moveSpeed * 0.05;
          if (walls.some(w => wallDistance(x, y, w) < radius + 2)) { score -= 500; break; }
          for (const b of threats) score = Math.min(score, Math.hypot(x - b.x - b.vx * i * 0.05, y - b.y - b.vy * i * 0.05));
        }
        score += mv === 1 ? 2 : 0;
        if (score > best) { best = score; dodge = { move: mv, turn: tr }; }
      }
      dodgeUntil = s.time + 0.18;
    }
    if (s.time < dodgeUntil) { move = dodge.move; turn = dodge.turn; }
    const aim = wrap(Math.atan2(aimAt.y - me.y, aimAt.x - me.x) - me.angle);
    return { move, turn,
      fire: Math.abs(aim) < Math.max(0.055, 19 / Math.max(distance, 1)) && me.cooldown === 0 && me.bulletsActive < 4 && clear(me, aimAt, walls, s.physics.bulletRadius + 1),
      special: me.mineCharges > 0 && distance < 150 && s.tick % 60 === 0,
    };
  },
};
