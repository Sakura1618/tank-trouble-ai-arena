// 画布渲染。物理是固定 60Hz，屏幕刷新率和 Tick 到达时间都不固定，
// 直接画最新状态会让一帧走两 Tick、下一帧不动，观感是一顿一顿。
// 这里保留前后两帧，按 Tick 内进度插值；只影响画面，不进入比赛。

import { WALL, THEME } from './theme.js';
import { LaserBeam, drawBullet, drawLaserPreview, drawMine, drawPowerup, drawTank } from './sprites.js';
import { TankExplosion, MuzzleFlash, ShieldBreak, PickupFlash, MineBlast } from './effects.js';

const TRAIL_LENGTH = 6;

function effectFor(e) {
  if (e.type === 'death') return new TankExplosion(e.x, e.y, e.color);
  if (e.type === 'fire') return new MuzzleFlash(e.x, e.y, e.angle);
  if (e.type === 'shield') return new ShieldBreak(e.x, e.y, e.color);
  if (e.type === 'pickup') return new PickupFlash(e.x, e.y, e.powerup);
  if (e.type === 'mine') return new MineBlast(e.x, e.y);
  if (e.type === 'laser') return new LaserBeam(e.points);
  return null;
}

function lerpAngle(a, b, t) {
  const delta = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + delta * t;
}

export class ArenaRenderer {
  constructor(canvas, { maxDpr = Infinity } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.maxDpr = maxDpr;
    this.reset();
  }

  reset() {
    this.previous = null;
    this.current = null;
    this.effects = [];
    this.trails = new Map();
  }

  // 收到新一帧时调用。jump=true 表示回放拖动：不插值、不补特效。
  push(frame, { jump = false } = {}) {
    this.previous = jump ? frame : this.current ?? frame;
    this.current = frame;
    if (jump) {
      this.effects = [];
      this.trails = new Map();
      return;
    }
    for (const e of frame.events) {
      const effect = effectFor(e);
      if (effect) this.effects.push(effect);
    }
    const live = new Set();
    for (const b of frame.bullets) {
      live.add(b.id);
      const trail = this.trails.get(b.id) ?? [];
      trail.push({ x: b.x, y: b.y });
      if (trail.length > TRAIL_LENGTH) trail.shift();
      this.trails.set(b.id, trail);
    }
    for (const id of this.trails.keys()) if (!live.has(id)) this.trails.delete(id);
  }

  blendTank(tank, alpha) {
    const before = this.previous.tanks.find(t => t.id === tank.id);
    if (!before || !before.alive) return tank;
    return { ...tank, x: before.x + (tank.x - before.x) * alpha, y: before.y + (tank.y - before.y) * alpha,
      angle: lerpAngle(before.angle, tank.angle, alpha) };
  }

  blendBullet(bullet, alpha) {
    const before = this.previous.bullets.find(b => b.id === bullet.id);
    const trail = this.trails.get(bullet.id) ?? [];
    if (!before) return { ...bullet, trail };
    return { ...bullet, trail, x: before.x + (bullet.x - before.x) * alpha, y: before.y + (bullet.y - before.y) * alpha };
  }

  // alpha ∈ [0,1]：当前显示位置在 previous 和 current 之间的进度。
  draw(elapsed, paused, alpha = 1) {
    const { canvas, ctx } = this;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr);
    const width = Math.round(rect.width * dpr);
    const height = Math.round(rect.height * dpr);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    const frame = this.current;
    if (!frame) return;

    const w = frame.cols * frame.cellSize;
    const h = frame.rows * frame.cellSize;
    const scale = Math.min((rect.width - 40) / w, (rect.height - 56) / h);
    ctx.save();
    ctx.translate((rect.width - w * scale) / 2, (rect.height - h * scale) / 2);
    ctx.scale(scale, scale);
    ctx.fillStyle = THEME.arenaBg;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = WALL.color;
    ctx.lineWidth = WALL.thickness;
    ctx.lineCap = 'round';
    for (const wall of frame.walls) {
      ctx.globalAlpha = wall.border ? 1 : 0.35 + 0.65 * Math.max(0, wall.hp) / frame.wallHp;
      ctx.beginPath();
      ctx.moveTo(wall.x1, wall.y1);
      ctx.lineTo(wall.x2, wall.y2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = THEME.arenaBorder;
    ctx.lineWidth = WALL.borderThickness;
    ctx.strokeRect(0, 0, w, h);

    frame.powerups.forEach(p => drawPowerup(ctx, p, frame.powerupRadius));
    frame.mines.forEach(m => { if (m.visibility > 0) drawMine(ctx, m); });
    frame.tanks.forEach(t => { if (t.laserPath) drawLaserPreview(ctx, t.laserPath); });
    frame.bullets.forEach(b => drawBullet(ctx, this.blendBullet(b, alpha), frame.bulletRadius));
    const tanks = frame.tanks.filter(t => t.alive).map(t => this.blendTank(t, alpha));
    tanks.forEach(t => drawTank(ctx, t));
    for (const t of tanks) {
      ctx.font = 'bold 14px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#eeeeef';
      ctx.fillStyle = '#222735';
      const labelY = Math.max(16, t.y - 29);
      ctx.strokeText(t.name, t.x, labelY);
      ctx.fillText(t.name, t.x, labelY);
    }
    if (!paused) this.effects.forEach(e => e.update(elapsed));
    this.effects = this.effects.filter(e => !e.done);
    this.effects.forEach(e => e.render(ctx));
    ctx.restore();
  }
}
