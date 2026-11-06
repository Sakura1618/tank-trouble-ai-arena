/*
 * Astra Gen4 · 无相（PROTEUS）
 * 「无形可测，无隙可乘。」
 *
 * 独立 CommonJS 选手，仅读取竞技场公开 state，不识别对手名字或源码。
 * 策略提炼自 Sakura1618 / Opus Gen1「先机」PRESCIENCE：
 * https://github.com/Walkersifolia/tank-trouble-ai-arena/pull/2
 * 源版本 85305b7da0f540810f6926e5a7fbfbd1eda209e1，bots/opus-g1-prescience.js。
 * 保留其公开物理近似、预测器竞选、候选机动、退路分支与弹位管理。
 * 本文件不含价值网络、神经网络权重或神谕代码；决策由显式策略和局内观测产生。
 * Gen4 crossfire 候选：未来可转向的激光威胁、联合掩体目标、短闪避后重新接入路线。
 *
 * MIT License
 * 
 * Copyright (c) 2026 AbyssWhalen
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
'use strict';

const TUNE = {
  baseMargin: 2.641,            // 躲弹基础安全边距，单位：逻辑像素。
  maxMargin: 10,
  hitCost: 1000,            // 轨迹被真实弹体命中的代价。
  shieldedHitCost: 120,     // 护盾有效期内的命中代价。
  softCost: 41.8194,             // 擦边代价。
  virtualCost: 38.41,          // 站在敌方炮口当前瞄线上的代价。
  laserCost: 400,           // 站在持激光敌人瞄线上的代价。
  trampleCost: 25,          // 踩到会覆盖更好武器的道具。
  calmCost: 5.1038,              // 计划风险低于此值时不进入闪避。
  commitBonus: 3.1401,           // 保持上一 Tick 的候选，避免左右摇摆。
  progressWeight: 11.6706,
  aimWeight: 7.1583,
  waypointReach: 22,
  reverseAngle: 2.1,        // 目标方向偏后超过此角度时倒车，单位：弧度。
  closeRange: 172.6956,          // 瞄准时继续逼近到此距离。
  quickShot: 0.7,           // 可在此时间内完成的射击优先于拾取，单位：秒。
  aimCommit: 1.353,           // 超过此时间的射击方案不值得停下来转向。
  aimRays: 120,
  aimTolerance: 3.4403,          // 瞄准解要比碰撞半径更深入的像素数。
  fireLadder: [0.4677, 0.6828, 0.6979, 0.9368, 0.9666], // 按本车在场弹数给出的开火门槛，最后一发留给必中。
  dodgePrior: 0.7016,
  dodgeLearn: 0.1869,
  dodgeForget: 0.0008,
  lootValue: { laser: 10, shield: 6, scatter: 5, mine: 2 },
  lootRange: 6,             // 单位：格。
  blockedEdgeCost: 6,
  minePathCost: 8,
  targetStickiness: 84.1796,
  stuckSeconds: 0.5,
  stuckDistance: 7,         // 这段时间内位移不足此值即判定卡死，单位：像素。
  fireCloseRange: 127.022,      // 这个距离内开火门限封顶为 closeNeed。
  closeNeed: 0.6683,
  lastShotOdds: 0.5578,        // 打出最后一发所需的命中估计：打空要裸奔到弹体消失。
  evadeFaceReload: 1.0514,     // 下一发还要等这么久时，逃跑不再要求炮口朝向对手。
  boredDistance: 14,        // 1 秒内位移不足此值且未开火，视为模式活锁。
  boredHunt: 1.2,           // 活锁后强制追击的时长，单位：秒。
  unstickSeconds: 0.4,
  softBudgetMs: 6,
  keepAway: 109.4938,            // 敌人有弹时保持的车心距离；瞬杀圈约 58。
  keepAwayWeight: 10.1387,
  zoneCost: 269.1974,            // 进入有弹敌人瞬杀圈的代价。
  zoneRadius: 66.041,
  chargeRange: 51.5098,          // 对手没弹时冲到此距离。
  duelRange: 253.7161,           // 这个距离内有射击解就优先转身开火，而不是逃。
  duelTime: 1.1553,            // 转向加飞行不超过此秒数才算对决。
  duelThreatScale: 0.0934,    // 对决时炮口线与瞬杀圈的代价折扣；真实来弹不打折。
  duelAimWeight: 68.9858,
  lastShotRange: 70.1767,        // 最后一发只在此距离内用：飞行不足 8 Tick，对手来不及躲。
  reserveBullets: 1,
  escapeAt: 12,             // 沿候选走到这一步再分支检查退路（步）。
  escapeCost: 148.0767,          // 退路被来弹封死的代价。
  shotEscapeCost: 65.8567,       // 对手此刻朝我开火时躲不掉的代价。
  duelEscapeScale: 0.5411,     // 对决时对“躲不掉对手下一枪”的折扣。
};

const STEP_TICKS = 2;       // 轨迹采样粒度：1 步 = 2 Tick。
const HORIZON = 36;         // 威胁视野：36 步 = 1.2 秒。
const SHOT_STEPS = 90;      // 开火评估的最长飞行：90 步 = 3 秒。
const PRED_STEPS = 120;     // 敌人轨迹预测长度：120 步 = 4 秒。
const AIM_SAMPLE_TICKS = 4;
const AIM_SAMPLES = 40;     // 瞄准搜索看 40 × 4 Tick。
const LASER_STEPS = 15;     // 敌方激光威胁只看近 0.5 秒。
const LAG_TICKS = 30;       // 预测器对答案的延迟。
const LAG_STEPS = LAG_TICKS / STEP_TICKS;
const CALIBRATE_TICKS = 16; // 弹道校准周期，对应采样下标 7。
const TRAIL_TICKS = 64;
const BORED_TICKS = 60;
const EXPERT_COUNT = 5;
const MAX_TRACKED = 4;
const MAX_THREATS = 48;
const MAX_CANDIDATES = 128;
const MAX_PELLETS = 4;
const MAX_LASER_SEGMENTS = 40;

// 敌人的闪避动作库：[move, turn, 转向持续步数]。
const MANEUVERS = [
  [1, 0, 0], [-1, 0, 0], [0, 0, 0],
  [1, 1, 6], [1, -1, 6], [-1, 1, 6], [-1, -1, 6],
  [1, 1, 12], [1, -1, 12], [-1, 1, 12], [-1, -1, 12],
];
const WEAPON_RANK = { laser: 3, scatter: 2, mine: 1 };
// 退路分支：[move, turn, 转向持续步数, 之后的 move]。
const BRANCHES = [
  [1, 0, 0, 1], [-1, 0, 0, -1],
  [1, 1, 10, 1], [1, -1, 10, 1], [-1, 1, 10, -1], [-1, -1, 10, -1],
  [0, 1, 7, 1], [0, -1, 7, 1], [0, 1, 7, -1], [0, -1, 7, -1],
];

// 只记 ID 与数值，不保留某 Tick 的对象引用。
const mem = {
  scale: 1,
  tracks: new Map(),
  mines: new Map(),
  shots: [],
  pendingShot: null,
  margin: TUNE.baseMargin,
  modelError: 0,
  snapshot: null,
  targetId: null,
  lastCandidate: -1,
  contOn: false,
  contM1: 0,
  contT1: 0,
  contHold: 0,
  contM2: 0,
  lastMove: 0,
  stuckTime: 0,
  wantTicks: 0,
  lastFireTick: 0,
  huntUntil: -1,
  unstickUntil: -1,
  unstickMove: 0,
  pathEdge: -1,
  coverCell: -1,
};

const world = { S: 96, cols: 0, rows: 0, n: 0, hw: null, vw: null, penalty: null, edgeUntil: null,
  wallCount: -1, rect: null, seg: null, tankNear: null, bulletNear: null };
const queue = { items: null, inside: null };
let fieldMe = null, fieldTarget = null, fieldLoot = null, fieldTmp = null;
let directionDelta = [0, 0, 0, 0];

// 每 Tick 刷新的物理量。
let P = null, dt = 1 / 60, moveStep = 4, turnStep = 0.1, tankR = 16, tankR2 = 256;
let nowTick = 0, workScale = 1;

// 模拟器寄存器：避免在热路径里分配对象。
let sx = 0, sy = 0, sa = 0;
let bx = 0, by = 0, bvx = 0, bvy = 0, bulletBounced = false;
let touchD2 = 0, touchX = 0, touchY = 0;
let hitAxis = 0, segT = 0;
let cDepth = 0, cNx = 0, cNy = 0, cPx = 0, cPy = 0;
let bodyHX = 17, bodyHY = 16, barrelC = 22.75, barrelHX = 5.75, barrelHY = 2.5, inertia = 181.67, bodyReach = 31;
let steerMove = 0, steerTurn = 0;
const bounceAt = new Int32Array(8);
let bounceN = 0;

const thX = [], thY = [];
for (let i = 0; i < MAX_THREATS; i++) {
  thX.push(new Float64Array(HORIZON));
  thY.push(new Float64Array(HORIZON));
}
const thFrom = new Int32Array(MAX_THREATS), thTo = new Int32Array(MAX_THREATS);
const thVirtual = new Uint8Array(MAX_THREATS);
const thAge = new Float64Array(MAX_THREATS);
const thOwner = new Array(MAX_THREATS).fill(null);
let threatCount = 0;

const rollX = new Float64Array(MAX_CANDIDATES * HORIZON), rollY = new Float64Array(MAX_CANDIDATES * HORIZON);
const rollA = new Float64Array(MAX_CANDIDATES * HORIZON);
const candMove = new Float64Array(MAX_CANDIDATES), candTurn = new Float64Array(MAX_CANDIDATES);
const candEndAngle = new Float64Array(MAX_CANDIDATES), candCost = new Float64Array(MAX_CANDIDATES);
const candRisk = new Float64Array(MAX_CANDIDATES), candHit = new Int32Array(MAX_CANDIDATES);
let candCount = 0, candidatesReady = false;
const rankCost = new Float64Array(MAX_CANDIDATES), rankOrder = new Int32Array(MAX_CANDIDATES);
const specM1 = new Float64Array(MAX_CANDIDATES), specT1 = new Float64Array(MAX_CANDIDATES);
const specHold = new Float64Array(MAX_CANDIDATES), specM2 = new Float64Array(MAX_CANDIDATES);
const specKnown = new Uint8Array(MAX_CANDIDATES);
let contIndex = -1;

const shotX = [], shotY = [];
for (let i = 0; i < MAX_PELLETS; i++) {
  shotX.push(new Float64Array(SHOT_STEPS));
  shotY.push(new Float64Array(SHOT_STEPS));
}
const shotFrom = new Int32Array(MAX_PELLETS);
let shotPredicted = false, shotSteps = 0;

const rayX = new Float64Array(AIM_SAMPLES), rayY = new Float64Array(AIM_SAMPLES);
const laserX = new Float64Array(8), laserY = new Float64Array(8);
let laserSegs = new Float64Array(MAX_LASER_SEGMENTS * 5);
let laserSegCount = 0;
const laserFans = [];

const pathX = new Float64Array(10), pathY = new Float64Array(10);
const rawX = new Float64Array(10), rawY = new Float64Array(10);
let pathN = 0;

const trailX = new Float64Array(TRAIL_TICKS), trailY = new Float64Array(TRAIL_TICKS);
const mineHazards = [];
const zoneEnemies = [];
const trampleSpots = [];
let tracked = [];

const clock = typeof performance !== 'undefined' && performance.now
  ? () => performance.now()
  : typeof Date !== 'undefined' ? () => Date.now() : () => 0;

function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

// 把角差折回 [-π, π]，从最短方向转向；正值表示顺时针。
function wrap(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function urgency(state) {
  const limit = state.rules && state.rules.timeout;
  return limit > 0 ? clamp((state.time / limit - 0.6) / 0.4, 0, 1) : 0;
}

// ---------- 地图 ----------

function wallV(i, r) {
  return r >= 0 && r < world.rows && i >= 0 && i <= world.cols && world.vw[r * (world.cols + 1) + i] === 1;
}

function wallH(i, c) {
  return c >= 0 && c < world.cols && i >= 0 && i <= world.rows && world.hw[i * world.cols + c] === 1;
}

// cells 随破墙更新，是墙体的唯一来源；横墙按 y 线索引，竖墙按 x 线索引。
function buildWorld(map) {
  const cols = map.cols, rows = map.rows, n = cols * rows;
  world.S = map.cellSize;
  if (world.n !== n || world.cols !== cols) {
    world.cols = cols;
    world.rows = rows;
    world.n = n;
    world.hw = new Uint8Array((rows + 1) * cols);
    world.vw = new Uint8Array(rows * (cols + 1));
    world.penalty = new Float64Array(n);
    world.edgeUntil = new Int32Array(n * 4);
    queue.items = new Int32Array(n);
    queue.inside = new Uint8Array(n);
    fieldMe = new Float64Array(n);
    fieldTarget = new Float64Array(n);
    fieldLoot = new Float64Array(n);
    fieldTmp = new Float64Array(n);
    directionDelta = [-cols, 1, cols, -1];
  }
  world.hw.fill(0);
  world.vw.fill(0);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = map.cells[r][c];
      if (cell.top) world.hw[r * cols + c] = 1;
      if (cell.bottom) world.hw[(r + 1) * cols + c] = 1;
      if (cell.left) world.vw[r * (cols + 1) + c] = 1;
      if (cell.right) world.vw[r * (cols + 1) + c + 1] = 1;
    }
  }
}

// 车体接触用有厚度的墙矩形（圆头近似为沿长度外扩半厚度），炮弹用中心线；逐格邻近表保持引擎的墙序。
function buildContacts(map) {
  const walls = map.walls, count = walls.length;
  if (count === world.wallCount) return;
  world.wallCount = count;
  world.rect = new Float64Array(count * 4);
  world.seg = new Float64Array(count * 4);
  for (let i = 0; i < count; i++) {
    const w = walls[i], h = (w.border ? P.borderWallThickness : P.wallThickness) / 2;
    const x0 = Math.min(w.x1, w.x2) - h, x1 = Math.max(w.x1, w.x2) + h, y0 = Math.min(w.y1, w.y2) - h, y1 = Math.max(w.y1, w.y2) + h;
    world.rect[i * 4] = (x0 + x1) / 2;
    world.rect[i * 4 + 1] = (y0 + y1) / 2;
    world.rect[i * 4 + 2] = (x1 - x0) / 2;
    world.rect[i * 4 + 3] = (y1 - y0) / 2;
    world.seg[i * 4] = w.x1;
    world.seg[i * 4 + 1] = w.y1;
    world.seg[i * 4 + 2] = w.x2;
    world.seg[i * 4 + 3] = w.y2;
  }
  const S = world.S;
  world.tankNear = [];
  world.bulletNear = [];
  for (let cell = 0; cell < world.n; cell++) {
    const c = cell % world.cols, r = (cell - c) / world.cols, tank = [], bullet = [];
    const px = (c + 0.5) * S, py = (r + 0.5) * S;
    for (let i = 0; i < count; i++) {
      const gx = Math.max(0, Math.abs(px - world.rect[i * 4]) - world.rect[i * 4 + 2] - S / 2);
      const gy = Math.max(0, Math.abs(py - world.rect[i * 4 + 1]) - world.rect[i * 4 + 3] - S / 2);
      const gap = Math.hypot(gx, gy);
      if (gap < bodyReach + 2) tank.push(i);
      if (gap < 12) bullet.push(i);
    }
    world.tankNear.push(Int32Array.from(tank));
    world.bulletNear.push(Int32Array.from(bullet));
  }
}

function cellIndex(x, y) {
  const c = clamp(Math.floor(x / world.S), 0, world.cols - 1);
  const r = clamp(Math.floor(y / world.S), 0, world.rows - 1);
  return r * world.cols + c;
}

function centerX(cell) {
  return (cell % world.cols + 0.5) * world.S;
}

function centerY(cell) {
  return (Math.floor(cell / world.cols) + 0.5) * world.S;
}

// 方向 d：0 上、1 右、2 下、3 左。
function isOpen(c, r, d) {
  if (d === 0) return r > 0 && !wallH(r, c);
  if (d === 1) return c < world.cols - 1 && !wallV(c + 1, r);
  if (d === 2) return r < world.rows - 1 && !wallH(r + 1, c);
  return c > 0 && !wallV(c, r);
}

// 从 src 向外松弛出到各格的路程（单位：格），地雷格和受阻边额外加价。
function flood(src, out) {
  const n = world.n, cols = world.cols, items = queue.items, inside = queue.inside;
  out.fill(Infinity);
  inside.fill(0);
  out[src] = 0;
  items[0] = src;
  inside[src] = 1;
  let head = 0, tail = 1 % n, size = 1;
  while (size > 0) {
    const u = items[head];
    head = (head + 1) % n;
    size--;
    inside[u] = 0;
    const c = u % cols, r = (u - c) / cols;
    for (let d = 0; d < 4; d++) {
      if (!isOpen(c, r, d)) continue;
      const v = u + directionDelta[d];
      const cost = out[u] + 1 + world.penalty[v] + (world.edgeUntil[u * 4 + d] > nowTick ? TUNE.blockedEdgeCost : 0);
      if (cost < out[v]) {
        out[v] = cost;
        if (!inside[v]) {
          items[tail] = v;
          tail = (tail + 1) % n;
          size++;
          inside[v] = 1;
        }
      }
    }
  }
}

function lowestNeighbor(field, cell) {
  const c = cell % world.cols, r = (cell - c) / world.cols;
  let best = -1, bestValue = field[cell];
  for (let d = 0; d < 4; d++) {
    if (!isOpen(c, r, d)) continue;
    const v = cell + directionDelta[d];
    if (field[v] < bestValue) {
      bestValue = field[v];
      best = d;
    }
  }
  return best;
}

function goalDist(field, goalX, goalY, x, y) {
  const cell = cellIndex(x, y);
  if (!(field[cell] < Infinity)) return Math.hypot(goalX - x, goalY - y) + world.S * 4;
  const d = lowestNeighbor(field, cell);
  if (d < 0) return Math.hypot(goalX - x, goalY - y);
  const next = cell + directionDelta[d];
  return field[next] * world.S + Math.hypot(centerX(next) - x, centerY(next) - y);
}

function clearSegment(x0, y0, x1, y1, radius) {
  const dx = x1 - x0, dy = y1 - y0, length = Math.hypot(dx, dy);
  if (length < 1) return true;
  return castRay(x0, y0, dx / length, dy / length, radius, length) >= length - 1e-6;
}

// 沿路程场下降取格子中心作路径，再拉直：直接走向仍有车体余量的最远点。
function buildPath(field, goalX, goalY, x, y) {
  const start = cellIndex(x, y);
  let cell = start, count = 0;
  mem.pathEdge = -1;
  while (field[cell] > 0 && count < 8) {
    const d = lowestNeighbor(field, cell);
    if (d < 0) break;
    if (cell === start) mem.pathEdge = cell * 4 + d;
    cell += directionDelta[d];
    rawX[count] = centerX(cell);
    rawY[count] = centerY(cell);
    count++;
  }
  if (field[cell] === 0 || count === 0) {
    rawX[count] = goalX;
    rawY[count] = goalY;
    count++;
  }
  let first = 0;
  for (let i = count - 1; i > 0; i--) {
    if (clearSegment(x, y, rawX[i], rawY[i], tankR + 2)) {
      first = i;
      break;
    }
  }
  pathN = 0;
  for (let i = first; i < count; i++) {
    pathX[pathN] = rawX[i];
    pathY[pathN] = rawY[i];
    pathN++;
  }
}

// ---------- 几何与运动模型 ----------

// 从 (x,y) 沿单位向量前进，返回触到“外扩 r 的墙”前的距离。
// hitAxis：0 未碰，1 竖墙，2 横墙，3 角落同时反射。
function castRay(x, y, dx, dy, r, maxLen) {
  const S = world.S;
  let best = maxLen;
  hitAxis = 0;
  if (dx > 1e-9 || dx < -1e-9) {
    const dir = dx > 0 ? 1 : -1;
    for (let i = dx > 0 ? Math.floor(x / S) + 1 : Math.ceil(x / S) - 1; i >= 0 && i <= world.cols; i += dir) {
      let t = (i * S - dir * r - x) / dx;
      if (t >= best) break;
      if (t < 0) t = 0;
      const yy = y + dy * t;
      if (wallV(i, Math.floor(yy / S)) || wallV(i, Math.floor((yy - r) / S)) || wallV(i, Math.floor((yy + r) / S))) {
        best = t;
        hitAxis = 1;
        break;
      }
    }
  }
  if (dy > 1e-9 || dy < -1e-9) {
    const dir = dy > 0 ? 1 : -1;
    for (let i = dy > 0 ? Math.floor(y / S) + 1 : Math.ceil(y / S) - 1; i >= 0 && i <= world.rows; i += dir) {
      let t = (i * S - dir * r - y) / dy;
      if (t > best + 1e-6) break;
      if (t < 0) t = 0;
      const xx = x + dx * t;
      if (wallH(i, Math.floor(xx / S)) || wallH(i, Math.floor((xx - r) / S)) || wallH(i, Math.floor((xx + r) / S))) {
        if (hitAxis === 1 && Math.abs(t - best) <= 1e-6) hitAxis = 3;
        else if (t < best) {
          best = t;
          hitAxis = 2;
        }
        break;
      }
    }
  }
  return best;
}

// 单 Tick 弹体：与引擎同序逐墙检测，圆心距中心线不足半径时推出并沿法线反射。
function stepBullet() {
  const S = world.S, radius = P.bulletRadius, limit = radius * radius, seg = world.seg;
  bx += bvx * dt;
  by += bvy * dt;
  bulletBounced = false;
  const c = Math.floor(bx / S), r = Math.floor(by / S), lx = bx - c * S, ly = by - r * S;
  if (lx >= radius && lx <= S - radius && ly >= radius && ly <= S - radius) return;
  const list = world.bulletNear[clamp(r, 0, world.rows - 1) * world.cols + clamp(c, 0, world.cols - 1)];
  for (let i = 0; i < list.length; i++) {
    const w = list[i] * 4, x1 = seg[w], y1 = seg[w + 1], ex = seg[w + 2] - x1, ey = seg[w + 3] - y1;
    const len2 = ex * ex + ey * ey;
    let t = len2 > 0 ? ((bx - x1) * ex + (by - y1) * ey) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    let nx = bx - (x1 + t * ex), ny = by - (y1 + t * ey);
    const d2 = nx * nx + ny * ny;
    if (d2 >= limit) continue;
    const d = Math.sqrt(d2);
    if (d === 0) {
      const len = Math.sqrt(len2) || 1;
      nx = -ey / len;
      ny = ex / len;
      bx += nx * radius;
      by += ny * radius;
    } else {
      nx /= d;
      ny /= d;
      bx += nx * (radius - d);
      by += ny * (radius - d);
    }
    const vn = bvx * nx + bvy * ny;
    bvx -= 2 * vn * nx;
    bvy -= 2 * vn * ny;
    bulletBounced = true;
  }
}

// 逐 Tick 外推弹道，每 stride Tick 记一个采样；bounceAt 记录每次反弹落在哪个采样下标。
function tracePath(x, y, vx, vy, stride, samples, outX, outY) {
  bx = x;
  by = y;
  bvx = vx;
  bvy = vy;
  bounceN = 0;
  const S = world.S, low = P.bulletRadius, high = S - low, span = dt * stride;
  for (let k = 0; k < samples; k++) {
    const lx = bx - Math.floor(bx / S) * S, ly = by - Math.floor(by / S) * S, fx = lx + bvx * span, fy = ly + bvy * span;
    if (lx >= low && lx <= high && ly >= low && ly <= high && fx >= low && fx <= high && fy >= low && fy <= high) {
      bx += bvx * span;
      by += bvy * span;
    } else {
      for (let t = 0; t < stride; t++) {
        stepBullet();
        if (bulletBounced) {
          if (bounceN < bounceAt.length) bounceAt[bounceN] = k;
          bounceN++;
        }
      }
    }
    outX[k] = bx;
    outY[k] = by;
  }
}

function firstBounce(steps) {
  return bounceN > 0 ? bounceAt[0] : steps;
}

// 激光从炮口出发，正好在墙线上反射（日志实测）。
function traceLaser(x, y, angle) {
  let dx = Math.cos(angle), dy = Math.sin(angle), remaining = P.laser.maxLength, n = 1;
  const out = muzzleDistance(x, y, dx, dy);
  x += dx * out;
  y += dy * out;
  laserX[0] = x;
  laserY[0] = y;
  for (let bounce = 0; bounce <= P.laser.maxBounces && n < laserX.length; bounce++) {
    const length = castRay(x, y, dx, dy, 1e-3, remaining);
    const axis = hitAxis;
    x += dx * length;
    y += dy * length;
    laserX[n] = x;
    laserY[n] = y;
    n++;
    remaining -= length;
    if (axis === 0 || remaining <= 0) break;
    if (axis & 1) dx = -dx;
    if (axis & 2) dy = -dy;
  }
  return n;
}

// 返回点到线段距离的平方；segT 为最近点沿线段的比例。
function segDist2(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, length2 = dx * dx + dy * dy;
  segT = length2 > 0 ? clamp(((px - x1) * dx + (py - y1) * dy) / length2, 0, 1) : 0;
  const ex = x1 + dx * segT - px, ey = y1 + dy * segT - py;
  return ex * ex + ey * ey;
}

// OBB 对墙矩形的分离轴检测，记录全局最深接触（法线指向车体）。
function contact(cx, cy, ux, uy, hx, hy, q) {
  const R = world.rect, qx = R[q], qy = R[q + 1], ex = R[q + 2], ey = R[q + 3];
  const vx = -uy, vy = ux, dx = cx - qx, dy = cy - qy;
  const ax = ux < 0 ? -ux : ux, ay = uy < 0 ? -uy : uy;
  const ox = ex + ax * hx + ay * hy - (dx < 0 ? -dx : dx);
  if (ox <= 0) return;
  const oy = ey + ay * hx + ax * hy - (dy < 0 ? -dy : dy);
  if (oy <= 0) return;
  const du = dx * ux + dy * uy, dv = dx * vx + dy * vy;
  const ou = hx + ex * ax + ey * ay - (du < 0 ? -du : du);
  if (ou <= 0) return;
  const ov = hy + ex * ay + ey * ax - (dv < 0 ? -dv : dv);
  if (ov <= 0) return;
  let m = ox, tx = dx >= 0 ? 1 : -1, ty = 0, face = false;
  if (oy < m) {
    m = oy;
    tx = 0;
    ty = dy >= 0 ? 1 : -1;
  }
  if (ou < m) {
    m = ou;
    const sign = du >= 0 ? 1 : -1;
    tx = ux * sign;
    ty = uy * sign;
    face = true;
  }
  if (ov < m) {
    m = ov;
    const sign = dv >= 0 ? 1 : -1;
    tx = vx * sign;
    ty = vy * sign;
    face = true;
  }
  if (m <= cDepth) return;
  cDepth = m;
  cNx = tx;
  cNy = ty;
  if (face) {
    // 法线来自车体面：接触点是墙矩形朝车的角。
    cPx = qx + (tx > 0 ? ex : -ex);
    cPy = qy + (ty > 0 ? ey : -ey);
  } else {
    // 法线来自墙面：接触点是车体最深的顶点，几乎平贴时取两顶点中点。
    const su = ux * tx + uy * ty, sv = vx * tx + vy * ty;
    const a = (su < 0 ? -su : su) * hx < 0.6 ? 0 : su > 0 ? -1 : 1;
    const b = (sv < 0 ? -sv : sv) * hy < 0.6 ? 0 : sv > 0 ? -1 : 1;
    cPx = cx + ux * hx * a + vx * hy * b;
    cPy = cy + uy * hx * a + vy * hy * b;
  }
}

// 位置级接触解算：等效 Box2D 的法向冲量，偏心接触同时产生平移和转动。
function resolveBody() {
  const S = world.S, near = world.tankNear, R = world.rect;
  for (let pass = 0; pass < 3; pass++) {
    const c = clamp(Math.floor(sx / S), 0, world.cols - 1), r = clamp(Math.floor(sy / S), 0, world.rows - 1);
    const list = near[r * world.cols + c];
    const ux = Math.cos(sa), uy = Math.sin(sa), tipX = sx + ux * barrelC, tipY = sy + uy * barrelC;
    const ax = ux < 0 ? -ux : ux, ay = uy < 0 ? -uy : uy;
    const reachX = ax * bodyHX + ay * bodyHY, reachY = ay * bodyHX + ax * bodyHY;
    const tipReachX = ax * barrelHX + ay * barrelHY, tipReachY = ay * barrelHX + ax * barrelHY;
    cDepth = 0;
    for (let i = 0; i < list.length; i++) {
      const q = list[i] * 4, qx = R[q], qy = R[q + 1], ex = R[q + 2], ey = R[q + 3];
      const gx = sx - qx, gy = sy - qy, hx = tipX - qx, hy = tipY - qy;
      if ((gx < 0 ? -gx : gx) < ex + reachX && (gy < 0 ? -gy : gy) < ey + reachY) contact(sx, sy, ux, uy, bodyHX, bodyHY, q);
      if ((hx < 0 ? -hx : hx) < ex + tipReachX && (hy < 0 ? -hy : hy) < ey + tipReachY) contact(tipX, tipY, ux, uy, barrelHX, barrelHY, q);
    }
    if (cDepth <= 0.02) return;
    const rn = (cPx - sx) * cNy - (cPy - sy) * cNx, lambda = cDepth / (1 + rn * rn / inertia);
    sx += cNx * lambda;
    sy += cNy * lambda;
    sa += rn * lambda / inertia;
  }
}

// 引擎顺序：线速度取本 Tick 开始时的朝向，位移与转向同时积分，再解接触。
function tickTank(move, turn) {
  const v = move * (move < 0 ? P.reverseSpeed : P.moveSpeed) * dt;
  sx += Math.cos(sa) * v;
  sy += Math.sin(sa) * v;
  sa += turn * P.turnSpeed * dt;
  resolveBody();
}

function stepCoarse(move, turn) {
  const v = move * (move < 0 ? P.reverseSpeed : P.moveSpeed) * dt * STEP_TICKS, spin = turn * P.turnSpeed * dt;
  const mid = sa + spin * (STEP_TICKS - 1) / 2;
  sx += Math.cos(mid) * v;
  sy += Math.sin(mid) * v;
  sa += spin * STEP_TICKS;
  resolveBody();
}

function stepTank(move, turn) {
  for (let t = 0; t < STEP_TICKS; t++) tickTank(move, turn);
}

function steer(targetX, targetY, quantum) {
  const distance = Math.hypot(targetX - sx, targetY - sy);
  let error = wrap(Math.atan2(targetY - sy, targetX - sx) - sa), direction = 1;
  if (Math.abs(error) > TUNE.reverseAngle) {
    direction = -1;
    error = wrap(error + Math.PI);
  }
  steerTurn = clamp(error / quantum, -1, 1);
  const size = Math.abs(error);
  const drive = size < 0.3 ? 1 : size < 0.8 ? 0.6 : size < 1.2 ? 0.25 : 0;
  steerMove = direction * drive * clamp(distance / moveStep, 0, 1);
}

// 炮口：常规偏移；车心到炮口之间有墙时，沿炮管压回到墙前 bulletRadius+1。
function muzzleDistance(x, y, dx, dy) {
  const toWall = castRay(x, y, dx, dy, 1e-3, P.muzzleOffset);
  return toWall < P.muzzleOffset ? toWall - P.bulletRadius - 1 : P.muzzleOffset;
}

// ---------- 观测与局内学习 ----------

function newTrack(enemy) {
  return {
    angle: enemy.angle,
    omega: 0,
    speed: 0,
    err: Float64Array.from([20, 18, 16, 19, 21]),
    pending: new Float64Array(LAG_TICKS * EXPERT_COUNT * 2),
    filled: new Uint8Array(LAG_TICKS),
    px: new Float64Array(PRED_STEPS),
    py: new Float64Array(PRED_STEPS),
    predicted: false,
    dodge: TUNE.dodgePrior,
  };
}

function learnEnemies(state) {
  const slot = state.tick % LAG_TICKS;
  for (const enemy of state.enemies) {
    let track = mem.tracks.get(enemy.id);
    if (!track) {
      track = newTrack(enemy);
      mem.tracks.set(enemy.id, track);
    }
    track.predicted = false;
    if (!enemy.alive) continue;
    track.omega += (wrap(enemy.angle - track.angle) / dt - track.omega) * 0.3;
    track.angle = enemy.angle;
    track.speed = enemy.vx * Math.cos(enemy.angle) + enemy.vy * Math.sin(enemy.angle);
    track.dodge += (TUNE.dodgePrior - track.dodge) * TUNE.dodgeForget;
    // 把 LAG_TICKS 前各预测器写下的答案拿出来批改。
    if (track.filled[slot]) {
      const base = slot * EXPERT_COUNT * 2;
      for (let i = 0; i < EXPERT_COUNT; i++) {
        const miss = Math.hypot(track.pending[base + i * 2] - enemy.x, track.pending[base + i * 2 + 1] - enemy.y);
        track.err[i] += (miss - track.err[i]) * 0.04;
      }
    }
  }
}

function settleShots(state) {
  const me = state.self;
  // 冷却被重置才算真的开了火；失败的尝试不入账。
  if (mem.pendingShot) {
    if (me.cooldown > P.fireCooldown * 0.5) mem.shots.push(mem.pendingShot);
    mem.pendingShot = null;
  }
  for (let i = mem.shots.length - 1; i >= 0; i--) {
    const shot = mem.shots[i];
    const enemy = state.enemies.find(item => item.id === shot.targetId);
    const track = mem.tracks.get(shot.targetId);
    const landed = !enemy || !enemy.alive || (shot.shielded && !enemy.shield);
    if (!landed && state.tick < shot.dueTick) continue;
    if (track && shot.predicted) {
      track.dodge += ((landed ? 0 : 1) - track.dodge) * TUNE.dodgeLearn;
    }
    mem.shots.splice(i, 1);
  }
}

function calibrateBullets(state) {
  if (state.tick % CALIBRATE_TICKS !== 0 || !mem.snapshot) return;
  for (const bullet of state.bullets) {
    const predicted = mem.snapshot.get(bullet.id);
    if (!predicted) continue;
    mem.modelError += (Math.hypot(predicted[0] - bullet.x, predicted[1] - bullet.y) - mem.modelError) * 0.1;
  }
  mem.margin = clamp(TUNE.baseMargin + mem.modelError * 1.2, TUNE.baseMargin, TUNE.maxMargin);
}

// 看实际位移而不是速度指令：炮管顶住墙角时 move 会在小值间抖动，速度阈值累积不起来。
function detectStuck(state) {
  const me = state.self, slot = state.tick % TRAIL_TICKS;
  const window = Math.round(TUNE.stuckSeconds / dt);
  const old = (state.tick - Math.min(window, TRAIL_TICKS - 1) + TRAIL_TICKS * 4) % TRAIL_TICKS;
  const moved = Math.hypot(me.x - trailX[old], me.y - trailY[old]);
  const second = (state.tick - BORED_TICKS + TRAIL_TICKS * 4) % TRAIL_TICKS;
  const roamed = Math.hypot(me.x - trailX[second], me.y - trailY[second]);
  if (me.cooldown > 0) mem.lastFireTick = state.tick;
  // 瞄准与追击可能互相否定：在原地抖动却一枪不开。
  if (state.tick > BORED_TICKS && roamed < TUNE.boredDistance && state.tick - mem.lastFireTick > BORED_TICKS && state.time >= mem.huntUntil) {
    mem.huntUntil = state.time + TUNE.boredHunt;
  }
  trailX[slot] = me.x;
  trailY[slot] = me.y;
  mem.wantTicks = Math.abs(mem.lastMove) > 0.05 ? mem.wantTicks + 1 : 0;
  if (mem.wantTicks < window || moved >= TUNE.stuckDistance) return;
  mem.wantTicks = 0;
  mem.unstickUntil = state.time + TUNE.unstickSeconds;
  mem.unstickMove = mem.lastMove > 0 ? -1 : 1;
  if (mem.pathEdge >= 0) {
    const cell = mem.pathEdge >> 2, d = mem.pathEdge & 3;
    const expires = state.tick + Math.round(3 / dt);
    world.edgeUntil[mem.pathEdge] = expires;
    world.edgeUntil[(cell + directionDelta[d]) * 4 + ((d + 2) & 3)] = expires;
  }
}

// 记住已见地雷：过了渐隐时刻才从列表消失的是隐形雷，提前消失的是炸了。
function trackMines(state) {
  const mine = P.mine, fadeAt = mine.armDelay + mine.visibleTime + mine.fadeTime;
  for (const view of state.mines) {
    let record = mem.mines.get(view.id);
    if (!record) {
      record = { x: view.x, y: view.y, bornTick: state.tick - Math.round(view.age / dt), seenTick: 0, hidden: false };
      mem.mines.set(view.id, record);
    }
    record.seenTick = state.tick;
    record.hidden = false;
  }
  for (const [id, record] of mem.mines) {
    if (record.seenTick === state.tick) continue;
    if (!record.hidden) {
      if ((state.tick - record.bornTick) * dt < fadeAt - 0.1) {
        mem.mines.delete(id);
        continue;
      }
      record.hidden = true;
    }
    // 隐形雷已布防，活坦克走进触发圈却仍活着，说明它早已不在了。
    const reach = mine.triggerRadius - 2;
    const walked = tank => tank.alive && Math.hypot(tank.x - record.x, tank.y - record.y) < reach;
    if (walked(state.self) || state.enemies.some(walked)) mem.mines.delete(id);
  }
}

function buildMineHazards(state) {
  const mine = P.mine, stepTime = dt * STEP_TICKS;
  mineHazards.length = 0;
  world.penalty.fill(0);
  for (const record of mem.mines.values()) {
    const armIn = mine.armDelay - (state.tick - record.bornTick) * dt;
    const contested = state.enemies.some(enemy => enemy.alive
      && Math.hypot(enemy.x - record.x, enemy.y - record.y) < mine.triggerRadius + 40);
    const trigger = mine.triggerRadius + 2, blast = contested ? mine.blastRadius + 2 : 0;
    mineHazards.push({
      x: record.x, y: record.y, armStep: Math.max(0, Math.ceil(armIn / stepTime)),
      trigger2: trigger * trigger, blast2: blast * blast,
    });
    const home = cellIndex(record.x, record.y), c0 = home % world.cols, r0 = (home - c0) / world.cols;
    for (let r = Math.max(0, r0 - 1); r <= Math.min(world.rows - 1, r0 + 1); r++) {
      for (let c = Math.max(0, c0 - 1); c <= Math.min(world.cols - 1, c0 + 1); c++) {
        const cell = r * world.cols + c;
        if (Math.hypot(centerX(cell) - record.x, centerY(cell) - record.y) < mine.triggerRadius + 12) {
          world.penalty[cell] += TUNE.minePathCost;
        }
      }
    }
  }
}

function pickTarget(state) {
  const me = state.self;
  let best = null, bestScore = Infinity;
  for (const enemy of state.enemies) {
    if (!enemy.alive) continue;
    const steps = fieldMe[cellIndex(enemy.x, enemy.y)];
    let score = (steps < Infinity ? steps * world.S : 1500) + Math.hypot(enemy.x - me.x, enemy.y - me.y) * 0.5;
    if (enemy.id === mem.targetId) score -= TUNE.targetStickiness;
    if (enemy.shield) score += 150;
    if (score < bestScore) {
      bestScore = score;
      best = enemy;
    }
  }
  mem.targetId = best ? best.id : null;
  return best;
}

// 预测器沿最短路逼近“我”，用 fieldMe 下降，不受转向约束。
function chaseStep(meX, meY) {
  const cell = cellIndex(sx, sy);
  const d = fieldMe[cell] > 0 ? lowestNeighbor(fieldMe, cell) : -1;
  let goalX = meX, goalY = meY;
  if (d >= 0) {
    goalX = centerX(cell + directionDelta[d]);
    goalY = centerY(cell + directionDelta[d]);
  }
  const dx = goalX - sx, dy = goalY - sy, distance = Math.hypot(dx, dy);
  if (distance < moveStep || (d < 0 && distance < tankR * 2.5)) return;
  sx += dx / distance * moveStep;
  sy += dy / distance * moveStep;
  resolveBody();
}

// 五种预测器：静止 / 匀速 / 匀角速度 / 减速 / 追击。
function runExpert(enemy, track, expert, steps, outX, outY, meX, meY) {
  const h = dt * STEP_TICKS;
  let vx = enemy.vx, vy = enemy.vy;
  sx = enemy.x;
  sy = enemy.y;
  sa = enemy.angle;
  for (let k = 0; k < steps; k++) {
    if (expert === 1) {
      sx += vx * h;
      sy += vy * h;
      resolveBody();
    } else if (expert === 2) {
      sa += track.omega * h;
      sx += Math.cos(sa) * track.speed * h;
      sy += Math.sin(sa) * track.speed * h;
      resolveBody();
    } else if (expert === 3) {
      vx *= 0.9;
      vy *= 0.9;
      sx += vx * h;
      sy += vy * h;
      resolveBody();
    } else if (expert === 4) {
      chaseStep(meX, meY);
    }
    if (outX) {
      outX[k] = sx;
      outY[k] = sy;
    }
  }
}

function predictEnemies(state, target) {
  const me = state.self;
  const alive = state.enemies.filter(enemy => enemy.alive);
  alive.sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y));
  tracked = target ? [target] : [];
  const limit = workScale < 0.5 ? 2 : MAX_TRACKED;
  for (const enemy of alive) {
    if (tracked.length >= limit) break;
    if (enemy !== target) tracked.push(enemy);
  }
  const slot = state.tick % LAG_TICKS, base = slot * EXPERT_COUNT * 2;
  for (const enemy of tracked) {
    const track = mem.tracks.get(enemy.id);
    let best = 0;
    for (let i = 0; i < EXPERT_COUNT; i++) {
      runExpert(enemy, track, i, LAG_STEPS, null, null, me.x, me.y);
      track.pending[base + i * 2] = sx;
      track.pending[base + i * 2 + 1] = sy;
      if (track.err[i] < track.err[best]) best = i;
    }
    track.filled[slot] = 1;
    runExpert(enemy, track, best, PRED_STEPS, track.px, track.py, me.x, me.y);
    track.predicted = true;
  }
}

// ---------- 威胁表 ----------

function addRealBullet(bullet, me) {
  const j = threatCount++, stepTime = dt * STEP_TICKS;
  tracePath(bullet.x, bullet.y, bullet.vx, bullet.vy, STEP_TICKS, HORIZON, thX[j], thY[j]);
  thFrom[j] = 0;
  thTo[j] = clamp(Math.floor((P.bulletLifetime - bullet.age) / stepTime), 0, HORIZON);
  thVirtual[j] = 0;
  thAge[j] = bullet.age;
  thOwner[j] = bullet.ownerId;
  // 自己未反弹且 age 未到豁免时长的弹不伤自己，一反弹立即解除。
  if (bullet.ownerId === me.id && bullet.bounces === 0 && bullet.age < P.selfHitGrace) {
    thFrom[j] = Math.min(firstBounce(HORIZON), Math.ceil((P.selfHitGrace - bullet.age) / stepTime));
  }
}

function addVirtualShot(enemy, angle) {
  if (threatCount >= MAX_THREATS) return;
  const j = threatCount++, dx = Math.cos(angle), dy = Math.sin(angle);
  const out = muzzleDistance(enemy.x, enemy.y, dx, dy);
  tracePath(enemy.x + dx * out, enemy.y + dy * out, dx * P.bulletSpeed, dy * P.bulletSpeed, STEP_TICKS, HORIZON, thX[j], thY[j]);
  thFrom[j] = 0;
  thTo[j] = HORIZON;
  thVirtual[j] = 1;
  thOwner[j] = enemy.id;
}

function addLaserFan(enemy) {
  const from = laserSegCount;
  const fan = [0, 1, 0.12, 0.7, -0.12, 0.7, 0.3, 0.4, -0.3, 0.4];
  for (let f = 0; f < fan.length; f += 2) {
    const n = traceLaser(enemy.x, enemy.y, enemy.angle + fan[f]);
    for (let i = 0; i + 1 < n && laserSegCount < laserSegs.length / 5; i++) {
      const base = laserSegCount++ * 5;
      laserSegs[base] = laserX[i];
      laserSegs[base + 1] = laserY[i];
      laserSegs[base + 2] = laserX[i + 1];
      laserSegs[base + 3] = laserY[i + 1];
      laserSegs[base + 4] = fan[f + 1];
    }
  }
  laserFans.push({ enemy, from, to: laserSegCount, ready: Math.max(0, Math.floor((enemy.cooldown - dt) / (dt * STEP_TICKS))) });
}

function buildThreats(state) {
  const me = state.self;
  const horizonTime = HORIZON * STEP_TICKS * dt;
  const reach = (P.bulletSpeed + P.moveSpeed) * horizonTime + tankR + P.bulletRadius;
  threatCount = 0;
  laserSegCount = 0;
  laserFans.length = 0;
  // 每个持激光敌人都有完整的五向反弹射线，后出现的敌人不被共享40段上限截掉。
  const laserCount = state.enemies.filter(enemy => enemy.alive && enemy.laserShots > 0).length;
  const laserCapacity = laserCount * 5 * Math.min(P.laser.maxBounces + 1, laserX.length - 1) * 5;
  if (laserSegs.length < laserCapacity) laserSegs = new Float64Array(laserCapacity);
  const near = state.bullets.filter(bullet => Math.hypot(bullet.x - me.x, bullet.y - me.y) < reach);
  if (near.length > MAX_THREATS - 8) {
    near.sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y));
    near.length = MAX_THREATS - 8;
  }
  const remember = state.tick % CALIBRATE_TICKS === 0;
  if (remember) mem.snapshot = new Map();
  for (const bullet of near) {
    addRealBullet(bullet, me);
    if (remember) mem.snapshot.set(bullet.id, [thX[threatCount - 1][7], thY[threatCount - 1][7]]);
  }
  zoneEnemies.length = 0;
  for (const enemy of state.enemies) {
    if (!enemy.alive) continue;
    if (armedWithin(enemy, state, 0.5)) zoneEnemies.push(enemy);
    if (enemy.laserShots > 0) {
      addLaserFan(enemy);
      continue;
    }
    if (enemy.cooldown > 0.3 || Math.hypot(enemy.x - me.x, enemy.y - me.y) > reach) continue;
    const track = mem.tracks.get(enemy.id);
    const lead = track ? clamp(track.omega, -P.turnSpeed, P.turnSpeed) * 0.1 : 0;
    if (enemy.scatterShots > 0) {
      for (let p = -1; p <= 1; p++) addVirtualShot(enemy, enemy.angle + lead + p * P.scatter.spreadAngle);
    } else if (enemy.bulletsActive < P.maxBullets) {
      addVirtualShot(enemy, enemy.angle + lead);
    }
  }
}

// ---------- 战术计划 ----------

// 对手在 horizon 秒内能否开火：弹数上限是公开的，普通弹满额时最早一颗消失才解禁。
function armedWithin(enemy, state, horizon) {
  if (enemy.laserShots > 0 || enemy.scatterShots > 0 || enemy.bulletsActive < P.maxBullets) return true;
  for (const bullet of state.bullets) {
    if (bullet.ownerId === enemy.id && P.bulletLifetime - bullet.age < horizon) return true;
  }
  return false;
}

function heldRank(me) {
  return me.laserShots > 0 ? 3 : me.scatterShots > 0 ? 2 : me.mineCharges > 0 ? 1 : 0;
}

function pickLoot(state) {
  const me = state.self, rank = heldRank(me);
  let best = null, bestScore = 0;
  trampleSpots.length = 0;
  for (const powerup of state.powerups) {
    const weapon = WEAPON_RANK[powerup.type] || 0;
    if (weapon > 0 && weapon < rank) {
      trampleSpots.push(powerup);
      continue;
    }
    if (powerup.type === 'shield' && me.shield && me.shieldTime > 2) continue;
    const cell = cellIndex(powerup.x, powerup.y), mine = fieldMe[cell];
    if (!(mine < Infinity) || mine > TUNE.lootRange) continue;
    flood(cell, fieldTmp);
    let rival = Infinity;
    for (const enemy of state.enemies) {
      if (enemy.alive) rival = Math.min(rival, fieldTmp[cellIndex(enemy.x, enemy.y)]);
    }
    const value = (TUNE.lootValue[powerup.type] || 0) * (rival + 0.5 < mine ? 0.25 : 1);
    const score = value / (mine + 1.5);
    if (score > bestScore) {
      bestScore = score;
      best = powerup;
      fieldLoot.set(fieldTmp);
    }
  }
  return best;
}

// 枚举炮口朝向，含跳弹，找到最快打到预测位置的方向。
// 射线以当前朝向为 0 号，无需转动的解自然排在最前。
function searchAim(me, track) {
  const count = Math.max(24, Math.round(TUNE.aimRays * workScale));
  const laser = me.laserShots > 0;
  const tolerance = laser ? tankR - 2 : tankR + P.bulletRadius - TUNE.aimTolerance;
  const tolerance2 = tolerance * tolerance;
  const selfR = tankR + P.bulletRadius + 2, self2 = selfR * selfR;
  const graceSamples = Math.ceil(P.selfHitGrace / (dt * AIM_SAMPLE_TICKS));
  const readyTicks = Math.ceil(me.cooldown / dt);
  let best = null, bestScore = 0;
  for (let i = 0; i < count; i++) {
    const relative = (i & 1 ? -1 : 1) * Math.ceil(i / 2) * (Math.PI * 2 / count);
    const angle = me.angle + relative;
    const waitTicks = Math.max(readyTicks, Math.ceil(Math.abs(relative) / (P.turnSpeed * dt)));
    const dx = Math.cos(angle), dy = Math.sin(angle);
    if (laser) {
      const index = clamp((waitTicks >> 1) - 1, 0, PRED_STEPS - 1);
      const tx = track.px[index], ty = track.py[index];
      const n = traceLaser(me.x, me.y, angle);
      for (let s = 0; s + 1 < n; s++) {
        if (s > 0 && segDist2(me.x, me.y, laserX[s], laserY[s], laserX[s + 1], laserY[s + 1]) < self2) break;
        if (segDist2(tx, ty, laserX[s], laserY[s], laserX[s + 1], laserY[s + 1]) < tolerance2) {
          const score = 1 / (0.15 + waitTicks * dt + 0.05 * s);
          if (score > bestScore) {
            bestScore = score;
            best = { angle, wait: waitTicks * dt, flight: 0 };
          }
          break;
        }
      }
      continue;
    }
    const out = muzzleDistance(me.x, me.y, dx, dy);
    tracePath(me.x + dx * out, me.y + dy * out, dx * P.bulletSpeed, dy * P.bulletSpeed, AIM_SAMPLE_TICKS, AIM_SAMPLES, rayX, rayY);
    const safeUntil = Math.min(firstBounce(AIM_SAMPLES), graceSamples);
    for (let k = 0; k < AIM_SAMPLES; k++) {
      const ticks = waitTicks + (k + 1) * AIM_SAMPLE_TICKS;
      const index = Math.min(PRED_STEPS - 1, (ticks >> 1) - 1);
      const ex = rayX[k] - track.px[index], ey = rayY[k] - track.py[index];
      if (ex * ex + ey * ey < tolerance2) {
        let bounces = 0;
        for (let b = 0; b < bounceN && b < bounceAt.length; b++) if (bounceAt[b] <= k) bounces++;
        const flight = (k + 1) * AIM_SAMPLE_TICKS * dt;
        const score = 1 / (0.15 + waitTicks * dt * 0.8 + flight + 0.25 * bounces);
        if (score > bestScore) {
          bestScore = score;
          best = { angle, wait: waitTicks * dt, flight };
        }
        break;
      }
      if (k >= safeUntil) {
        const mx = rayX[k] - me.x, my = rayY[k] - me.y;
        if (mx * mx + my * my < self2) break;
      }
    }
  }
  return best;
}

function followField(plan, field, goalX, goalY, me) {
  buildPath(field, goalX, goalY, me.x, me.y);
  plan.kind = 'path';
  plan.field = field;
  plan.goalX = goalX;
  plan.goalY = goalY;
  plan.startDist = goalDist(field, goalX, goalY, me.x, me.y);
}

// 没弹时逃：在自己先到的格子里选离对手路程最远、出口多的，等炮弹消失再打。
function planEvade(plan, me) {
  let best = -1, bestValue = -Infinity;
  for (let cell = 0; cell < world.n; cell++) {
    const mine = fieldMe[cell], theirs = fieldTarget[cell];
    if (!(mine <= 5) || !(theirs < Infinity) || mine >= theirs) continue;
    const c = cell % world.cols, r = (cell - c) / world.cols;
    let exits = 0;
    for (let e = 0; e < 4; e++) if (isOpen(c, r, e)) exits++;
    const value = theirs - mine * 0.3 + exits * 0.25;
    if (value > bestValue) {
      bestValue = value;
      best = cell;
    }
  }
  if (best < 0) best = cellIndex(me.x, me.y);
  flood(best, fieldLoot);
  followField(plan, fieldLoot, centerX(best), centerY(best), me);
  plan.mode = 'evade';
}

// 激光不是慢速弹：在公开冷却结束前争取墙后位置，保持目标格而非反复追逐瞬时炮口线。
function planLaserCover(state, plan) {
  const me = state.self;
  const lasers = state.enemies.filter(enemy => enemy.alive && enemy.laserShots > 0 &&
    enemy.cooldown < 1.2 && Math.hypot(enemy.x - me.x, enemy.y - me.y) < P.laser.maxLength &&
    clearSegment(enemy.x, enemy.y, me.x, me.y, 0));
  if (!lasers.length) { mem.coverCell = -1; return false; }
  function covered(cell) {
    const x = centerX(cell), y = centerY(cell);
    for (const enemy of lasers) {
      const gap = Math.hypot(x - enemy.x, y - enemy.y);
      const nx = -(y - enemy.y) / gap * (tankR + 2), ny = (x - enemy.x) / gap * (tankR + 2);
      if (clearSegment(enemy.x, enemy.y, x, y, 0) ||
          clearSegment(enemy.x, enemy.y, x + nx, y + ny, 0) ||
          clearSegment(enemy.x, enemy.y, x - nx, y - ny, 0)) return false;
    }
    return true;
  }
  let best = mem.coverCell;
  if (!(best >= 0 && fieldMe[best] <= 4 && covered(best))) {
    best = -1;
    let score = Infinity;
    for (let cell = 0; cell < world.n; cell++) {
      if (!(fieldMe[cell] <= 4) || !covered(cell)) continue;
      const distance = Math.hypot(centerX(cell) - me.x, centerY(cell) - me.y);
      const value = fieldMe[cell] * world.S + distance * 0.25;
      if (value < score) { score = value; best = cell; }
    }
  }
  mem.coverCell = best;
  if (best < 0) return false;
  flood(best, fieldLoot);
  followField(plan, fieldLoot, centerX(best), centerY(best), me);
  plan.mode = 'cover';
  // 瞄准仍交给开火判定；紧急位移不再为原对决的远期炮口朝向让路。
  plan.aimAngle = null;
  return true;
}

function makePlan(state, target) {
  const me = state.self;
  const plan = {
    kind: 'aim', mode: 'hold', move: 0, faceAngle: me.angle, aimAngle: null, aim: null,
    field: null, goalX: me.x, goalY: me.y, startDist: 0, keepAway: 0, keepX: 0, keepY: 0, charging: false, duel: false,
    foeSeen: false, foeX: 0, foeY: 0, targetId: target ? target.id : null,
  };
  pathN = 0;
  mem.pathEdge = -1;
  const armed = me.laserShots > 0 || me.scatterShots > 0 || me.bulletsActive < P.maxBullets;
  const track = target ? mem.tracks.get(target.id) : null;
  if (target) flood(cellIndex(target.x, target.y), fieldTarget);
  if (track && track.predicted) {
    plan.foeSeen = true;
    plan.foeX = track.px[5];
    plan.foeY = track.py[5];
  }
  const aim = target && track && track.predicted && armed ? searchAim(me, track) : null;
  const aimTime = aim ? aim.wait + aim.flight : Infinity;
  if (aim) {
    plan.aim = aim;
    plan.aimAngle = aim.angle;
  }
  const loot = pickLoot(state);
  if (planLaserCover(state, plan)) return plan;
  if (loot && aimTime > TUNE.quickShot && urgency(state) < 0.7) {
    followField(plan, fieldLoot, loot.x, loot.y, me);
    plan.mode = 'loot';
    return plan;
  }
  if (!target) return plan;
  const distance = Math.hypot(target.x - me.x, target.y - me.y);
  // 对手没弹且赶到之前不会解禁：冲到瞬杀圈内一枪解决。
  const enemyArmed = armedWithin(target, state, distance / P.moveSpeed + 0.3);
  plan.charging = !enemyArmed && armed;
  if (enemyArmed) {
    plan.keepAway = TUNE.keepAway;
    plan.keepX = target.x;
    plan.keepY = target.y;
  }
  if (!armed) {
    planEvade(plan, me);
    plan.aimAngle = reloadIn(me, state) < TUNE.evadeFaceReload ? Math.atan2(target.y - me.y, target.x - me.x) : null;
    return plan;
  }
  followField(plan, fieldTarget, target.x, target.y, me);
  plan.mode = plan.charging ? 'charge' : 'hunt';
  const reserveOnly = !plan.charging && me.laserShots === 0 && me.scatterShots === 0 && me.bulletsActive >= P.maxBullets - 1;
  plan.duel = !plan.charging && aimTime <= TUNE.duelTime && distance < TUNE.duelRange;
  const bored = state.time < mem.huntUntil;
  if (aimTime <= TUNE.aimCommit && !bored) {
    plan.kind = 'aim';
    plan.mode = plan.charging ? 'charge' : 'aim';
    plan.faceAngle = aim.angle;
    // 正对路线且还远时边靠近边校准，否则站定转向；敌人有弹且太近就倒车拉开，炮口不离开它。
    const heading = pathN > 0 ? Math.abs(wrap(Math.atan2(pathY[0] - me.y, pathX[0] - me.x) - me.angle)) : Math.PI;
    const closeTo = plan.charging ? TUNE.chargeRange : TUNE.closeRange;
    if (enemyArmed && distance < TUNE.keepAway) plan.move = -1;
    else plan.move = distance > closeTo && heading < 0.6 && !reserveOnly ? 1 : 0;
  } else if (reserveOnly && !bored) {
    // 只剩保命弹时不主动找人，原地朝向对手等待。
    plan.kind = 'aim';
    plan.mode = 'guard';
    plan.faceAngle = Math.atan2(target.y - me.y, target.x - me.x);
    plan.aimAngle = plan.faceAngle;
    plan.move = distance < TUNE.keepAway ? -1 : 0;
  }
  return plan;
}

function reloadIn(tank, state) {
  if (tank.bulletsActive < P.maxBullets) return Math.max(0, tank.cooldown);
  let wait = P.bulletLifetime;
  for (const bullet of state.bullets) {
    if (bullet.ownerId === tank.id) wait = Math.min(wait, P.bulletLifetime - bullet.age);
  }
  return wait;
}

// ---------- 候选轨迹 ----------

function objective(ci, plan) {
  const last = ci * HORIZON + HORIZON - 1;
  let value = 0;
  if (plan.field) {
    const end = goalDist(plan.field, plan.goalX, plan.goalY, rollX[last], rollY[last]);
    value += TUNE.progressWeight * (plan.mode === 'cover' ? 4 : 1) * (plan.startDist - end) / (HORIZON * moveStep);
  }
  if (plan.aimAngle !== null) {
    value -= (plan.duel ? TUNE.duelAimWeight : TUNE.aimWeight) * Math.abs(wrap(plan.aimAngle - candEndAngle[ci])) / Math.PI;
  }
  if (plan.keepAway > 0) {
    const gap = Math.hypot(rollX[last] - plan.keepX, rollY[last] - plan.keepY);
    if (gap < plan.keepAway) value -= TUNE.keepAwayWeight * (plan.keepAway - gap) / plan.keepAway;
  }
  return value;
}

// 走到候选中途再分支：还有多少条路躲得过场上来弹；若对手此刻朝我开火，又有多少条路躲得掉。
let escapeReal = 1, escapeShot = 1;
function escapeOdds(ci, foes) {
  const k0 = Math.min(HORIZON - 8, Math.max(2, Math.round(TUNE.escapeAt))), at = ci * HORIZON + k0 - 1;
  const x0 = rollX[at], y0 = rollY[at], a0 = rollA[at];
  const hitR = tankR + P.bulletRadius + 1, hit2 = hitR * hitR;
  const h = dt * STEP_TICKS, stride = P.bulletSpeed * h;
  const shots = [];
  // 每一条分支同时避开全部相关敌人的下一枪；单挑沿用原来的保守即时开火估计。
  for (const item of foes) {
    const foe = item.enemy;
    if (foe.laserShots > 0) continue; // 激光按独立冷却/射线时域计价，不冒充慢速普通弹。
    const track = mem.tracks.get(foe.id);
    const ex = track && track.predicted ? track.px[k0 - 1] : foe.x;
    const ey = track && track.predicted ? track.py[k0 - 1] : foe.y;
    const gap = Math.hypot(x0 - ex, y0 - ey);
    if (gap <= 1 || !clearSegment(ex, ey, x0, y0, P.bulletRadius)) continue;
    const angle = Math.atan2(y0 - ey, x0 - ex);
    const turnTime = Math.abs(wrap(angle - foe.angle)) / P.turnSpeed;
    const delay = foes.length === 1 ? 0 : Math.max(0, Math.ceil((Math.max(item.ready, turnTime) - k0 * h) / h));
    const pellets = foe.scatterShots > 0 ? P.scatter.pellets : 1;
    for (let pellet = 0; pellet < pellets; pellet++) {
      const a = angle + (pellet - (pellets - 1) / 2) * P.scatter.spreadAngle;
      shots.push({ x: ex, y: ey, ux: Math.cos(a), uy: Math.sin(a), reach: gap + hitR + stride, delay });
    }
  }
  let real = 0, shot = 0;
  for (let b = 0; b < BRANCHES.length; b++) {
    const branch = BRANCHES[b];
    sx = x0;
    sy = y0;
    sa = a0;
    let alive = true, dodged = true;
    for (let k = k0; k < HORIZON && alive; k++) {
      const i = k - k0;
      stepCoarse(i < branch[2] ? branch[0] : branch[3], i < branch[2] ? branch[1] : 0);
      for (let j = 0; j < threatCount; j++) {
        if (thVirtual[j] || k < thFrom[j] || k >= thTo[j]) continue;
        const dx = sx - thX[j][k], dy = sy - thY[j][k];
        if (dx * dx + dy * dy < hit2) {
          alive = false;
          break;
        }
      }
      if (dodged) for (const bullet of shots) {
        if (i < bullet.delay) continue;
        const flown = P.muzzleOffset + stride * (i - bullet.delay + 1);
        if (flown >= bullet.reach) continue;
        const dx = sx - bullet.x - bullet.ux * flown, dy = sy - bullet.y - bullet.uy * flown;
        if (dx * dx + dy * dy < hit2) { dodged = false; break; }
      }
    }
    if (alive) {
      real++;
      if (dodged) shot++;
    }
  }
  escapeReal = real / BRANCHES.length;
  escapeShot = shot / BRANCHES.length;
}

function escapeRisk(ci, plan) {
  if (candHit[ci] < HORIZON || escapeFoes === undefined) return 0;
  escapeOdds(ci, escapeFoes);
  const shut = 1 - escapeReal, exposed = 1 - escapeShot;
  return TUNE.escapeCost * shut * shut + TUNE.shotEscapeCost * exposed * exposed * (plan.duel && escapeFoes.length === 1 && escapeFoes[0].enemy.id === plan.targetId ? TUNE.duelEscapeScale : 1);
}

function scoreCandidate(ci, me, plan) {
  const base = ci * HORIZON;
  const hitR = tankR + P.bulletRadius + 0.5, softR = hitR + mem.margin;
  const hit2 = hitR * hitR, soft2 = softR * softR;
  const laserR = tankR + 3, laser2 = laserR * laserR;
  const lootR = tankR + P.powerupRadius + 1, loot2 = lootR * lootR;
  const shieldSteps = me.shield ? me.shieldTime / (dt * STEP_TICKS) : 0;
  const zone2 = TUNE.zoneRadius * TUNE.zoneRadius;
  let hitStep = HORIZON, soft = 0, virtual = 0, laser = 0, trample = 0, zone = 0;
  for (let k = 0; k < HORIZON && hitStep === HORIZON; k++) {
    const x = rollX[base + k], y = rollY[base + k], fade = 1 - k / (HORIZON * 2);
    for (let j = 0; j < threatCount; j++) {
      if (k < thFrom[j] || k >= thTo[j]) continue;
      const dx = x - thX[j][k], dy = y - thY[j][k], d2 = dx * dx + dy * dy;
      if (d2 >= soft2) continue;
      if (thVirtual[j]) {
        // 炮口线越快打到越危险：0.3 秒内几乎来不及躲。
        const urgent = k < 10 ? fade * (1 + (10 - k) * 0.6) : fade;
        // 只有正在对决的目标享受进攻折扣，旁人的炮口线保持完整代价。
        const weighted = urgent * (plan.duel && thOwner[j] === plan.targetId ? TUNE.duelThreatScale : 1);
        if (d2 < hit2 && weighted > virtual) virtual = weighted;
      } else if (d2 < hit2) {
        hitStep = k;
      } else {
        const graze = (softR - Math.sqrt(d2)) / mem.margin * fade;
        if (graze > soft) soft = graze;
      }
    }
    for (let z = 0; z < zoneEnemies.length; z++) {
      const dx = x - zoneEnemies[z].x, dy = y - zoneEnemies[z].y;
      const weighted = fade * (plan.duel && zoneEnemies[z].id === plan.targetId ? TUNE.duelThreatScale : 1);
      if (dx * dx + dy * dy < zone2 && weighted > zone) zone = weighted;
    }
    for (let m = 0; m < mineHazards.length; m++) {
      const mine = mineHazards[m];
      if (k < mine.armStep) continue;
      const dx = x - mine.x, dy = y - mine.y, d2 = dx * dx + dy * dy;
      if (d2 < mine.trigger2) hitStep = k;
      else if (d2 < mine.blast2 && fade > soft) soft = fade; // 敌人随时引爆：要逃，但不算必中。
    }
    // 冷却结束前离开射线才有价值；按可开火时段的暴露长度计价，不能仅取全程最大值。
    // 同一敌人的扇形假设不重复相加，不同敌人的交叉炮线独立贡献。
    for (const fan of laserFans) {
      if (k < fan.ready) continue;
      let exposure = 0;
      const enemy = fan.enemy, elapsed = (k + 1) * dt * STEP_TICKS;
      const track = mem.tracks.get(enemy.id);
      const ex = track && track.predicted ? track.px[k] : enemy.x;
      const ey = track && track.predicted ? track.py[k] : enemy.y;
      const dx = x - ex, dy = y - ey, gap = Math.hypot(dx, dy);
      const turnNeeded = Math.abs(wrap(Math.atan2(dy, dx) - enemy.angle));
      // Aim can change while the gun cools; entering wall shadow is durable,
      // crossing only the current muzzle line is not. The flank rays include
      // the body extent, so barely clipping a wall corner is still exposed.
      if (gap < P.laser.maxLength && turnNeeded <= P.turnSpeed * elapsed + 0.12) {
        const nx = -dy / gap * laserR, ny = dx / gap * laserR;
        if (clearSegment(ex, ey, x, y, 0) ||
            clearSegment(ex, ey, x + nx, y + ny, 0) ||
            clearSegment(ex, ey, x - nx, y - ny, 0)) exposure = 1;
      }
      for (let s = fan.from; s < fan.to; s++) {
        const b = s * 5;
        if (laserSegs[b + 4] > exposure && segDist2(x, y, laserSegs[b], laserSegs[b + 1], laserSegs[b + 2], laserSegs[b + 3]) < laser2) {
          exposure = laserSegs[b + 4];
        }
      }
      laser += exposure / Math.max(1, HORIZON - fan.ready);
    }
    for (let t = 0; t < trampleSpots.length; t++) {
      const dx = x - trampleSpots[t].x, dy = y - trampleSpots[t].y;
      if (dx * dx + dy * dy < loot2) trample = 1;
    }
  }
  let risk = soft * TUNE.softCost + virtual * TUNE.virtualCost + laser * TUNE.laserCost + trample * TUNE.trampleCost + zone * TUNE.zoneCost;
  if (hitStep < HORIZON) {
    risk += (hitStep < shieldSteps ? TUNE.shieldedHitCost : TUNE.hitCost) * (2 - hitStep / HORIZON);
  }
  candRisk[ci] = risk;
  candHit[ci] = hitStep;
  candCost[ci] = risk - objective(ci, plan);
}

function storeStep(base, k) {
  rollX[base + k] = sx;
  rollY[base + k] = sy;
  rollA[base + k] = sa;
}

// 既定计划：闭环跟随路径或转向瞄准，首步转向按单 Tick 量化。
function rolloutPlan(ci, me, plan) {
  const base = ci * HORIZON;
  let waypoint = 0;
  sx = me.x;
  sy = me.y;
  sa = me.angle;
  for (let k = 0; k < HORIZON; k++) {
    const quantum = k === 0 ? turnStep / STEP_TICKS : turnStep;
    let move, turn;
    if (plan.kind === 'aim' || pathN === 0) {
      move = plan.move;
      turn = clamp(wrap(plan.faceAngle - sa) / quantum, -1, 1);
    } else {
      while (waypoint < pathN - 1 && Math.hypot(pathX[waypoint] - sx, pathY[waypoint] - sy) < TUNE.waypointReach) waypoint++;
      steer(pathX[waypoint], pathY[waypoint], quantum);
      move = steerMove;
      turn = steerTurn;
    }
    if (k === 0) {
      candMove[ci] = move;
      candTurn[ci] = turn;
    }
    stepTank(move, turn);
    storeStep(base, k);
  }
  candEndAngle[ci] = sa;
}

function addManeuver(me, plan, m1, t1, hold, m2) {
  if (candCount >= MAX_CANDIDATES) return;
  const ci = candCount++, base = ci * HORIZON;
  candMove[ci] = hold > 0 ? m1 : m2;
  candTurn[ci] = hold > 0 ? t1 : 0;
  specKnown[ci] = 1;
  specM1[ci] = m1;
  specT1[ci] = t1;
  specHold[ci] = hold;
  specM2[ci] = m2;
  sx = me.x;
  sy = me.y;
  sa = me.angle;
  for (let k = 0; k < HORIZON; k++) {
    if (k < hold) stepTank(m1, t1);
    else stepTank(m2, 0);
    storeStep(base, k);
  }
  candEndAngle[ci] = sa;
  scoreCandidate(ci, me, plan);
}

function addAimManeuver(me, plan, move, angle) {
  if (candCount >= MAX_CANDIDATES) return;
  const ci = candCount++, base = ci * HORIZON;
  specKnown[ci] = 0;
  sx = me.x;
  sy = me.y;
  sa = me.angle;
  for (let k = 0; k < HORIZON; k++) {
    const turn = clamp(wrap(angle - sa) / (k === 0 ? turnStep / STEP_TICKS : turnStep), -1, 1);
    if (k === 0) {
      candMove[ci] = move;
      candTurn[ci] = turn;
    }
    stepTank(move, turn);
    storeStep(base, k);
  }
  candEndAngle[ci] = sa;
  scoreCandidate(ci, me, plan);
}

// 含“先转后走”：履带只能沿车头动，垂直弹道前往往要先转向。
// A dodge is an interruption, not a replacement destination: after a short
// evasive prefix evaluate the same cover route. Real bullets can still reject
// every prefix, and no movement is held for a fixed real-time duration.
function addCoverManeuver(me, plan, move, turn, prefix) {
  if (candCount >= MAX_CANDIDATES) return;
  const ci = candCount++, base = ci * HORIZON;
  candMove[ci] = move;
  candTurn[ci] = turn;
  specKnown[ci] = 0;
  sx = me.x; sy = me.y; sa = me.angle;
  let waypoint = 0;
  for (let k = 0; k < HORIZON; k++) {
    if (k < prefix) stepTank(move, turn);
    else {
      while (waypoint < pathN - 1 && Math.hypot(pathX[waypoint] - sx, pathY[waypoint] - sy) < TUNE.waypointReach) waypoint++;
      steer(pathX[waypoint], pathY[waypoint], turnStep);
      stepTank(steerMove, steerTurn);
    }
    storeStep(base, k);
  }
  candEndAngle[ci] = sa;
  scoreCandidate(ci, me, plan);
}

function generateCandidates(me, plan) {
  if (candidatesReady) return;
  candidatesReady = true;
  if (plan.mode === 'cover' && pathN > 0) {
    for (const prefix of [3, 6]) {
      for (const turn of [-1, 0, 1]) {
        for (const move of [1, -1]) addCoverManeuver(me, plan, move, turn, prefix);
      }
    }
  }
  const turns = workScale >= 0.5 ? [1, -1, 0.5, -0.5] : [1, -1];
  for (const move of [1, -1, 0]) addManeuver(me, plan, move, 0, HORIZON, move);
  for (const turn of turns) {
    for (const hold of [5, 12]) {
      addManeuver(me, plan, 1, turn, hold, 1);
      addManeuver(me, plan, -1, turn, hold, -1);
      addManeuver(me, plan, 0, turn, hold, 1);
      addManeuver(me, plan, 0, turn, hold, -1);
    }
  }
  if (plan.aimAngle !== null) {
    for (const move of [0, 1, -1]) addAimManeuver(me, plan, move, plan.aimAngle);
  }
  if (plan.foeSeen) {
    const facing = Math.atan2(plan.foeY - me.y, plan.foeX - me.x);
    for (const move of [0, 1, -1]) addAimManeuver(me, plan, move, facing);
  }
  // 上一 Tick 选中的机动继续走它的剩余部分：规划的轨迹才是实际执行的轨迹。
  if (mem.contOn) {
    contIndex = candCount;
    if (mem.contHold > 0) addManeuver(me, plan, mem.contM1, mem.contT1, mem.contHold, mem.contM2);
    else addManeuver(me, plan, mem.contM2, 0, HORIZON, mem.contM2);
  }
}

let escapeFoes;
function generateRescue(me, plan) {
  for (const turn of [1, -1]) {
    for (const hold of [2, 3, 4, 7, 9]) {
      addManeuver(me, plan, 1, turn, hold, 1);
      addManeuver(me, plan, -1, turn, hold, -1);
      addManeuver(me, plan, 0, turn, hold, 1);
      addManeuver(me, plan, 0, turn, hold, -1);
      addManeuver(me, plan, 1, turn, hold, -1);
      addManeuver(me, plan, -1, turn, hold, 1);
    }
  }
}

function chooseMotion(state, plan) {
  const me = state.self;
  const foes = [];
  for (const enemy of state.enemies) {
    if (!enemy.alive || !armedWithin(enemy, state, 0.6)) continue;
    if (Math.hypot(enemy.x - me.x, enemy.y - me.y) <= 340) {
      foes.push({ enemy, ready: enemy.laserShots > 0 || enemy.scatterShots > 0 ? enemy.cooldown : reloadIn(enemy, state) });
    }
  }
  let realThreats = 0;
  for (let j = 0; j < threatCount; j++) if (!thVirtual[j]) realThreats++;
  escapeFoes = foes.length || realThreats > 0 ? foes : undefined;
  candCount = 1;
  candidatesReady = false;
  contIndex = -1;
  specKnown[0] = 0;
  rolloutPlan(0, me, plan);
  scoreCandidate(0, me, plan);
  const planEscape = escapeRisk(0, plan);
  candRisk[0] += planEscape;
  candCost[0] += planEscape;
  const unsticking = state.time < mem.unstickUntil;
  let chosen = 0;
  if (unsticking || candHit[0] < HORIZON || candRisk[0] >= TUNE.calmCost) {
    generateCandidates(me, plan);
    let anySafe = false;
    for (let ci = 0; ci < candCount && !anySafe; ci++) anySafe = candHit[ci] >= HORIZON;
    if (!anySafe) generateRescue(me, plan);
    if (unsticking) candCost[0] += TUNE.hitCost;
    for (let ci = 0; ci < candCount; ci++) {
      let cost = candCost[ci];
      if (ci === contIndex || (ci === 0 && mem.lastCandidate === 0)) cost -= TUNE.commitBonus;
      if (unsticking && candMove[ci] * mem.unstickMove <= 0) cost += TUNE.softCost;
      rankCost[ci] = cost;
      rankOrder[ci] = ci;
    }
    // 插入排序：候选不足 64 个，且大多已近乎有序。
    for (let i = 1; i < candCount; i++) {
      const ci = rankOrder[i], cost = rankCost[ci];
      let j = i - 1;
      while (j >= 0 && rankCost[rankOrder[j]] > cost) {
        rankOrder[j + 1] = rankOrder[j];
        j--;
      }
      rankOrder[j + 1] = ci;
    }
    let best = Infinity;
    for (let i = 0; i < candCount; i++) {
      const ci = rankOrder[i];
      let cost = rankCost[ci];
      if (cost >= best) break;
      if (ci !== 0) {
        const extra = escapeRisk(ci, plan);
        candRisk[ci] += extra;
        cost += extra;
      }
      if (cost < best) {
        best = cost;
        chosen = ci;
      }
    }
  }
  mem.contOn = specKnown[chosen] === 1;
  if (mem.contOn) {
    mem.contM1 = specM1[chosen];
    mem.contT1 = specT1[chosen];
    mem.contHold = specHold[chosen] - 1 / STEP_TICKS;
    mem.contM2 = specM2[chosen];
  }
  return {
    ci: chosen,
    move: candMove[chosen],
    turn: candTurn[chosen],
    doomed: candHit[chosen] < 12 && !me.shield,
  };
}

// ---------- 开火 ----------

// 对手全部闪避动作里，有多少逃不过这一发（含场上已有的弹）。
function caughtFraction(enemy, pellets, limit) {
  const hitR = tankR + P.bulletRadius, hit2 = hitR * hitR;
  let caught = 0;
  for (let m = 0; m < MANEUVERS.length; m++) {
    const move = MANEUVERS[m][0], turn = MANEUVERS[m][1], hold = MANEUVERS[m][2];
    let hit = false;
    sx = enemy.x;
    sy = enemy.y;
    sa = enemy.angle;
    for (let k = 0; k < limit && !hit; k++) {
      stepTank(move, k < hold ? turn : 0);
      for (let p = 0; p < pellets && !hit; p++) {
        const dx = sx - shotX[p][k], dy = sy - shotY[p][k];
        if (dx * dx + dy * dy < hit2) hit = true;
      }
      if (k < HORIZON) {
        for (let j = 0; j < threatCount && !hit; j++) {
          if (thVirtual[j] || thOwner[j] === enemy.id || k >= thTo[j]) continue;
          const dx = sx - thX[j][k], dy = sy - thY[j][k];
          if (dx * dx + dy * dy < hit2) hit = true;
        }
      }
    }
    if (hit) caught++;
  }
  return caught / MANEUVERS.length;
}

// 命中率 =（不躲时）预测轨迹是否被打中 与（会躲时）无处可逃比例 的加权，权重由闪避账本学习。
function shotOdds(enemy, track, pellets, steps) {
  const hitR = tankR + P.bulletRadius - 1, hit2 = hitR * hitR;
  let hitStep = -1, near = Infinity, nearStep = 0;
  for (let k = 0; k < steps && hitStep < 0; k++) {
    for (let p = 0; p < pellets; p++) {
      const dx = shotX[p][k] - track.px[k], dy = shotY[p][k] - track.py[k], d2 = dx * dx + dy * dy;
      if (d2 < near) {
        near = d2;
        nearStep = k;
      }
      if (d2 < hit2) {
        hitStep = k;
        break;
      }
    }
  }
  shotPredicted = hitStep >= 0;
  shotSteps = (hitStep >= 0 ? hitStep : nearStep) + 8;
  if (hitStep < 0 && near > 2500) return 0;
  const limit = Math.min(steps, shotSteps);
  let odds = (1 - track.dodge) * (shotPredicted ? 1 : 0) + track.dodge * caughtFraction(enemy, pellets, limit);
  if (enemy.shield && enemy.shieldTime > limit * STEP_TICKS * dt) odds *= 0.6;
  return odds;
}

function shotHitsRollout(ci, pellets) {
  const base = ci * HORIZON, hitR = tankR + P.bulletRadius + 1, hit2 = hitR * hitR;
  for (let k = 0; k < HORIZON; k++) {
    for (let p = 0; p < pellets; p++) {
      if (k < shotFrom[p]) continue;
      const dx = rollX[base + k] - shotX[p][k], dy = rollY[base + k] - shotY[p][k];
      if (dx * dx + dy * dy < hit2) return true;
    }
  }
  return false;
}

// 开火采用的正是已选机动；不能用另一条未执行的候选证明这条机动能躲开自己的回弹。
function canSurviveShot(me, plan, motion, pellets) {
  return !shotHitsRollout(motion.ci, pellets);
}

function laserVictim(state, x, y, angle) {
  const n = traceLaser(x, y, angle), hitR2 = (tankR - 1) * (tankR - 1), selfR2 = (tankR + 2) * (tankR + 2);
  for (let i = 0; i + 1 < n; i++) {
    let first = null, firstT = Infinity;
    for (const enemy of state.enemies) {
      if (!enemy.alive) continue;
      if (segDist2(enemy.x, enemy.y, laserX[i], laserY[i], laserX[i + 1], laserY[i + 1]) < hitR2 && segT < firstT) {
        firstT = segT;
        first = enemy;
      }
    }
    // 第一段忽略射手，反弹段可自伤。
    if (i > 0 && segDist2(x, y, laserX[i], laserY[i], laserX[i + 1], laserY[i + 1]) < selfR2 && segT < firstT) return state.self;
    if (first) return first;
  }
  return null;
}

function fireThreshold(state, scatter, victim) {
  const ladder = TUNE.fireLadder, me = state.self;
  let need = ladder[Math.min(me.bulletsActive, ladder.length - 1)];
  const distance = Math.hypot(victim.x - me.x, victim.y - me.y);
  const scarce = !scatter && me.laserShots === 0 && me.bulletsActive >= P.maxBullets - TUNE.reserveBullets;
  // 保命弹只留给近身：对手一旦贴到瞬杀圈，先开火的人赢。
  if (scarce) return distance < TUNE.lastShotRange ? TUNE.lastShotOdds : 2;
  if (distance < TUNE.fireCloseRange) need = Math.min(need, TUNE.closeNeed);
  if (scatter) need *= 0.8;
  return need * (1 - 0.4 * urgency(state));
}

function chooseFire(state, plan, motion) {
  const me = state.self;
  // 冷却在移动阶段先扣减，剩余不超过一个 Tick 时本 Tick 就能打。
  if (me.cooldown > dt) return false;
  // 射击发生在本 Tick 转向和移动之后。
  sx = me.x;
  sy = me.y;
  sa = me.angle;
  tickTank(motion.move, motion.turn);
  const fireX = sx, fireY = sy, fireAngle = sa;
  // 正式规则先移动、拾取，再开火；按这一步真实能拿到的武器检查弹道。
  let laser = me.laserShots > 0, scatter = !laser && me.scatterShots > 0;
  const pickupR = tankR + P.powerupRadius;
  for (const pickup of state.powerups) {
    if (Math.hypot(pickup.x - fireX, pickup.y - fireY) >= pickupR) continue;
    if (pickup.type !== 'shield') {
      laser = pickup.type === 'laser';
      scatter = pickup.type === 'scatter';
    }
    break;
  }
  if (!laser && !scatter && me.bulletsActive >= P.maxBullets) return false;
  if (laser) {
    const victim = laserVictim(state, fireX, fireY, fireAngle);
    return victim !== null && victim !== me && !(victim.shield && victim.shieldTime > 0.2);
  }
  const pellets = scatter ? Math.min(P.scatter.pellets, MAX_PELLETS) : 1;
  const steps = Math.max(30, Math.round(SHOT_STEPS * workScale));
  const graceSteps = Math.ceil(P.selfHitGrace / (dt * STEP_TICKS));
  for (let p = 0; p < pellets; p++) {
    const angle = fireAngle + (scatter ? (p - (pellets - 1) / 2) * P.scatter.spreadAngle : 0);
    const dx = Math.cos(angle), dy = Math.sin(angle), out = muzzleDistance(fireX, fireY, dx, dy);
    tracePath(fireX + dx * out, fireY + dy * out, dx * P.bulletSpeed, dy * P.bulletSpeed, STEP_TICKS, steps, shotX[p], shotY[p]);
    shotFrom[p] = Math.min(firstBounce(steps), graceSteps);
  }
  let odds = 0, victim = null, predicted = false, flight = 0;
  for (const enemy of tracked) {
    const value = shotOdds(enemy, mem.tracks.get(enemy.id), pellets, steps);
    if (value > odds) {
      odds = value;
      victim = enemy;
      predicted = shotPredicted;
      flight = shotSteps;
    }
  }
  if (!victim || odds < fireThreshold(state, scatter, victim)) return false;
  // 反正躲不掉时换命，否则先保证自己不被这发回弹打死。
  if (!motion.doomed && !canSurviveShot(me, plan, motion, pellets)) return false;
  mem.pendingShot = {
    targetId: victim.id,
    dueTick: state.tick + flight * STEP_TICKS,
    predicted,
    shielded: victim.shield,
  };
  return true;
}

// ---------- 布雷 ----------

function chooseMine(state, motion) {
  const me = state.self, mine = P.mine;
  if (me.mineCharges <= 0 || me.deployCooldown > dt) return false;
  const tail = 29;
  const tailX = me.x - Math.cos(me.angle) * tail, tailY = me.y - Math.sin(me.angle) * tail;
  for (const hazard of mineHazards) {
    if (Math.hypot(hazard.x - tailX, hazard.y - tailY) < mine.triggerRadius) return false;
  }
  // 布防时自己必须已离开爆炸圈。
  const armStep = Math.min(HORIZON - 1, Math.ceil(mine.armDelay / (dt * STEP_TICKS)));
  const at = motion.ci * HORIZON + armStep;
  if (Math.hypot(rollX[at] - tailX, rollY[at] - tailY) < mine.blastRadius + 4) return false;
  if (me.mineHoldTime < 0.6) return true;
  // 敌人预计在布防后经过这里才值得放。
  for (const enemy of tracked) {
    const track = mem.tracks.get(enemy.id);
    for (let k = armStep; k < PRED_STEPS; k++) {
      if (Math.hypot(track.px[k] - tailX, track.py[k] - tailY) < mine.triggerRadius - 4) return true;
    }
  }
  return false;
}

// ---------- 入口 ----------

function prepare(state) {
  P = state.physics;
  dt = state.dt;
  nowTick = state.tick;
  moveStep = P.moveSpeed * dt * STEP_TICKS;
  turnStep = P.turnSpeed * dt * STEP_TICKS;
  tankR = P.tankRadius;
  tankR2 = tankR * tankR;
  const shape = P.tankCollision;
  bodyHX = shape.bodyLength / 2;
  bodyHY = shape.bodyWidth / 2;
  const tip = shape.barrelEnd + shape.barrelRadius;
  barrelC = (bodyHX + tip) / 2;
  barrelHX = (tip - bodyHX) / 2;
  barrelHY = shape.barrelRadius;
  inertia = (shape.bodyLength * shape.bodyLength + shape.bodyWidth * shape.bodyWidth) / 12;
  bodyReach = tip + 3;
  // 开局函数未经 JIT 优化：前 40 Tick 逐步放开搜索规模，避开首 Tick 超时。
  workScale = Math.min(mem.scale, 0.2 + state.tick / 40);
  buildWorld(state.map);
  buildContacts(state.map);
}

function decide(state) {
  const started = clock();
  prepare(state);
  learnEnemies(state);
  settleShots(state);
  calibrateBullets(state);
  detectStuck(state);
  trackMines(state);
  buildMineHazards(state);
  flood(cellIndex(state.self.x, state.self.y), fieldMe);
  const target = pickTarget(state);
  predictEnemies(state, target);
  buildThreats(state);
  const plan = makePlan(state, target);
  const motion = chooseMotion(state, plan);
  const fire = chooseFire(state, plan, motion);
  const special = chooseMine(state, motion);
  mem.lastMove = motion.move;
  mem.lastCandidate = motion.ci;
  const spent = clock() - started;
  if (spent > TUNE.softBudgetMs) mem.scale = Math.max(0.3, mem.scale * 0.85);
  else if (spent < TUNE.softBudgetMs * 0.4) mem.scale = Math.min(1, mem.scale * 1.02);
  return { move: motion.move, turn: motion.turn, fire, special };
}

module.exports = { update: decide };
