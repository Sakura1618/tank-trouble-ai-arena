// 帧快照：渲染需要的全部信息，纯数据。实时观战和录像回放都走这一层，
// 渲染器因此不接触引擎对象，也不可能反过来影响比赛。

import { castLaserPath } from '../../engine/laser.js';

export function snapshotWorld(world) {
  const { ruleset, maze } = world;
  return {
    tick: world.tick,
    cols: maze.cols,
    rows: maze.rows,
    cellSize: maze.cellSize,
    // 墙耐久会被原地修改；回放预存的帧必须持有当时的值。
    walls: world.wallBreak ? maze.walls.map(w => ({ ...w })) : maze.walls,
    wallHp: ruleset.wall.hp,
    bulletRadius: ruleset.bullet.radius,
    powerupRadius: ruleset.powerup.radius,
    tanks: world.actors.map(p => {
      const { tank } = p;
      let laserPath = null;
      if (tank.alive && tank.laserShots > 0) {
        const muzzle = tank.muzzlePoint(maze.walls);
        laserPath = castLaserPath(muzzle.x, muzzle.y, muzzle.angle, maze.walls, ruleset.powerup.laser);
      }
      return { id: p.id, name: p.name, color: p.color, alive: tank.alive, x: tank.x, y: tank.y, angle: tank.angle,
        shield: tank.shield, shieldTimer: tank.shieldTimer, laserPath };
    }),
    bullets: world.bullets.map(b => ({ id: b.arenaId, x: b.x, y: b.y })),
    powerups: world.powerups.map(p => ({ x: p.x, y: p.y, type: p.type, age: p.age })),
    mines: world.mines.map(m => ({ x: m.x, y: m.y, age: m.age, armed: m.armed, visibility: m.visibility(), discRadius: m.rules.discRadius })),
    events: world.events,
  };
}
