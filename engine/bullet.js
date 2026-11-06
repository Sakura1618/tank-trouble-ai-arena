// 炮弹：沿速度向量直线运动，撞墙镜面反射，到寿命消失。纯模拟，无渲染。

import { deepestContact, reflect } from './geometry.js';

const MAX_CONTACTS_PER_STEP = 4;

export class Bullet {
  constructor(x, y, vx, vy, owner, rules) {
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.owner = owner;
    this.rules = rules;
    this.bounces = 0;
    this.age = 0;
    this.dead = false;
    this.kind = 'bullet';
    this.arenaId = 0;
    // 把每 Tick 位移拆成不超过半径的子步：撞击因此总在墙的正面被采样，
    // 法线方向恒定正确。固定 60Hz 下 180px/s = 3px = 半径，恰好一步。
    this.steps = Math.max(1, Math.ceil(rules.speed / rules.radius / rules.tickRate - 1e-9));
  }

  update(dt, walls, erode = false, onBounce = null) {
    if (this.dead) return;
    this.age += dt;
    if (this.age >= this.rules.lifetime) { this.dead = true; return; }
    const sub = dt / this.steps;
    for (let s = 0; s < this.steps; s++) this.stepMove(sub, walls, erode, onBounce);
  }

  stepMove(dt, walls, erode, onBounce) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    // 只响应正在靠近的墙：刚反弹离开的墙不能再反射一次，否则炮弹会被折回墙里。
    const approaching = hit => this.vx * hit.nx + this.vy * hit.ny < 0;
    for (let i = 0; i < MAX_CONTACTS_PER_STEP; i++) {
      const contact = deepestContact(this.x, this.y, this.rules.radius, walls, approaching);
      if (!contact) return;
      const { hit, wall } = contact;
      const previousVx = this.vx;
      const previousVy = this.vy;
      this.x += hit.nx * hit.depth;
      this.y += hit.ny * hit.depth;
      const r = reflect(this.vx, this.vy, hit.nx, hit.ny);
      this.vx = r.vx;
      this.vy = r.vy;
      if (erode && !wall.border && wall.hp !== undefined) wall.hp -= 1;
      this.bounces++;
      if (onBounce) onBounce(this, wall, previousVx, previousVy);
    }
  }

  // 出膛宽限只保护尚未反弹的炮弹；一旦反弹，贴墙开炮照样会打死自己。
  canHit(tank) {
    return !(tank === this.owner && this.bounces === 0 && this.age < this.rules.selfHitGrace);
  }
}
