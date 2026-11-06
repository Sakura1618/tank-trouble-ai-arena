// 精灵绘制：只读帧快照，不依赖引擎对象。所有图形都是程序绘制，没有外部素材。

import { TANK, THEME, POWERUP_BLINK_UNDER, LASER_BEAM_SECONDS } from './theme.js';

export const TYPE_BG = {
  scatter: THEME.powScatterBg,
  shield: THEME.powShieldBg,
  laser: THEME.powLaserBg,
  mine: THEME.powMineBg,
};

function darken(color) {
  const c = color.replace('#', '');
  const channel = i => Math.round(parseInt(c.slice(i, i + 2), 16) * 0.7);
  return `rgb(${channel(0)}, ${channel(2)}, ${channel(4)})`;
}

export function drawTank(ctx, tank) {
  if (!tank.alive) return;

  ctx.save();
  ctx.translate(tank.x, tank.y);
  ctx.rotate(tank.angle);

  const {
    bodyLength, bodyWidth,
    treadLength, treadWidth, treadInset,
    turretRadius,
    barrelLength, barrelWidth,
  } = TANK;

  // 履带颜色：统一深色，不随玩家色变（原版风格）
  const treadColor = "#3a3a4a";
  const treadEdge = "rgba(0,0,0,0.5)";

  // —— 1) 上下两条履带（最底层，深色横条，比车体略长两端探出）——
  // 履带在垂直方向(y)位于车体两侧外缘
  const treadY = bodyWidth / 2 - treadInset; // 履带内缘贴着车体外缘
  for (const sign of [-1, 1]) {
    const y = sign * treadY;
    ctx.fillStyle = treadColor;
    ctx.fillRect(-treadLength / 2, y - (sign < 0 ? treadWidth : 0), treadLength, treadWidth);
    // 履带描边
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = treadEdge;
    ctx.strokeRect(-treadLength / 2, y - (sign < 0 ? treadWidth : 0), treadLength, treadWidth);
    // 履带上的横向纹路（齿），增强"履带"质感
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = 1;
    const topY = y - (sign < 0 ? treadWidth : 0);
    const segs = 6;
    for (let i = 1; i < segs; i++) {
      const sx = -treadLength / 2 + (treadLength * i) / segs;
      ctx.beginPath();
      ctx.moveTo(sx, topY);
      ctx.lineTo(sx, topY + treadWidth);
      ctx.stroke();
    }
  }

  // —— 2) 车体（中间彩色方块）——
  ctx.fillStyle = tank.color;
  ctx.fillRect(-bodyLength / 2, -bodyWidth / 2, bodyLength, bodyWidth);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.strokeRect(-bodyLength / 2, -bodyWidth / 2, bodyLength, bodyWidth);

  // —— 3) 炮管（从中心向前(+x)伸出的圆头管，先画，让炮塔盖住根部）——
  ctx.strokeStyle = "#2b2b3a";
  ctx.lineWidth = barrelWidth;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(turretRadius + barrelLength, 0);
  ctx.stroke();

  // —— 4) 炮塔（中央圆盘，同色系略深，盖住炮管根部）——
  ctx.fillStyle = darken(tank.color);
  ctx.beginPath();
  ctx.arc(0, 0, turretRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.stroke();

  ctx.restore();

  // —— 护盾环（持有护盾时，套在车体外的旋转虚线光环）——
  // 单独一段：只平移不旋转，让光环动画与车头朝向解耦（环跟着车走但自转）。
  // 旋转用 lineDashOffset 随 shieldTimer 推进；快到期时闪烁提示即将消失，
  // 阈值与 HUD 徽章共读 POWERUP_BLINK_UNDER（原先两处各硬编码 1.5）。
  if (tank.shield) {
    const blink = tank.shieldTimer < POWERUP_BLINK_UNDER
      ? 0.4 + 0.4 * Math.abs(Math.sin(tank.shieldTimer * 8)) : 0.8;
    ctx.save();
    ctx.translate(tank.x, tank.y);
    ctx.globalAlpha = blink;
    ctx.strokeStyle = THEME.shieldRing;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([6, 5]);
    ctx.lineDashOffset = -tank.shieldTimer * 18; // 负值 → 顺时针流动
    ctx.beginPath();
    ctx.arc(0, 0, TANK.radius + 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);       // 复位虚线，别污染后续绘制
    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

export function drawBullet(ctx, bullet, radius) {
  const { trail } = bullet;
  for (let i = 0; i < trail.length; i++) {
    const t = trail[i];
    const f = (i + 1) / (trail.length + 1);
    ctx.globalAlpha = 0.14 * f;
    ctx.beginPath();
    ctx.arc(t.x, t.y, radius * (0.4 + 0.5 * f), 0, Math.PI * 2);
    ctx.fillStyle = THEME.bullet;
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(bullet.x, bullet.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = THEME.bullet;
  ctx.fill();
}

export function drawPowerup(ctx, powerup, radius) {
  const pulse = 1 + Math.sin(powerup.age * 3) * 0.06;
  drawPowerupIcon(ctx, powerup.type, powerup.x, powerup.y, radius, pulse);
}

// 统一的「圆底 + 类型图标」绘制入口（地上道具与 HUD 徽章共用）。
// r 为图标基准半径；bgScale 只缩放底圆（呼吸动画用，默认 1）。
export function drawPowerupIcon(ctx, type, x, y, r, bgScale = 1) {
  ctx.save();
  ctx.translate(x, y);

  // —— 圆底（按类型上色）+ 深色描边 ——
  ctx.fillStyle = TYPE_BG[type] || THEME.powScatterBg;
  ctx.beginPath();
  ctx.arc(0, 0, r * bgScale, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = THEME.powRing;
  ctx.stroke();

  // —— 类型图标（白色线条，压在底色上）——
  ctx.strokeStyle = THEME.powIcon;
  ctx.fillStyle = THEME.powIcon;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (type === "scatter") {
    drawScatterIcon(ctx, r);
  } else if (type === "laser") {
    drawLaserIcon(ctx, r);
  } else if (type === "mine") {
    drawMineIcon(ctx, r);
  } else {
    drawShieldIcon(ctx, r);
  }

  ctx.restore();
}

// 散射图标：三道从左侧汇聚、向右发散的箭线（表"一变三"）
function drawScatterIcon(ctx, r) {
  const len = r * 0.62;
  const originX = -len * 0.6;
  for (const ang of [-0.5, 0, 0.5]) {
    const ex = originX + Math.cos(ang) * len * 1.7;
    const ey = Math.sin(ang) * len * 1.4;
    ctx.beginPath();
    ctx.moveTo(originX, 0);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    // 箭头小叉
    const back = 4;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - Math.cos(ang - 0.5) * back, ey - Math.sin(ang - 0.5) * back);
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - Math.cos(ang + 0.5) * back, ey - Math.sin(ang + 0.5) * back);
    ctx.stroke();
  }
}

// 护盾图标：经典盾形（顶平、底尖），白描边
function drawShieldIcon(ctx, r) {
  const w = r * 0.5;
  const top = -r * 0.5;
  const mid = r * 0.18;
  const bot = r * 0.62;
  ctx.beginPath();
  ctx.moveTo(-w, top);
  ctx.lineTo(w, top);
  ctx.lineTo(w, mid);
  ctx.quadraticCurveTo(w, bot, 0, bot);   // 右下收向尖底
  ctx.quadraticCurveTo(-w, bot, -w, mid); // 左下收向尖底
  ctx.closePath();
  ctx.stroke();
}

// 地雷图标：半圆雷体扣在地平线上 + 顶部三根触刺 + 中心引信点
function drawMineIcon(ctx, r) {
  const w = r * 0.55;   // 雷体半宽
  const base = r * 0.35; // 地平线高度（图标重心略下移）

  // 地平线
  ctx.beginPath();
  ctx.moveTo(-r * 0.75, base);
  ctx.lineTo(r * 0.75, base);
  ctx.stroke();

  // 半圆雷体（扣在地平线上）
  ctx.beginPath();
  ctx.arc(0, base, w, Math.PI, 0);
  ctx.closePath();
  ctx.stroke();

  // 顶部三根触刺（从雷体表面沿径向朝外，-135°/-90°/-45°）
  for (const a of [-Math.PI * 0.75, -Math.PI * 0.5, -Math.PI * 0.25]) {
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * w, base + Math.sin(a) * w);
    ctx.lineTo(Math.cos(a) * (w + r * 0.3), base + Math.sin(a) * (w + r * 0.3));
    ctx.stroke();
  }

  // 中心引信点
  ctx.beginPath();
  ctx.arc(0, base - w * 0.45, 1.8, 0, Math.PI * 2);
  ctx.fill();
}

// 激光图标：一道折线射线（反弹轨迹意象）+ 末端光点
function drawLaserIcon(ctx, r) {
  const s = r * 0.62;
  ctx.beginPath();
  ctx.moveTo(-s, s * 0.7);
  ctx.lineTo(-s * 0.15, -s * 0.6);
  ctx.lineTo(s * 0.35, s * 0.5);
  ctx.lineTo(s * 0.95, -s * 0.45);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(s * 0.95, -s * 0.45, 2.2, 0, Math.PI * 2);
  ctx.fill();
}

export function drawMine(ctx, mine) {
  const vis = mine.visibility;
  if (vis <= 0) return; // 完全隐形：跳过绘制（省事也省性能）

  const r = mine.discRadius;

  ctx.save();
  ctx.translate(mine.x, mine.y);

  // 雷盘：布防期半透明（看得见但知道还没警戒），警戒后实色亮相再淡出
  ctx.globalAlpha = vis;
  ctx.fillStyle = THEME.mineBody;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.stroke();

  // 盘面十字压线（一点"机械感"细节）
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-r * 0.6, 0);
  ctx.lineTo(r * 0.6, 0);
  ctx.moveTo(0, -r * 0.6);
  ctx.lineTo(0, r * 0.6);
  ctx.stroke();

  // 中心指示灯：警戒后红色 sin 闪烁，布防期灰色常亮（都随整体可见度衰减）
  if (mine.armed) {
    ctx.globalAlpha = vis * (0.4 + 0.6 * (0.5 + 0.5 * Math.sin(mine.age * 10)));
    ctx.fillStyle = THEME.mineBlink;
  } else {
    ctx.globalAlpha = vis * 0.6;
    ctx.fillStyle = "#9a9aa5";
  }
  ctx.beginPath();
  ctx.arc(0, 0, 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
  ctx.globalAlpha = 1;
}

export class LaserBeam {
  // points: 折线顶点（main 已按命中截断，视觉上射线止于目标/护盾）
  constructor(points) {
    this.points = points;
    this.age = 0;
    this.duration = LASER_BEAM_SECONDS;
  }

  get done() {
    return this.age >= this.duration;
  }

  update(dt) {
    this.age += dt;
  }

  render(ctx) {
    if (this.done || this.points.length < 2) return;
    const p = this.age / this.duration;
    const alpha = 1 - p;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = THEME.laserBeam;

    ctx.beginPath();
    ctx.moveTo(this.points[0].x, this.points[0].y);
    for (let i = 1; i < this.points.length; i++) {
      ctx.lineTo(this.points[i].x, this.points[i].y);
    }
    // 外圈光晕（粗、淡）
    ctx.globalAlpha = alpha * 0.25;
    ctx.lineWidth = 7;
    ctx.stroke();
    // 内芯亮线（细、实，随时间略变细）——同一路径再描一遍
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 2.5 * (1 - p * 0.5);
    ctx.stroke();

    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

export function drawLaserPreview(ctx, points) {
  if (points.length < 2) return;
  ctx.save();
  ctx.strokeStyle = THEME.laserPreview;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 6]);
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}
