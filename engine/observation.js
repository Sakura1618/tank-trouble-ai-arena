// 公开观测：Bot 能看到的全部信息。引擎对象、随机状态和赛程不进入这里。
// 拆成静态和动态两部分：地图、物理、规则在局内基本不变，只在开局和地图变化时发送，
// 每 Tick 只传动态部分，多 AI 混战时开销不随地图大小增长。

const DIAGNOSTICS_API = 2;

export function publicPhysics(ruleset) {
  const { tank, bullet, powerup, wall, controls } = ruleset;
  return {
    tankRadius: tank.radius, moveSpeed: tank.moveSpeed, turnSpeed: tank.turnSpeed,
    bulletRadius: bullet.radius, bulletSpeed: bullet.speed, bulletLifetime: bullet.lifetime,
    fireCooldown: bullet.cooldown, maxBullets: bullet.maxAlive, selfHitGrace: bullet.selfHitGrace,
    wallHp: wall.hp, muzzleOffset: tank.muzzleOffset, powerupRadius: powerup.radius,
    reverseDwellTicks: controls.reverseDwellTicks, turnDwellTicks: controls.turnDwellTicks,
    scatter: { ...powerup.scatter },
    laser: { ...powerup.laser },
    mine: { ...powerup.mine },
    shieldDuration: powerup.shield.duration,
  };
}

export function publicMap(maze) {
  return {
    cols: maze.cols, rows: maze.rows, cellSize: maze.cellSize, style: maze.style,
    width: maze.cols * maze.cellSize, height: maze.rows * maze.cellSize,
    cells: maze.cells.map(row => row.map(c => ({ top: c.top, right: c.right, bottom: c.bottom, left: c.left }))),
    walls: maze.walls.map(w => ({ x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2, border: !!w.border, hp: w.border ? null : w.hp })),
  };
}

export function publicRules(world) {
  const { ruleset } = world;
  return {
    ruleset: ruleset.id,
    timeout: world.maxTicks / ruleset.tickRate,
    wallBreak: ruleset.features.wallBreak,
    powerups: ruleset.features.powerups.length > 0,
    controls: ruleset.controls.mode,
  };
}

export function observeStatic(world) {
  return { map: publicMap(world.maze), rules: publicRules(world), physics: publicPhysics(world.ruleset), mapRevision: world.mapRevision };
}

function tankView(world, p, withDiagnostics) {
  const { tank, control, motion } = p;
  let bulletsActive = 0;
  for (const b of world.bullets) if (b.owner === tank) bulletsActive++;
  const view = {
    id: p.id, name: p.name, color: p.color, alive: tank.alive,
    x: tank.x, y: tank.y, angle: tank.angle,
    vx: p.vx, vy: p.vy,
    cooldown: Math.max(0, tank.cooldown), deployCooldown: Math.max(0, tank.deployCooldown),
    bulletsActive,
    scatterShots: tank.scatterShots, laserShots: tank.laserShots, mineCharges: tank.mineCharges,
    mineHoldTime: Math.max(0, tank.mineHoldTimer), shield: tank.shield, shieldTime: Math.max(0, tank.shieldTimer),
  };
  // 诊断只给本人：对手的请求动作属于内部决策，不公开。
  if (withDiagnostics) {
    view.requestedMove = control.requestedMove;
    view.requestedTurn = control.requestedTurn;
    view.appliedMove = control.appliedMove;
    view.appliedTurn = control.appliedTurn;
    view.actionFlipCount = control.actionFlipCount;
    view.actualDelta = { x: motion.dx, y: motion.dy };
    view.wallCorrection = { x: motion.wallX, y: motion.wallY };
    view.tankCorrection = { x: motion.tankX, y: motion.tankY };
  }
  return view;
}

export function observeDynamic(world, id, apiVersion = 1) {
  const dt = world.dt;
  return {
    apiVersion, tick: world.tick, time: world.tick * dt, dt,
    self: tankView(world, world.byId.get(id), apiVersion >= DIAGNOSTICS_API),
    enemies: world.actors.filter(p => p.id !== id).map(p => tankView(world, p, false)),
    bullets: world.bullets.map(b => ({ id: b.arenaId, ownerId: b.owner.ownerId, x: b.x, y: b.y,
      vx: b.vx, vy: b.vy, age: b.age, bounces: b.bounces, kind: b.kind })),
    powerups: world.powerups.map(p => ({ x: p.x, y: p.y, type: p.type })),
    mines: world.mines.filter(m => m.visibility() > 0).map(m => ({ id: m.arenaId, ownerId: m.owner.ownerId,
      x: m.x, y: m.y, age: m.age, armed: m.armed, visibility: m.visibility() })),
    mapRevision: world.mapRevision,
  };
}

export function observe(world, id, apiVersion = 1) {
  return { ...observeDynamic(world, id, apiVersion), ...observeStatic(world) };
}
