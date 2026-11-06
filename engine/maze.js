// 地图生成：稀疏规整格栅。每条格子边界“可能有墙也可能没有”，墙横平竖直、整格长。
// 所有随机来自传入的 Rng，相同种子产出逐位相同的地图。
//
// 流程：全开放起步 → 按风格放内墙 → 连通性修复（只删不加）→ 输出线段。
// 坐标约定：格 (c, r) 的左上角世界坐标 = (c*cellSize, r*cellSize)。

import { distanceToSegment } from './geometry.js';

export const DIRS = [
  { dc: 0, dr: -1, wall: 'top', opposite: 'bottom' },
  { dc: 1, dr: 0, wall: 'right', opposite: 'left' },
  { dc: 0, dr: 1, wall: 'bottom', opposite: 'top' },
  { dc: -1, dr: 0, wall: 'left', opposite: 'right' },
];

// options 取自 ruleset.map，另加 wallHp。
export function generateMaze(cols, rows, style, rng, options) {
  const innerEdges = rows * (cols - 1) + cols * (rows - 1);
  const floor = innerEdges * options.minDensity;
  let maze = buildMaze(cols, rows, style, rng, options);
  // 放墙是概率的，连通修复又只删不加，尾部可能抽到几乎没有掩体的空图，低于下限就重抽。
  for (let i = 1; i < options.regenerateTries && innerWallCount(maze.walls) < floor; i++) {
    maze = buildMaze(cols, rows, style, rng, options);
  }
  return maze;
}

const innerWallCount = walls => walls.reduce((n, w) => n + (w.border ? 0 : 1), 0);

function buildMaze(cols, rows, style, rng, options) {
  const cells = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      row.push({ top: r === 0, bottom: r === rows - 1, left: c === 0, right: c === cols - 1 });
    }
    cells.push(row);
  }
  if (style === 'symmetric') fillSymmetric(cells, cols, rows, rng, options.density.symmetric);
  else if (style === 'rooms') fillRooms(cells, cols, rows, rng, options.rooms);
  else fillSparse(cells, cols, rows, rng, options.density.sparse);

  ensureConnected(cells, cols, rows);
  // 连通修复的单边敲墙会破坏镜像，把失配的一侧也敲掉；删墙只会让连通性更好。
  if (style === 'symmetric') enforceSymmetry(cells, cols, rows);

  const walls = buildWallSegments(cells, cols, rows, options.cellSize, options.wallHp);
  return { cols, rows, cells, walls, cellSize: options.cellSize, style };
}

function fillSparse(cells, cols, rows, rng, density) {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 1; c++) {
      if (rng.next() < density) { cells[r][c].right = true; cells[r][c + 1].left = true; }
    }
  }
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols; c++) {
      if (rng.next() < density) { cells[r][c].bottom = true; cells[r + 1][c].top = true; }
    }
  }
}

// 180° 中心对称：放一条内墙就同时放它的镜像。
function fillSymmetric(cells, cols, rows, rng, density) {
  const putV = (c, r) => { cells[r][c].right = true; cells[r][c + 1].left = true; };
  const putH = (c, r) => { cells[r][c].bottom = true; cells[r + 1][c].top = true; };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const mc = cols - 2 - c;
      const mr = rows - 1 - r;
      if (r > mr || (r === mr && c > mc)) continue;
      if (rng.next() < density) { putV(c, r); putV(mc, mr); }
    }
  }
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols; c++) {
      const mc = cols - 1 - c;
      const mr = rows - 2 - r;
      if (r > mr || (r === mr && c > mc)) continue;
      if (rng.next() < density) { putH(c, r); putH(mc, mr); }
    }
  }
}

function enforceSymmetry(cells, cols, rows) {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 1; c++) {
      if (cells[r][c].right && !cells[rows - 1 - r][cols - 2 - c].right) {
        cells[r][c].right = false;
        cells[r][c + 1].left = false;
      }
    }
  }
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols; c++) {
      if (cells[r][c].bottom && !cells[rows - 2 - r][cols - 1 - c].bottom) {
        cells[r][c].bottom = false;
        cells[r + 1][c].top = false;
      }
    }
  }
}

