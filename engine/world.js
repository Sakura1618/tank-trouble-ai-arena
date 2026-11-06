// 比赛世界：固定 60Hz 的逐 Tick 结算。纯模拟，不依赖浏览器、时钟或全局随机数。
// 相同规则集 + 相同种子 + 相同动作序列 = 逐位相同的比赛。

import { generateMaze, destroyWallsInRadius, destroyWallSegments } from './maze.js';
import { Tank } from './tank.js';
import { PowerupSpawner } from './powerup.js';
import { castLaserPath } from './laser.js';
import { circleVsCircle, closestPointOnSegment, resolveCircleWalls, separateCircles } from './geometry.js';
import { IDLE_ACTION, TankControl, normalizeAction } from './controls.js';
import { Rng, deriveSeeds } from './rng.js';
import { dlen, TAU } from './detmath.js';

const TANK_SEPARATION_ITERATIONS = 4;

export class ArenaWorld {
  // entrants: [{ id, name, color }]
  // options: { ruleset, seed, seeds?, mapStyle?, maxSeconds?, seatRotation?, recording? }
  constructor(entrants, options) {
    if (!options?.ruleset) throw new Error('ArenaWorld 需要 ruleset');
    if (options.seed === undefined) throw new Error('ArenaWorld 需要 seed');
    const ruleset = options.ruleset;
    this.ruleset = ruleset;
    this.dt = 1 / ruleset.tickRate;
    this.seeds = deriveSeeds(options.seed, options.seeds);
    this.maxTicks = Math.round((options.maxSeconds ?? ruleset.maxSeconds) * ruleset.tickRate);
    this.wallBreak = ruleset.features.wallBreak;

    const mapRng = new Rng(this.seeds.mapSeed);
    const map = ruleset.map;
    // 长宽随人数的平方根增长，面积随人数增长；双人局就是基准尺寸。
    const scale = map.scaleWithPlayers ? Math.sqrt(entrants.length / 2) : 1;
    const cols = Math.ceil(map.cols * scale);
    const rows = Math.ceil(map.rows * scale);
    const style = options.mapStyle && map.styles.includes(options.mapStyle)
      ? options.mapStyle : mapRng.pick(map.styles);
    this.maze = generateMaze(cols, rows, style, mapRng, { ...map, wallHp: ruleset.wall.hp });
    this.mapRevision = 0;

    // 隔一格一个候选出生位，出生点间距至少两格。
    const spawnRng = new Rng(this.seeds.spawnSeed);
    const size = this.maze.cellSize;
    const candidates = [];
    const startColumn = spawnRng.int(2);
    const startRow = spawnRng.int(2);
    for (let r = startRow; r < rows; r += 2) {
      for (let c = startColumn; c < cols; c += 2) candidates.push({ x: (c + 0.5) * size, y: (r + 0.5) * size });
    }
    const spots = spawnRng.shuffled(candidates).slice(0, entrants.length);
    const angles = spots.map(() => spawnRng.next() * TAU);

    // 席位只由 orderSeed 决定，与调用方传入的顺序无关；
    // seatRotation 让同一张图、同一组出生点换边再打一局，抵消出生点优势。
    const orderRng = new Rng(this.seeds.orderSeed);
    const sorted = [...entrants].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const seats = orderRng.shuffled(sorted);
    const rotation = options.seatRotation ?? 0;
    this.actors = seats.map((p, i) => {
      const spot = (i + rotation) % seats.length;
      const tank = new Tank(spots[spot].x, spots[spot].y, angles[spot], p.color, ruleset);
      tank.ownerId = p.id;
      return {
        id: p.id, name: p.name, color: p.color, tank,
        control: new TankControl(ruleset.controls, ruleset.tickRate),
        vx: 0, vy: 0, kills: 0, forfeit: null,
        motion: { dx: 0, dy: 0, wallX: 0, wallY: 0, tankX: 0, tankY: 0 },
      };
    });
    this.byId = new Map(this.actors.map(p => [p.id, p]));

    this.tick = 0;
    this.bullets = [];
    this.powerups = [];
    this.mines = [];
    this.spawner = new PowerupSpawner([...ruleset.features.powerups], ruleset, new Rng(this.seeds.powerupSeed));
    this.events = [];
    this.result = null;
    this.nextEntityId = 1;
    this.nextPowerupId = 1;
    this.nextShotId = 1;
    this.recordingEnabled = !!options.recording;
    this.recordEvents = [];
    this.eventTick = null;
    this.powerupIds = new WeakMap();
  }

