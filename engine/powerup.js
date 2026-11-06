// 道具实体与刷新器。随机来自传入的 Rng。纯模拟，无渲染。

import { dlen } from './detmath.js';
import { resolveCircleWalls } from './geometry.js';

export class Powerup {
  constructor(x, y, type) {
    this.x = x;
    this.y = y;
    this.type = type;
    this.age = 0;
    this.taken = false;
  }

  update(dt) { this.age += dt; }
}

export class PowerupSpawner {
  constructor(types, ruleset, rng) {
    this.types = types;
    this.rules = ruleset.powerup;
    this.tankRadius = ruleset.tank.radius;
    this.rng = rng;
    this.timer = types.length ? this.nextInterval() : 0;
  }

  nextInterval() {
    const [min, max] = this.rules.spawnInterval;
    return this.rng.range(min, max);
  }

  update(dt, maze, powerups, tanks, mines) {
    if (this.types.length === 0 || powerups.length >= this.rules.maxOnField) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = this.nextInterval();
    const spot = this.pickSpot(maze, powerups, tanks, mines);
    if (spot) powerups.push(new Powerup(spot.x, spot.y, this.rng.pick(this.types)));
  }

  // 随机格中心，避开坦克、已有道具和地雷触发圈（隐形雷加道具等于讲不清的死）。
  pickSpot(maze, powerups, tanks, mines) {
    const { radius, mine } = this.rules;
    const size = maze.cellSize;
    for (let tries = 0; tries < 12; tries++) {
      const c = this.rng.int(maze.cols);
      const r = this.rng.int(maze.rows);
      const { x, y } = resolveCircleWalls((c + 0.5) * size, (r + 0.5) * size, radius, maze.walls);
      const tooClose =
        tanks.some(t => t.alive && dlen(t.x - x, t.y - y) < radius + this.tankRadius) ||
        mines.some(m => !m.exploded && dlen(m.x - x, m.y - y) < mine.triggerRadius + radius) ||
        powerups.some(p => dlen(p.x - x, p.y - y) < radius * 2.2);
      if (!tooClose) return { x, y };
    }
    return null;
  }
}
