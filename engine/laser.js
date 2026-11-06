// 激光：瞬时射线的纯几何。从起点沿方向投射，撞墙反射，直到反弹或总长耗尽。

import { dcos, dlen, dsin } from './detmath.js';
import { reflect, segmentVsSegmentParam } from './geometry.js';

export function castLaserPath(x, y, angle, walls, { maxBounces, maxLength }) {
  let remain = maxLength;
  const points = [{ x, y }];
  let px = x;
  let py = y;
  let dx = dcos(angle);
  let dy = dsin(angle);

  for (let segment = 0; segment <= maxBounces && remain > 0.5; segment++) {
    const ex = px + dx * remain;
    const ey = py + dy * remain;
    let bestT = null;
    let bestWall = null;
    for (const w of walls) {
      const t = segmentVsSegmentParam(px, py, ex, ey, w.x1, w.y1, w.x2, w.y2);
      if (t !== null && (bestT === null || t < bestT)) { bestT = t; bestWall = w; }
    }
    if (bestT === null) { points.push({ x: ex, y: ey }); break; }

    const hx = px + dx * remain * bestT;
    const hy = py + dy * remain * bestT;
    points.push({ x: hx, y: hy });
    remain -= remain * bestT;
    if (segment === maxBounces) break;

    const wx = bestWall.x2 - bestWall.x1;
    const wy = bestWall.y2 - bestWall.y1;
    const len = dlen(wx, wy) || 1;
    const r = reflect(dx, dy, -wy / len, wx / len);
    dx = r.vx;
    dy = r.vy;
    // 新段起点沿反射方向微移，防止浮点误差下同一堵墙再次判交。
    px = hx + dx * 0.5;
    py = hy + dy * 0.5;
  }
  return points;
}