  get alive() { return this.actors.filter(p => p.tank.alive); }

  ownerId(tank) { return tank?.ownerId ?? null; }

  powerupId(powerup) {
    if (!this.powerupIds.has(powerup)) this.powerupIds.set(powerup, `p${this.nextPowerupId++}`);
    return this.powerupIds.get(powerup);
  }

  record(event) {
    if (!this.recordingEnabled) return;
    const tick = this.eventTick ?? this.tick;
    this.recordEvents.push({ ...event, tick, time: tick * this.dt });
  }

  emit(event) { this.events.push(event); this.record(event); }

  // 规则判负绕过护盾，不给任何人加击杀。
  forfeit(id, fault) {
    const actor = this.byId.get(id);
    if (!actor.tank.alive) return;
    actor.tank.alive = false;
    actor.vx = 0;
    actor.vy = 0;
    actor.forfeit = fault;
    this.record({ type: 'forfeit', actorId: id, victimId: id, reason: fault.code, message: fault.message,
      elapsedMs: fault.elapsedMs, timeout: !!fault.timeout, outcome: 'loss', x: actor.tank.x, y: actor.tank.y });
  }

  kill(tank, owner, cause, impact = {}) {
    if (!tank.alive) return;
    const victim = this.byId.get(tank.ownerId);
    const killer = owner ? this.byId.get(owner.ownerId) : null;
    const detail = { ownerId: killer?.id ?? null, victimId: victim.id, cause, weapon: cause,
      selfHit: killer === victim, ricochet: (impact.bounces || 0) > 0, ...impact };
    this.record({ type: 'hit', x: tank.x, y: tank.y, ...detail, outcome: tank.shield ? 'shield' : 'death' });
    if (tank.shield) {
      tank.shield = false;
      tank.shieldTimer = 0;
      this.emit({ type: 'shield', x: tank.x, y: tank.y, color: tank.color, ...detail });
      this.record({ type: 'powerup_used', actorId: victim.id, powerup: 'shield', reason: 'absorbed_hit' });
      return;
    }
    tank.alive = false;
    if (killer && killer !== victim) killer.kills++;
    this.emit({ type: 'death', x: tank.x, y: tank.y, color: tank.color, victim: victim.id, killer: killer?.id, ...detail,
      classification: killer === victim ? 'suicide' : !killer ? 'environment' : detail.ricochet ? 'ricochet_kill' : 'direct_kill' });
  }

