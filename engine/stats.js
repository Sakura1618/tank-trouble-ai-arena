// 单局战术与运动指标。只读世界状态，不影响结算。
// 运动指标是抽动诊断的核心：它们区分“脚本在请求反向”和“物理把车推回来”。

import { dcos, dsin } from './detmath.js';

const SHORT_RUN_TICKS = 6;
const CORRECTION_EPSILON = 1e-6;

function emptyStats() {
  return {
    ticksAlive: 0, shots: 0, kills: 0, directKills: 0, ricochetKills: 0, suicides: 0, deaths: 0,
    firstKillTick: null, deathTick: null, forfeits: 0,
    movingTicks: 0, wallTicks: 0, tankContactTicks: 0, stuckTicks: 0,
    requestedFlips: 0, actualReversals: 0, gatedTicks: 0, shortRuns: 0, runs: 0, turnFlips: 0,
    pathLength: 0,
  };
}

export class MatchStats {
  constructor(world) {
    this.world = world;
    this.players = Object.fromEntries(world.actors.map(p => [p.id, emptyStats()]));
    this.track = Object.fromEntries(world.actors.map(p => [p.id, { requested: 0, turn: 0, actual: 0, runStart: 0 }]));
    this.moveStep = world.ruleset.tank.moveSpeed * world.dt;
  }

  // 每次 world.step 之后调用一次。
  afterStep() {
    const { world } = this;
    for (const event of world.events) {
      if (event.type === 'fire') this.players[event.actorId].shots++;
      if (event.type === 'death') this.onDeath(event);
    }
    for (const p of world.actors) {
      const s = this.players[p.id];
      if (s.deathTick !== null || p.forfeit) continue;
      s.ticksAlive++;
      this.onMotion(p, s, this.track[p.id]);
    }
  }

  onDeath(event) {
    const { tick } = this.world;
    const victim = this.players[event.victimId];
    victim.deaths++;
    victim.deathTick = tick;
    if (event.classification === 'suicide') { victim.suicides++; return; }
    const killer = this.players[event.ownerId];
    if (!killer) return;
    killer.kills++;
    if (event.classification === 'ricochet_kill') killer.ricochetKills++;
    else killer.directKills++;
    if (killer.firstKillTick === null) killer.firstKillTick = tick;
  }

  onMotion(p, s, t) {
    const { control, motion, tank } = p;
    const { tick } = this.world;
    const distance = Math.sqrt(motion.dx * motion.dx + motion.dy * motion.dy);
    s.pathLength += distance;
    if (control.requestedMove !== 0) s.movingTicks++;
    if (control.requestedMove !== control.appliedMove) s.gatedTicks++;
    if (Math.abs(motion.wallX) + Math.abs(motion.wallY) > CORRECTION_EPSILON) s.wallTicks++;
    if (Math.abs(motion.tankX) + Math.abs(motion.tankY) > CORRECTION_EPSILON) s.tankContactTicks++;
    if (control.appliedMove !== 0 && distance < this.moveStep * 0.1) s.stuckTicks++;

    const requested = control.requestedMove;
    if (requested !== 0) {
      if (t.requested !== 0 && requested !== t.requested) {
        s.requestedFlips++;
        s.runs++;
        if (tick - t.runStart <= SHORT_RUN_TICKS) s.shortRuns++;
        t.runStart = tick;
      }
      t.requested = requested;
    }
    if (control.requestedTurn !== 0) {
      if (t.turn !== 0 && control.requestedTurn !== t.turn) s.turnFlips++;
      t.turn = control.requestedTurn;
    }
    // 真实倒退：沿车头方向的实际位移换号，不管是脚本造成的还是碰撞造成的。
    const along = motion.dx * dcos(tank.angle) + motion.dy * dsin(tank.angle);
    const actual = Math.abs(along) < this.moveStep * 0.1 ? 0 : Math.sign(along);
    if (actual !== 0) {
      if (t.actual !== 0 && actual !== t.actual) s.actualReversals++;
      t.actual = actual;
    }
  }

  finish() {
    const { world } = this;
    for (const p of world.actors) if (p.forfeit) this.players[p.id].forfeits = 1;
    return this.players;
  }
}
