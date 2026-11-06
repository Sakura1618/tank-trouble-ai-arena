// 纯几何碰撞工具。墙是零厚度线段，坦克和炮弹是圆。
//
// 接触解算采用“最深优先”：相邻墙段共享端点，顺序遍历时圆可能先撞上端点，
// 得到一条歪斜的假法线（ghost vertex），炮弹会被偏到错误方向，
// 贴墙行驶也会被顶一下。每轮只解算最深的接触，假法线的接触深度总是更浅，
// 解算完真正的墙面后它自然消失。

import { dlen } from './detmath.js';

export function closestPointOnSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { x: x1, y: y1 };
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return { x: x1 + t * dx, y: y1 + t * dy };
}

export function distanceToSegment(px, py, x1, y1, x2, y2) {
  const c = closestPointOnSegment(px, py, x1, y1, x2, y2);
  return dlen(px - c.x, py - c.y);
}

// 圆与线段相交时返回 { nx, ny, depth }，法线从墙指向圆心。
export function circleVsSegment(cx, cy, r, x1, y1, x2, y2) {
  if (cx + r < Math.min(x1, x2) || cx - r > Math.max(x1, x2) ||
      cy + r < Math.min(y1, y2) || cy - r > Math.max(y1, y2)) return null;
  const cp = closestPointOnSegment(cx, cy, x1, y1, x2, y2);
  const nx = cx - cp.x;
  const ny = cy - cp.y;
  const distSq = nx * nx + ny * ny;
  if (distSq >= r * r) return null;
  const dist = Math.sqrt(distSq);
  if (dist === 0) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = dlen(dx, dy) || 1;
    return { nx: -dy / len, ny: dx / len, depth: r };
  }
  return { nx: nx / dist, ny: ny / dist, depth: r - dist };
}

// 返回与圆接触最深的墙；accept 可过滤接触（炮弹只响应正在靠近的墙）。
export function deepestContact(x, y, r, walls, accept = null) {
  let best = null;
  let bestWall = null;
  for (const w of walls) {
    const hit = circleVsSegment(x, y, r, w.x1, w.y1, w.x2, w.y2);
    if (!hit || (accept && !accept(hit))) continue;
    if (!best || hit.depth > best.depth) { best = hit; bestWall = w; }
  }
  return best ? { hit: best, wall: bestWall } : null;
}

// 把圆推出所有相交的墙，沿墙方向的分量保留，这就是“贴墙滑动”的来源。
export function resolveCircleWalls(cx, cy, r, walls, iterations = 6) {
  let x = cx;
  let y = cy;
  for (let i = 0; i < iterations; i++) {
    const contact = deepestContact(x, y, r, walls);
    if (!contact) break;
    x += contact.hit.nx * contact.hit.depth;
    y += contact.hit.ny * contact.hit.depth;
  }
  return { x, y };
}

// 等质量双圆分离；未重叠返回 null。重合时沿 +x 分开。
export function separateCircles(ax, ay, bx, by, minDist) {
  const dx = bx - ax;
  const dy = by - ay;
  const distSq = dx * dx + dy * dy;
  if (distSq >= minDist * minDist) return null;
  const dist = Math.sqrt(distSq);
  const nx = dist > 1e-6 ? dx / dist : 1;
  const ny = dist > 1e-6 ? dy / dist : 0;
  const push = (minDist - dist) / 2;
  return { ax: ax - nx * push, ay: ay - ny * push, bx: bx + nx * push, by: by + ny * push };
}

// v' = v - 2(v·n)n
export function reflect(vx, vy, nx, ny) {
  const dot = vx * nx + vy * ny;
  return { vx: vx - 2 * dot * nx, vy: vy - 2 * dot * ny };
}

export function circleVsCircle(x1, y1, r1, x2, y2, r2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const rr = r1 + r2;
  return dx * dx + dy * dy <= rr * rr;
}

// 解 A+t·AB = C+u·CD，返回 AB 上的参数 t；平行或不相交返回 null。
export function segmentVsSegmentParam(x1, y1, x2, y2, x3, y3, x4, y4) {
  const dx1 = x2 - x1;
  const dy1 = y2 - y1;
  const dx2 = x4 - x3;
  const dy2 = y4 - y3;
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((x3 - x1) * dy2 - (y3 - y1) * dx2) / denom;
  const u = ((x3 - x1) * dy1 - (y3 - y1) * dx1) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}