  fireLaser(origin, shooter, shotId) {
    const rules = this.ruleset.powerup.laser;
    const points = castLaserPath(origin.x, origin.y, origin.angle, this.maze.walls, rules);
    const radius = this.ruleset.tank.radius;
    let hitId = null;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (i > 0) this.record({ type: 'bounce', weapon: 'laser', ownerId: shooter.id, shotId, x: a.x, y: a.y, bounces: i });
      let hit = null;
      for (const p of this.alive) {
        if (i === 0 && p === shooter) continue;
        const cp = closestPointOnSegment(p.tank.x, p.tank.y, a.x, a.y, b.x, b.y);
        if (dlen(p.tank.x - cp.x, p.tank.y - cp.y) > radius) continue;
        const distance = dlen(cp.x - a.x, cp.y - a.y);
        if (!hit || distance < hit.distance) hit = { p, cp, distance };
      }
      if (hit) {
        hitId = hit.p.id;
        this.kill(hit.p.tank, shooter.tank, 'laser', { shotId, bounces: i, impactX: hit.cp.x, impactY: hit.cp.y });
        points.splice(i + 1, points.length, hit.cp);
        break;
      }
    }
    this.emit({ type: 'laser', points, ownerId: shooter.id, shotId, victimId: hitId });
  }

  moveTanks(actions) {
    const walls = this.maze.walls;
    const before = this.actors.map(p => ({ x: p.tank.x, y: p.tank.y }));
    for (const p of this.actors) {
      const hadShield = p.tank.shield;
      const heldMines = p.tank.mineCharges;
      const applied = p.control.apply(actions[p.id], this.tick);
      const { wallX, wallY } = p.tank.update(this.dt, walls, applied);
      p.motion.wallX = wallX;
      p.motion.wallY = wallY;
      p.motion.tankX = 0;
      p.motion.tankY = 0;
      if (hadShield && !p.tank.shield) this.record({ type: 'powerup_expired', actorId: p.id, powerup: 'shield' });
      if (heldMines > 0 && !p.tank.mineCharges) this.record({ type: 'powerup_expired', actorId: p.id, powerup: 'mine', charges: heldMines });
    }

    // 多轮松弛：一辆车被顶到墙上时，下一轮把剩余重叠推给另一辆，不留下穿模或弹跳。
    const alive = this.alive;
    const diameter = this.ruleset.tank.radius * 2;
    const radius = this.ruleset.tank.radius;
    for (let iter = 0; iter < TANK_SEPARATION_ITERATIONS; iter++) {
      let moved = false;
      for (let i = 0; i < alive.length; i++) {
        for (let j = i + 1; j < alive.length; j++) {
          const a = alive[i];
          const b = alive[j];
          const sep = separateCircles(a.tank.x, a.tank.y, b.tank.x, b.tank.y, diameter);
          if (!sep) continue;
          moved = true;
          this.settleTank(a, sep.ax, sep.ay, radius, walls);
          this.settleTank(b, sep.bx, sep.by, radius, walls);
        }
      }
      if (!moved) break;
    }

    this.actors.forEach((p, i) => {
      p.motion.dx = p.tank.x - before[i].x;
      p.motion.dy = p.tank.y - before[i].y;
      p.vx = p.motion.dx / this.dt;
      p.vy = p.motion.dy / this.dt;
    });
  }

  settleTank(actor, x, y, radius, walls) {
    const fixed = resolveCircleWalls(x, y, radius, walls);
    actor.motion.tankX += x - actor.tank.x;
    actor.motion.tankY += y - actor.tank.y;
    actor.motion.wallX += fixed.x - x;
    actor.motion.wallY += fixed.y - y;
    actor.tank.x = fixed.x;
    actor.tank.y = fixed.y;
  }

  updatePowerups() {
    const tanks = this.alive.map(p => p.tank);
    const before = this.powerups.length;
    this.spawner.update(this.dt, this.maze, this.powerups, tanks, this.mines);
    for (const pw of this.powerups.slice(before)) {
      this.record({ type: 'powerup_spawn', powerupId: this.powerupId(pw), powerup: pw.type, x: pw.x, y: pw.y });
    }
    const radius = this.ruleset.tank.radius;
    const pickup = this.ruleset.powerup.radius;
    for (const p of this.alive) {
      for (const pw of this.powerups) {
        if (!pw.taken && circleVsCircle(p.tank.x, p.tank.y, radius, pw.x, pw.y, pickup)) {
          p.tank.applyPowerup(pw.type);
          pw.taken = true;
          this.emit({ type: 'pickup', x: pw.x, y: pw.y, powerup: pw.type, actorId: p.id, powerupId: this.powerupId(pw) });
          break;
        }
      }
    }
    this.powerups = this.powerups.filter(p => !p.taken);
  }

  updateMines() {
    const rules = this.ruleset.powerup.mine;
    for (const m of this.mines) {
      const wasArmed = m.armed;
      m.update(this.dt);
      if (!wasArmed && m.armed) this.record({ type: 'mine_armed', mineId: m.arenaId, ownerId: this.ownerId(m.owner), x: m.x, y: m.y });
      if (!m.armed || !this.alive.some(p => dlen(p.tank.x - m.x, p.tank.y - m.y) < rules.triggerRadius)) continue;
      m.exploded = true;
      if (this.wallBreak) {
        const destroyed = destroyWallsInRadius(this.maze, m.x, m.y, rules.wallBlastRadius);
        if (destroyed.length) {
          this.mapRevision++;
          this.record({ type: 'wall_destroy', cause: 'mine', mineId: m.arenaId, ownerId: this.ownerId(m.owner),
            walls: destroyed.map(w => ({ x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 })) });
        }
      }
      for (const p of this.alive) {
        if (dlen(p.tank.x - m.x, p.tank.y - m.y) < rules.blastRadius) this.kill(p.tank, m.owner, 'mine', { mineId: m.arenaId, bounces: 0 });
      }
      this.emit({ type: 'mine', x: m.x, y: m.y, mineId: m.arenaId, ownerId: this.ownerId(m.owner) });
    }
    this.mines = this.mines.filter(m => !m.exploded);
  }

  fireWeapons(actions) {
    for (const p of this.actors) {
      const action = actions[p.id];
      const weapon = p.tank.scatterShots > 0 ? 'scatter' : p.tank.laserShots > 0 ? 'laser' : 'bullet';
      const shot = p.tank.tryFire(this.bullets, action.fire, this.maze.walls);
      const fired = shot.bullets.length > 0 || !!shot.laser;
      const shotId = fired ? this.nextShotId++ : null;
      for (const b of shot.bullets) {
        b.arenaId = this.nextEntityId++;
        this.bullets.push(b);
        this.record({ type: 'projectile_spawn', projectileId: b.arenaId, shotId, ownerId: p.id, weapon: b.kind, x: b.x, y: b.y, vx: b.vx, vy: b.vy });
      }
      if (fired) {
        this.emit({ type: 'fire', ...p.tank.muzzlePoint(this.maze.walls), actorId: p.id, ownerId: p.id, shotId, weapon,
          projectileIds: shot.bullets.map(b => b.arenaId) });
        if (weapon !== 'bullet') this.record({ type: 'powerup_used', actorId: p.id, powerup: weapon, shotId });
      }
      if (shot.laser) this.fireLaser(shot.laser, p, shotId);
      const mine = p.tank.tryDeploy(action.special, this.maze.walls);
      if (mine) {
        mine.arenaId = this.nextEntityId++;
        this.mines.push(mine);
        this.record({ type: 'mine_deploy', mineId: mine.arenaId, actorId: p.id, ownerId: p.id, x: mine.x, y: mine.y });
        this.record({ type: 'powerup_used', actorId: p.id, powerup: 'mine', mineId: mine.arenaId });
      }
    }
  }

  updateBullets() {
    const onBounce = this.recordingEnabled ? (b, w, previousVx, previousVy) => {
      this.record({ type: 'bounce', weapon: b.kind, projectileId: b.arenaId, ownerId: this.ownerId(b.owner),
        x: b.x, y: b.y, vx: b.vx, vy: b.vy, previousVx, previousVy, bounces: b.bounces,
        wall: { x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2, border: !!w.border, hp: w.border ? null : w.hp } });
    } : null;
    for (const b of this.bullets) {
      const bounces = b.bounces;
      b.update(this.dt, this.maze.walls, this.wallBreak, onBounce);
      if (this.wallBreak && b.bounces !== bounces) this.mapRevision++;
      if (b.dead) this.record({ type: 'projectile_end', projectileId: b.arenaId, ownerId: this.ownerId(b.owner), x: b.x, y: b.y, reason: 'lifetime', bounces: b.bounces });
    }
    if (this.wallBreak) {
      const crumbled = this.maze.walls.filter(w => !w.border && w.hp <= 0);
      if (crumbled.length) {
        destroyWallSegments(this.maze, crumbled);
        this.mapRevision++;
        this.record({ type: 'wall_destroy', cause: 'projectile', walls: crumbled.map(w => ({ x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 })) });
      }
    }
    const tankRadius = this.ruleset.tank.radius;
    const bulletRadius = this.ruleset.bullet.radius;
    for (const b of this.bullets) {
      if (b.dead) continue;
      for (const p of this.actors) {
        if (p.tank.alive && b.canHit(p.tank) && circleVsCircle(b.x, b.y, bulletRadius, p.tank.x, p.tank.y, tankRadius)) {
          b.dead = true;
          this.kill(p.tank, b.owner, b.kind, { projectileId: b.arenaId, bounces: b.bounces, impactX: b.x, impactY: b.y });
          break;
        }
      }
    }
    this.bullets = this.bullets.filter(b => !b.dead);
  }

  // actions: { [actorId]: 任意合法动作 }，缺省视为空动作。全部决策先收集，再统一结算。
  step(rawActions) {
    if (this.result) return this.result;
    this.events = [];
    this.eventTick = this.tick + 1;
    const actions = {};
    for (const p of this.actors) actions[p.id] = normalizeAction(rawActions[p.id] ?? IDLE_ACTION);

    this.moveTanks(actions);
    this.updatePowerups();
    this.updateMines();
    this.fireWeapons(actions);
    this.updateBullets();
    for (const pw of this.powerups) pw.update(this.dt);

    this.tick++;
    this.eventTick = null;
    return this.settle();
  }

  settle() {
    if (this.result) return this.result;
    const living = this.alive;
    const timeout = this.tick >= this.maxTicks;
    if (living.length <= 1 || timeout) {
      this.result = {
        winnerId: living.length === 1 ? living[0].id : null,
        reason: this.actors.every(p => p.forfeit) ? 'all_forfeit' : living.length === 0 ? 'mutual' : living.length === 1 ? 'survivor' : 'timeout',
        ticks: this.tick,
        players: this.actors.map(p => ({ id: p.id, kills: p.kills, alive: p.tank.alive, forfeit: p.forfeit })),
      };
    }
    return this.result;
  }
}
