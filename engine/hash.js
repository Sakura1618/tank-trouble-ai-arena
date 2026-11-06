// 世界状态哈希：把所有影响后续结算的数值按 IEEE-754 位模式吃进去。
// 录像用它做检查点，任何一位不同都会在第一个检查点暴露。

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

class Hasher {
  constructor() { this.a = 0x811c9dc5; this.b = 0x9747b28c; }
  word(value) {
    this.a = Math.imul(this.a ^ value, 0x01000193);
    this.b = Math.imul(this.b ^ (value >>> 7) ^ this.a, 0x85ebca6b);
  }
  float(value) { f64[0] = value; this.word(u32[0]); this.word(u32[1]); }
  bool(value) { this.word(value ? 1 : 0); }
  hex() {
    return [this.a >>> 0, this.b >>> 0].map(part => part.toString(16).padStart(8, '0')).join('');
  }
}

export function hashWorld(world) {
  const h = new Hasher();
  h.word(world.tick);
  for (const p of world.actors) {
    const { tank } = p;
    h.bool(tank.alive);
    h.float(tank.x); h.float(tank.y); h.float(tank.angle);
    h.float(tank.cooldown); h.float(tank.deployCooldown);
    h.word(tank.scatterShots); h.word(tank.laserShots); h.word(tank.mineCharges);
    h.bool(tank.shield); h.float(tank.shieldTimer);
    h.word(p.kills);
  }
  h.word(world.bullets.length);
  for (const b of world.bullets) {
    h.word(b.arenaId);
    h.float(b.x); h.float(b.y); h.float(b.vx); h.float(b.vy); h.float(b.age); h.word(b.bounces);
  }
  h.word(world.mines.length);
  for (const m of world.mines) { h.word(m.arenaId); h.float(m.x); h.float(m.y); h.float(m.age); }
  h.word(world.powerups.length);
  for (const p of world.powerups) { h.float(p.x); h.float(p.y); }
  h.word(world.maze.walls.length);
  return h.hex();
}

// 地图指纹：只看墙，用于确认“同图不同出生点”和基准地图没有漂移。
export function hashMaze(maze) {
  const h = new Hasher();
  h.word(maze.cols); h.word(maze.rows);
  for (const w of maze.walls) { h.float(w.x1); h.float(w.y1); h.float(w.x2); h.float(w.y2); }
  return h.hex();
}