// 房间 + 走廊：递归二分到边长 ∈ [roomMin, roomMax]，切缝放满墙，再在墙段上开门。
function fillRooms(cells, cols, rows, rng, { roomMin, roomMax, extraDoorChance }) {
  const putV = (c, r) => { cells[r][c].right = true; cells[r][c + 1].left = true; };
  const putH = (c, r) => { cells[r][c].bottom = true; cells[r + 1][c].top = true; };
  const cutV = (c, r) => { cells[r][c].right = false; cells[r][c + 1].left = false; };
  const cutH = (c, r) => { cells[r][c].bottom = false; cells[r + 1][c].top = false; };

  const queue = [{ c0: 0, r0: 0, c1: cols - 1, r1: rows - 1 }];
  while (queue.length) {
    const b = queue.pop();
    const w = b.c1 - b.c0 + 1;
    const h = b.r1 - b.r0 + 1;
    if (w <= roomMax && h <= roomMax) continue;
    if (w >= h) {
      const cut = b.c0 + roomMin - 1 + rng.int(w - 2 * roomMin + 1);
      for (let r = b.r0; r <= b.r1; r++) putV(cut, r);
      queue.push({ c0: b.c0, r0: b.r0, c1: cut, r1: b.r1 });
      queue.push({ c0: cut + 1, r0: b.r0, c1: b.c1, r1: b.r1 });
    } else {
      const cut = b.r0 + roomMin - 1 + rng.int(h - 2 * roomMin + 1);
      for (let c = b.c0; c <= b.c1; c++) putH(c, cut);
      queue.push({ c0: b.c0, r0: b.r0, c1: b.c1, r1: cut });
      queue.push({ c0: b.c0, r0: cut + 1, c1: b.c1, r1: b.r1 });
    }
  }

  const openDoors = (segments, cut) => {
    for (const segment of segments) {
      const first = rng.pick(segment);
      cut(first.c, first.r);
      if (segment.length >= 3 && rng.next() < extraDoorChance) {
        const second = rng.pick(segment);
        cut(second.c, second.r);
      }
    }
  };
  const vertical = [];
  for (let c = 0; c < cols - 1; c++) {
    let run = [];
    for (let r = 0; r < rows; r++) {
      if (cells[r][c].right) run.push({ c, r });
      else if (run.length) { vertical.push(run); run = []; }
    }
    if (run.length) vertical.push(run);
  }
  const horizontal = [];
  for (let r = 0; r < rows - 1; r++) {
    let run = [];
    for (let c = 0; c < cols; c++) {
      if (cells[r][c].bottom) run.push({ c, r });
      else if (run.length) { horizontal.push(run); run = []; }
    }
    if (run.length) horizontal.push(run);
  }
  openDoors(vertical, cutV);
  openDoors(horizontal, cutH);
}

export function knockWall(cells, c, r, d) {
  cells[r][c][d.wall] = false;
  cells[r + d.dr][c + d.dc][d.opposite] = false;
}

// 炸掉爆心 radius 内的全部内墙段。外墙永不破坏。
export function destroyWallsInRadius(maze, cx, cy, radius) {
  const hit = maze.walls.filter(w => !w.border &&
    distanceToSegment(cx, cy, w.x1, w.y1, w.x2, w.y2) < radius);
  return destroyWallSegments(maze, hit);
}

// walls（物理）与 cells（寻路）必须同时更新。此函数整体替换 walls，须在墙遍历之外调用。
export function destroyWallSegments(maze, segments) {
  const size = maze.cellSize;
  const destroyed = [];
  for (const w of segments) {
    if (w.border || w.destroyed) continue;
    w.destroyed = true;
    destroyed.push(w);
    if (maze.cells) {
      const c = Math.round(w.x1 / size);
      const r = Math.round(w.y1 / size);
      const d = DIRS.find(dir => dir.wall === (w.y1 === w.y2 ? 'top' : 'left'));
      knockWall(maze.cells, c, r, d);
    }
  }
  if (destroyed.length) maze.walls = maze.walls.filter(w => !w.destroyed);
  return destroyed;
}

function floodReachable(cells, cols, rows) {
  const reached = Array.from({ length: rows }, () => new Array(cols).fill(false));
  const stack = [{ c: 0, r: 0 }];
  reached[0][0] = true;
  while (stack.length) {
    const { c, r } = stack.pop();
    for (const d of DIRS) {
      const nc = c + d.dc;
      const nr = r + d.dr;
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
      if (reached[nr][nc] || cells[r][c][d.wall]) continue;
      reached[nr][nc] = true;
      stack.push({ c: nc, r: nr });
    }
  }
  return reached;
}

// 每轮把一个紧邻可达区的孤立格打通，只在必要处开口，保持稀疏。
function ensureConnected(cells, cols, rows) {
  for (let guard = 0; guard < cols * rows + 5; guard++) {
    const reached = floodReachable(cells, cols, rows);
    let opened = false;
    let allReached = true;
    for (let r = 0; r < rows && !opened; r++) {
      for (let c = 0; c < cols && !opened; c++) {
        if (reached[r][c]) continue;
        allReached = false;
        for (const d of DIRS) {
          const nc = c + d.dc;
          const nr = r + d.dr;
          if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
          if (reached[nr][nc]) { knockWall(cells, c, r, d); opened = true; break; }
        }
      }
    }
    if (allReached) break;
  }
}

function buildWallSegments(cells, cols, rows, size, wallHp) {
  const segments = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = cells[r][c];
      const x = c * size;
      const y = r * size;
      if (cell.top) {
        segments.push(r === 0
          ? { x1: x, y1: y, x2: x + size, y2: y, border: true }
          : { x1: x, y1: y, x2: x + size, y2: y, border: false, hp: wallHp });
      }
      if (cell.left) {
        segments.push(c === 0
          ? { x1: x, y1: y, x2: x, y2: y + size, border: true }
          : { x1: x, y1: y, x2: x, y2: y + size, border: false, hp: wallHp });
      }
      if (c === cols - 1 && cell.right) segments.push({ x1: x + size, y1: y, x2: x + size, y2: y + size, border: true });
      if (r === rows - 1 && cell.bottom) segments.push({ x1: x, y1: y + size, x2: x + size, y2: y + size, border: true });
    }
  }
  return segments;
}
