// 坦克：维护位置和朝向，消费控制指令。纯模拟，无渲染。
// 不读输入设备：控制指令由 world 传入，人类和 AI 走同一条路。

import { dcos, dsin, wrapTau } from './detmath.js';
import { resolveCircleWalls, segmentVsSegmentParam } from './geometry.js';
import { Bullet } from './bullet.js';
import { Mine } from './mine.js';

export class Tank {
  constructor(x, y, angle, color, ruleset) {
    this.x = x;
    this.y = y;
    this.angle = wrapTau(angle);
    this.color = color;
    this.ruleset = ruleset;
    this.tankRules = ruleset.tank;
    this.bulletRules = { ...ruleset.bullet, tickRate: ruleset.tickRate };
    this.powerupRules = ruleset.powerup;
    this.alive = true;
    this.cooldown = 0;
    this.deployCooldown = 0;
    this.scatterShots = 0;
    this.laserShots = 0;
    this.mineCharges = 0;
    this.mineHoldTimer = 0;
    this.shield = false;
    this.shieldTimer = 0;
  }

  // controls 已经过控制门：move/turn ∈ {-1,0,1}。先转向，再沿转向后的朝向移动。
  // 返回本 Tick 被墙修正的位移，供运动诊断使用。
  update(dt, walls, controls) {
    if (!this.alive) return { wallX: 0, wallY: 0 };
    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.deployCooldown > 0) this.deployCooldown -= dt;
    if (this.mineCharges > 0) {
      this.mineHoldTimer -= dt;
      if (this.mineHoldTimer <= 0) this.mineCharges = 0;
    }
    if (this.shield) {
      this.shieldTimer -= dt;
      if (this.shieldTimer <= 0) { this.shield = false; this.shieldTimer = 0; }
    }

    this.angle = wrapTau(this.angle + controls.turn * this.tankRules.turnSpeed * dt);
    if (controls.move !== 0) {
      const distance = controls.move * this.tankRules.moveSpeed * dt;
      this.x += dcos(this.angle) * distance;
      this.y += dsin(this.angle) * distance;
    }
    const rawX = this.x;
    const rawY = this.y;
    const fixed = resolveCircleWalls(this.x, this.y, this.tankRules.radius, walls);
    this.x = fixed.x;
    this.y = fixed.y;
    return { wallX: this.x - rawX, wallY: this.y - rawY };
  }

  // 返回 { bullets, laser }。限流靠同屏弹数上限，冷却只防同一发按键连出。
  tryFire(bullets, wantFire, walls) {
    const none = { bullets: [], laser: null };
    if (!this.alive || this.cooldown > 0 || !wantFire) return none;
    const scattering = this.scatterShots > 0;
    if (!scattering && this.laserShots === 0) {
      let mine = 0;
      for (const b of bullets) if (b.owner === this && !b.dead) mine++;
      if (mine >= this.bulletRules.maxAlive) return none;
    }
    this.cooldown = this.bulletRules.cooldown;
    if (scattering) {
      this.scatterShots--;
      const { pellets, spreadAngle } = this.powerupRules.scatter;
      const mid = (pellets - 1) / 2;
      const out = [];
      for (let i = 0; i < pellets; i++) out.push(this.spawnBullet(this.angle + (i - mid) * spreadAngle, walls, 'scatter'));
      return { bullets: out, laser: null };
    }
    if (this.laserShots > 0) {
      this.laserShots--;
      return { bullets: [], laser: this.muzzlePoint(walls) };
    }
    return { bullets: [this.spawnBullet(this.angle, walls)], laser: null };
  }

  tryDeploy(wantSpecial, walls) {
    if (!this.alive || !wantSpecial || this.deployCooldown > 0 || this.mineCharges <= 0) return null;
    const mine = this.powerupRules.mine;
    this.deployCooldown = mine.deployCooldown;
    this.mineCharges--;
    this.mineHoldTimer = mine.holdTimeout;
    const back = this.tankRules.radius + mine.discRadius + 4;
    const fixed = resolveCircleWalls(this.x - dcos(this.angle) * back, this.y - dsin(this.angle) * back, mine.discRadius, walls);
    return new Mine(fixed.x, fixed.y, this, mine);
  }

  // 炮口比车体半径伸得远，贴墙时会越到墙另一侧：沿“车心→炮口”探测墙并压回墙前，
  // 否则炮弹凭空出现在墙背面。压回后下一步即被反射，贴墙开炮会弹回来。
  muzzleDistance(heading, walls) {
    const d = this.tankRules.muzzleOffset;
    let distance = d;
    const mx = this.x + dcos(heading) * d;
    const my = this.y + dsin(heading) * d;
    for (const w of walls) {
      const t = segmentVsSegmentParam(this.x, this.y, mx, my, w.x1, w.y1, w.x2, w.y2);
      if (t !== null) distance = Math.min(distance, t * d - this.bulletRules.radius - 1);
    }
    return distance;
  }

  muzzlePoint(walls) {
    const distance = this.muzzleDistance(this.angle, walls);
    return { x: this.x + dcos(this.angle) * distance, y: this.y + dsin(this.angle) * distance, angle: this.angle };
  }

  spawnBullet(heading, walls, kind = 'bullet') {
    const distance = this.muzzleDistance(heading, walls);
    const cos = dcos(heading);
    const sin = dsin(heading);
    const speed = this.bulletRules.speed;
    const b = new Bullet(this.x + cos * distance, this.y + sin * distance, cos * speed, sin * speed, this, this.bulletRules);
    b.kind = kind;
    return b;
  }

  // 武器槽（散射/激光/地雷）互斥：拾取异类清空旧存货，同类叠加；护盾独立。
  applyPowerup(type) {
    const rules = this.powerupRules;
    if (type === 'scatter') {
      this.laserShots = 0;
      this.mineCharges = 0;
      this.scatterShots += rules.scatter.shots;
    } else if (type === 'laser') {
      this.scatterShots = 0;
      this.mineCharges = 0;
      this.laserShots += rules.laser.shots;
    } else if (type === 'mine') {
      this.scatterShots = 0;
      this.laserShots = 0;
      this.mineCharges += rules.mine.charges;
      this.mineHoldTimer = rules.mine.holdTimeout;
    } else if (type === 'shield') {
      this.shield = true;
      this.shieldTimer = rules.shield.duration;
    }
  }
}
