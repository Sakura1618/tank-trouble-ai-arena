// PROTEUS multifront: integrated3 duel policy plus public-state multiplayer threat coordination.
/*
 * Astra Gen4 · 无相（PROTEUS）
 * 「无形可测，无隙可乘。」
 *
 * 独立 CommonJS 选手，仅读取竞技场公开 state，不识别对手名字或源码。
 * 策略提炼自 Sakura1618 / Opus Gen1「先机」PRESCIENCE：
 * https://github.com/Walkersifolia/tank-trouble-ai-arena/pull/2
 * 源版本 85305b7da0f540810f6926e5a7fbfbd1eda209e1，bots/opus-g1-prescience.js。
 * 保留其公开物理近似、预测器竞选、候选机动、退路分支与弹位管理。
 * 完整保留 Opus 已公开的价值网络及常量，仅进行推理，不训练神经网络；不包含神谕代码。
 * Gen4 候选 multifront：单挑保持 integrated-3；多人急危选目标、目标限定的对决折扣、联合退路与完整多激光容量；内嵌对手模型不改。
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

// Opus Gen1「先机」PRESCIENCE
// Tank Trouble 竞技 AI：自包含单文件，只使用 API.md 的公开状态。
// 每 Tick 流程：观测入账 → 威胁表 → 战术计划 → 候选轨迹评估 → 开火/布雷判定。
// 运动模型按公开物理常量实现车身与炮管 OBB、厚墙和接触转动，弹道逐 Tick 外推。
// 候选轨迹除当前来弹外还看退路：走到中途再分支，数还有多少路躲得过，以及对手此刻开火躲不躲得掉。
// 离线训练得到两部分，比赛时不再学习；训练规则为关闭道具、关闭内墙破坏的 1v1，其他规则未验证：
//   1. TUNE：候选打分权重与开火门限，用进化策略按对局胜负优化；
//   2. 价值网络：估计候选 0.4 秒后局面的阵亡与击杀概率，用对局结局在 GPU 上训练，权重内嵌于本文件。
// 局内自我迭代（每局从零开始，没有跨局记忆）：
//   1. 运动预测竞选：多个预测器 0.5 秒后对答案，用误差最小者算提前量；
//   2. 闪避账本：预计命中却落空的炮弹抬高对手的闪避估计，从而收紧开火条件；
//   3. 弹道校准：实测弹道预测误差，放大躲弹安全边距；
//   4. 路线纠错：实际卡住的边临时加权，改走其他路；
//   5. 算力调节：实测耗时超标就缩小搜索规模，防止慢设备超时。

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
  lastShotRange: 70.1767,        // 保留原版保命弹距离；提前使用最后一发未改善小批总体得分。
  reserveBullets: 1,
  escapeAt: 12,             // 沿候选走到这一步再分支检查退路（步）。
  escapeCost: 148.0767,          // 退路被来弹封死的代价。
  shotEscapeCost: 65.8567,       // 对手此刻朝我开火时躲不掉的代价。
  duelEscapeScale: 0.5411,     // 对决时对“躲不掉对手下一枪”的折扣。
  valueDie1: 490.9144,           // 价值网络：1 秒内阵亡概率的代价权重。
  valueDie2: 189.6637,           // 价值网络：2 秒内阵亡概率的代价权重。
  valueKill: 229.271,           // 价值网络：2 秒内击杀概率的收益权重。
  valueCalm: 0.0356,          // 计划的 1 秒阵亡概率超过此值时展开候选。
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
const VALUE_STEP = 12;      // 价值网络在候选第 12 步（0.4 秒后）的状态上打分。
const VALUE_LOOK = 18;      // 炮弹危险向前看 18 步（0.6 秒）。
const FEATURES = 48;
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
  pathWaypoint: null,
  pathGoalCell: -1,
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

// 沿导航方向平移的车身/炮管 OBB 与厚墙 AABB 做四轴分离检测。
// 这里只检验直线路段，不把平移扫掠当成转动或多车接触模型。
function sweptPathBoxBlocked(cx, cy, ux, uy, hx, hy, q) {
  const rect = world.rect, dx = cx - rect[q], dy = cy - rect[q + 1];
  const ex = rect[q + 2], ey = rect[q + 3], ax = Math.abs(ux), ay = Math.abs(uy);
  if (Math.abs(dx) > ex + ax * hx + ay * hy) return false;
  if (Math.abs(dy) > ey + ay * hx + ax * hy) return false;
  if (Math.abs(dx * ux + dy * uy) > hx + ex * ax + ey * ay) return false;
  if (Math.abs(-dx * uy + dy * ux) > hy + ex * ay + ey * ax) return false;
  return true;
}

function clearTankPath(x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0, length = Math.hypot(dx, dy);
  if (length < 1) return true;
  const ux = dx / length, uy = dy / length, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const bodySweep = length / 2 + bodyHX, barrelSweep = length / 2 + barrelHX;
  const barrelX = cx + ux * barrelC, barrelY = cy + uy * barrelC;
  for (let q = 0; q < world.rect.length; q += 4) {
    if (sweptPathBoxBlocked(cx, cy, ux, uy, bodySweep, bodyHY, q) ||
        sweptPathBoxBlocked(barrelX, barrelY, ux, uy, barrelSweep, barrelHY, q)) return false;
  }
  return true;
}

// 沿路程场下降取格子中心作路径，再拉直：保留车身/炮管直线扫掠可通过的捷径。
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
    if (clearTankPath(x, y, rawX[i], rawY[i])) {
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
  mem.pathWaypoint = null;
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
  const foes = state.enemies.filter(enemy => enemy.alive);
  const multiplayer = foes.length > 1;
  const previous = foes.find(enemy => enemy.id === mem.targetId);
  const previousAngle = previous ? Math.atan2(previous.y - me.y, previous.x - me.x) : me.angle;
  let best = null, bestScore = Infinity;
  for (const enemy of foes) {
    const dx = enemy.x - me.x, dy = enemy.y - me.y, distance = Math.hypot(dx, dy);
    const steps = fieldMe[cellIndex(enemy.x, enemy.y)];
    let score = (steps < Infinity ? steps * world.S : 1500) + distance * 0.5;
    if (enemy.id === mem.targetId) score -= TUNE.targetStickiness;
    if (enemy.shield) score += 150;
    if (multiplayer && distance > 1 && (enemy.laserShots === 0 || distance < P.laser.maxLength) &&
        clearSegment(me.x, me.y, enemy.x, enemy.y, P.bulletRadius)) {
      const bearing = Math.atan2(dy, dx);
      const ready = enemy.laserShots > 0 || enemy.scatterShots > 0 ? enemy.cooldown : reloadIn(enemy, state);
      const enemyTurn = Math.abs(wrap(bearing + Math.PI - enemy.angle)) / P.turnSpeed;
      const approach = -((enemy.vx - me.vx) * dx + (enemy.vy - me.vy) * dy) / distance;
      const remaining = Math.max(0, distance - P.muzzleOffset - tankR);
      const arrival = enemy.laserShots > 0 ? 0 : remaining / (P.bulletSpeed + Math.max(0, approach));
      const dangerAt = Math.max(ready, enemyTurn) + arrival;
      if (dangerAt < 1.6) {
        // Crossfire from a different bearing is not the same as another tank
        // queued behind the current opponent. Preserve the original target
        // hysteresis, but let a genuinely imminent weapon outweigh distance.
        const crossAngle = 1 - Math.cos(bearing - previousAngle);
        const weapon = enemy.laserShots > 0 ? 520 : enemy.scatterShots > 0 ? 160 : 95;
        const closing = Math.max(0, approach) / P.moveSpeed;
        score -= weapon * (1 + crossAngle * 0.15 + closing * 0.15) / (0.45 + dangerAt);
        if (enemy.laserShots > 0 && dangerAt <= 1.0 && !enemy.shield) {
          const ownReady = me.laserShots > 0 || me.scatterShots > 0 ? me.cooldown : reloadIn(me, state);
          const ownTurn = Math.abs(wrap(bearing - me.angle)) / P.turnSpeed;
          // Flight time uses the actual public 180 px/s projectile speed, not
          // an assumed hitscan weapon. Motion during the turn closes the gap.
          const launchAt = Math.max(ownReady, ownTurn);
          const ownFlight = me.laserShots > 0 ? 0 : Math.max(0, remaining - Math.max(0, approach) * launchAt) /
            (P.bulletSpeed + Math.max(0, approach));
          if (launchAt + ownFlight < dangerAt) score -= TUNE.targetStickiness + 240;
        }
      }
    }
    if (score < bestScore) { bestScore = score; best = enemy; }
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
}

function buildThreats(state) {
  const me = state.self;
  const horizonTime = HORIZON * STEP_TICKS * dt;
  const reach = (P.bulletSpeed + P.moveSpeed) * horizonTime + tankR + P.bulletRadius;
  threatCount = 0;
  laserSegCount = 0;
  // Five angle hypotheses, each with its full public bounce count, for every
  // live carrier. The first carrier must not consume everyone else's slots.
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
  const goalCell = cellIndex(goalX, goalY), cell = cellIndex(me.x, me.y), waypoint = mem.pathWaypoint;
  // 进入下一格并不意味着已经绕过墙端。保持尚未到达的格心，
  // 直到完成转角；换目标格、路线不再向目标下降或实际卡住时重选。
  if (waypoint && mem.pathGoalCell === goalCell &&
      Math.hypot(waypoint.x - me.x, waypoint.y - me.y) > TUNE.waypointReach &&
      field[cellIndex(waypoint.x, waypoint.y)] <= field[cell] &&
      (pathN === 0 || Math.hypot(waypoint.x - pathX[0], waypoint.y - pathY[0]) > 1)) {
    for (let i = Math.min(pathN, pathX.length - 1); i > 0; i--) {
      pathX[i] = pathX[i - 1];
      pathY[i] = pathY[i - 1];
    }
    pathX[0] = waypoint.x;
    pathY[0] = waypoint.y;
    pathN = Math.min(pathN + 1, pathX.length);
    const next = cellIndex(waypoint.x, waypoint.y), direction = directionDelta.indexOf(next - cell);
    mem.pathEdge = direction >= 0 ? cell * 4 + direction : -1;
  }
  mem.pathGoalCell = goalCell;
  mem.pathWaypoint = pathN ? { x: pathX[0], y: pathY[0] } : null;
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

function makePlan(state, target) {
  const me = state.self;
  const plan = {
    kind: 'aim', mode: 'hold', move: 0, faceAngle: me.angle, aimAngle: null, aim: null,
    field: null, goalX: me.x, goalY: me.y, startDist: 0, keepAway: 0, keepX: 0, keepY: 0, charging: false, duel: false,
    foeSeen: false, foeX: 0, foeY: 0, targetId: target ? target.id : null,
    multiplayer: state.enemies.filter(enemy => enemy.alive).length > 1,
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
  plan.aimTrack = track && track.predicted ? track : null;
  const aim = target && track && track.predicted && armed ? searchAim(me, track) : null;
  const aimTime = aim ? aim.wait + aim.flight : Infinity;
  if (aim) {
    plan.aim = aim;
    plan.aimAngle = aim.angle;
  }
  const loot = pickLoot(state);
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

// ---------- 价值网络 ----------

// 价值网络权重：GPU 上由对局结果训练（Float32 按 w1,b1,w2,b2,w3,b3 拼接后 base64）。
// 输入 FEATURES 维局面特征，输出 1/2 秒内阵亡、1/2 秒内击杀的 logit 与折扣结局。
const NET_SHAPE = { h1: 64, h2: 64, out: 5 };
const NET_BASE64 = '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';

// 自带解码：比赛环境只承诺纯 JS，不依赖 atob 或 Buffer。
function decodeNet(text, inputs) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) lookup[alphabet.charCodeAt(i)] = i;
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array(text.length / 4 * 3 - padding);
  for (let i = 0, out = 0; i < text.length; i += 4) {
    const a = lookup[text.charCodeAt(i)], b = lookup[text.charCodeAt(i + 1)];
    const c = Math.max(0, lookup[text.charCodeAt(i + 2)]), d = Math.max(0, lookup[text.charCodeAt(i + 3)]);
    const word = (a << 18) | (b << 12) | (c << 6) | d;
    if (out < bytes.length) bytes[out++] = (word >> 16) & 255;
    if (out < bytes.length) bytes[out++] = (word >> 8) & 255;
    if (out < bytes.length) bytes[out++] = word & 255;
  }
  const floats = new Float32Array(bytes.buffer);
  const { h1, h2, out } = NET_SHAPE;
  let at = 0;
  const take = size => floats.subarray(at, at += size);
  return { h1, h2, out, inputs, w1: take(h1 * inputs), b1: take(h1), w2: take(h2 * h1), b2: take(h2), w3: take(out * h2), b3: take(out) };
}

const VALUE_NET = decodeNet(NET_BASE64, FEATURES);

const feat = new Float64Array(FEATURES);
const netHidden1 = new Float64Array(128), netHidden2 = new Float64Array(128), netOut = new Float64Array(8);
const topMiss = new Float64Array(3), topTime = new Float64Array(3), topCos = new Float64Array(3), topSin = new Float64Array(3), topMine = new Float64Array(3);

// 敌方多久后才有下一发：普通弹满额时取自己最老一颗的剩余寿命。
function reloadIn(tank, state) {
  if (tank.bulletsActive < P.maxBullets) return Math.max(0, tank.cooldown);
  let wait = P.bulletLifetime;
  for (const bullet of state.bullets) {
    if (bullet.ownerId === tank.id) wait = Math.min(wait, P.bulletLifetime - bullet.age);
  }
  return wait;
}

// 全部取本车坐标系，泛化到任意朝向与地图。ammo* 取打分所依据的时刻（可能早于当前位姿）。
function fillFeatures(x, y, a, forward, ex, ey, rawAngle, evx, evy, k, minAge, ownId, myActive, foeActive, foeReload, myReload, foeCool, time) {
  const dx = ex - x, dy = ey - y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
  const bearing = Math.atan2(dy, dx), back = bearing + Math.PI;
  // 敌人朝向外推：假定它在 VALUE_STEP 内朝我转，受转速限制。
  const budget = P.turnSpeed * VALUE_STEP * STEP_TICKS * dt, err = wrap(back - rawAngle);
  const ea = rawAngle + clamp(err, -budget, budget);
  const rel = bearing - a, foeRel = back - ea;
  let i = 0;
  feat[i++] = Math.min(d, 600) / 300;
  feat[i++] = Math.min(d, 150) / 150;
  feat[i++] = Math.cos(rel);
  feat[i++] = Math.sin(rel);
  feat[i++] = Math.cos(foeRel);
  feat[i++] = Math.sin(foeRel);
  feat[i++] = clearSegment(x, y, ex, ey, P.bulletRadius) ? 1 : 0;
  const path = fieldTarget[cellIndex(x, y)];
  feat[i++] = path < 12 ? path / 12 : 1;
  feat[i++] = (P.maxBullets - myActive) / P.maxBullets;
  feat[i++] = (P.maxBullets - foeActive) / P.maxBullets;
  feat[i++] = Math.min(foeReload, 3) / 3;
  feat[i++] = Math.min(myReload, 3) / 3;
  feat[i++] = Math.min(foeCool, P.fireCooldown) / P.fireCooldown;
  feat[i++] = (evx * ux + evy * uy) / 150;
  feat[i++] = (-evx * uy + evy * ux) / 150;
  const mx = Math.cos(a) * forward, my = Math.sin(a) * forward;
  feat[i++] = forward / 150;
  feat[i++] = (mx * ux + my * uy) / 150;
  feat[i++] = (-mx * uy + my * ux) / 150;
  for (let r = 0; r < 8; r++) {
    const angle = a + r * Math.PI / 4;
    feat[i++] = castRay(x, y, Math.cos(angle), Math.sin(angle), tankR, 160) / 160;
  }
  for (let r = 0; r < 4; r++) {
    const angle = ea + r * Math.PI / 2;
    feat[i++] = castRay(ex, ey, Math.cos(angle), Math.sin(angle), tankR, 160) / 160;
  }
  // 站着不动时最紧迫的三颗炮弹：擦身距离、到达时间、来向、是否己方。
  topMiss.fill(Infinity);
  topTime.fill(1);
  topCos.fill(0);
  topSin.fill(0);
  topMine.fill(0);
  const last = Math.min(HORIZON - 1, k + VALUE_LOOK);
  let close = 0, count = 0;
  for (let j = 0; j < threatCount; j++) {
    if (thVirtual[j] || thAge[j] < minAge) continue;
    count++;
    let best = Infinity, at = k;
    const px = thX[j], py = thY[j], from = k < thFrom[j] ? thFrom[j] : k, to = last < thTo[j] ? last : thTo[j] - 1;
    for (let q = from; q <= to; q++) {
      const gx = px[q] - x, gy = py[q] - y, g2 = gx * gx + gy * gy;
      if (g2 < best) {
        best = g2;
        at = q;
      }
    }
    if (best === Infinity) continue;
    const miss = Math.sqrt(best), urgency = miss + (at - k) * 3;
    if (miss < 60) close++;
    let slot = -1;
    for (let t = 0; t < 3; t++) {
      if (urgency < topMiss[t] + (topTime[t] * VALUE_LOOK) * 3) {
        slot = t;
        break;
      }
    }
    if (slot < 0) continue;
    for (let t = 2; t > slot; t--) {
      topMiss[t] = topMiss[t - 1];
      topTime[t] = topTime[t - 1];
      topCos[t] = topCos[t - 1];
      topSin[t] = topSin[t - 1];
      topMine[t] = topMine[t - 1];
    }
    const nextQ = at + 1 < HORIZON ? at + 1 : at, prevQ = nextQ - 1;
    const heading = Math.atan2(py[nextQ] - py[prevQ], px[nextQ] - px[prevQ]) - a;
    topMiss[slot] = miss;
    topTime[slot] = (at - k) / VALUE_LOOK;
    topCos[slot] = Math.cos(heading);
    topSin[slot] = Math.sin(heading);
    topMine[slot] = thOwner[j] === ownId ? 1 : 0;
  }
  for (let t = 0; t < 3; t++) {
    feat[i++] = topMiss[t] === Infinity ? 1.5 : Math.min(topMiss[t], 120) / 80;
    feat[i++] = topTime[t];
    feat[i++] = topCos[t];
    feat[i++] = topSin[t];
    feat[i++] = topMine[t];
  }
  feat[i++] = close / 4;
  feat[i++] = count / 10;
  feat[i++] = Math.min(time, 60) / 60;
  return i;
}

function netForward(net) {
  const n1 = net.h1, n2 = net.h2, w1 = net.w1, b1 = net.b1, w2 = net.w2, b2 = net.b2, w3 = net.w3, b3 = net.b3, inputs = net.inputs;
  for (let h = 0; h < n1; h++) {
    let sum = b1[h];
    const row = h * inputs;
    for (let f = 0; f < inputs; f++) sum += w1[row + f] * feat[f];
    netHidden1[h] = sum > 0 ? sum : 0;
  }
  for (let h = 0; h < n2; h++) {
    let sum = b2[h];
    const row = h * n1;
    for (let f = 0; f < n1; f++) sum += w2[row + f] * netHidden1[f];
    netHidden2[h] = sum > 0 ? sum : 0;
  }
  for (let o = 0; o < net.out; o++) {
    let sum = b3[o];
    const row = o * n2;
    for (let f = 0; f < n2; f++) sum += w3[row + f] * netHidden2[f];
    netOut[o] = sum;
  }
}

const sigmoid = v => 1 / (1 + Math.exp(-v));

// 候选在 VALUE_STEP 处的状态上估值；输出为代价（越高越差）。
let valueDie = 0;
function valueRisk(ci, state, target, track) {
  const me = state.self, at = ci * HORIZON + VALUE_STEP - 1, k = VALUE_STEP - 1, h = dt * STEP_TICKS;
  const x = rollX[at], y = rollY[at], a = rollA[at];
  const forward = ((x - rollX[at - 1]) * Math.cos(a) + (y - rollY[at - 1]) * Math.sin(a)) / h;
  fillFeatures(x, y, a, forward, track.px[k], track.py[k], target.angle, (track.px[k] - track.px[k - 1]) / h, (track.py[k] - track.py[k - 1]) / h,
    VALUE_STEP, 0, me.id, me.bulletsActive, target.bulletsActive, reloadIn(target, state), reloadIn(me, state), target.cooldown, state.time);
  netForward(VALUE_NET);
  valueDie = sigmoid(netOut[0]);
  return TUNE.valueDie1 * valueDie + TUNE.valueDie2 * sigmoid(netOut[1]) - TUNE.valueKill * sigmoid(netOut[3]);
}

// ---------- 候选轨迹 ----------

function objective(ci, plan) {
  const last = ci * HORIZON + HORIZON - 1;
  let value = 0;
  if (plan.field) {
    const end = goalDist(plan.field, plan.goalX, plan.goalY, rollX[last], rollY[last]);
    value += TUNE.progressWeight * (plan.startDist - end) / (HORIZON * moveStep);
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
function escapeOdds(ci, foe) {
  const k0 = Math.min(HORIZON - 8, Math.max(2, Math.round(TUNE.escapeAt))), at = ci * HORIZON + k0 - 1;
  const x0 = rollX[at], y0 = rollY[at], a0 = rollA[at];
  const hitR = tankR + P.bulletRadius + 1, hit2 = hitR * hitR;
  const stride = P.bulletSpeed * dt * STEP_TICKS;
  let shotOn = false, ex = 0, ey = 0, ux = 0, uy = 0, reach = 0;
  if (foe) {
    const track = mem.tracks.get(foe.id);
    ex = track && track.predicted ? track.px[k0 - 1] : foe.x;
    ey = track && track.predicted ? track.py[k0 - 1] : foe.y;
    const gap = Math.hypot(x0 - ex, y0 - ey);
    if (gap > 1 && clearSegment(ex, ey, x0, y0, P.bulletRadius)) {
      shotOn = true;
      ux = (x0 - ex) / gap;
      uy = (y0 - ey) / gap;
      reach = gap + hitR + stride;
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
      if (shotOn && dodged) {
        const flown = P.muzzleOffset + stride * (i + 1);
        if (flown < reach) {
          const dx = sx - ex - ux * flown, dy = sy - ey - uy * flown;
          if (dx * dx + dy * dy < hit2) dodged = false;
        }
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

let escapeFoes;
function escapeOddsMultiple(ci, foes) {
  const k0 = Math.min(HORIZON - 8, Math.max(2, Math.round(TUNE.escapeAt))), at = ci * HORIZON + k0 - 1;
  const x0 = rollX[at], y0 = rollY[at], a0 = rollA[at];
  const hitR = tankR + P.bulletRadius + 1, hit2 = hitR * hitR;
  const h = dt * STEP_TICKS, stride = P.bulletSpeed * h;
  const shots = [];
  for (const item of foes) {
    const foe = item.enemy;
    if (foe.laserShots > 0) continue; // The laser fan retains its instant rays.
    const track = mem.tracks.get(foe.id);
    const ex = track && track.predicted ? track.px[k0 - 1] : foe.x;
    const ey = track && track.predicted ? track.py[k0 - 1] : foe.y;
    const gap = Math.hypot(x0 - ex, y0 - ey);
    if (gap <= 1 || !clearSegment(ex, ey, x0, y0, P.bulletRadius)) continue;
    const angle = Math.atan2(y0 - ey, x0 - ex);
    const turnTime = Math.abs(wrap(angle - foe.angle)) / P.turnSpeed;
    const delay = Math.max(0, Math.ceil((Math.max(item.ready, turnTime) - k0 * h) / h));
    const pellets = foe.scatterShots > 0 ? P.scatter.pellets : 1;
    for (let pellet = 0; pellet < pellets; pellet++) {
      const a = angle + (pellet - (pellets - 1) / 2) * P.scatter.spreadAngle;
      shots.push({ x: ex, y: ey, ux: Math.cos(a), uy: Math.sin(a), reach: gap + hitR + stride, delay });
    }
  }
  let real = 0, shot = 0;
  for (const branch of BRANCHES) {
    sx = x0; sy = y0; sa = a0;
    let alive = true, dodged = true;
    for (let k = k0; k < HORIZON && alive; k++) {
      const i = k - k0;
      stepCoarse(i < branch[2] ? branch[0] : branch[3], i < branch[2] ? branch[1] : 0);
      for (let j = 0; j < threatCount; j++) {
        if (thVirtual[j] || k < thFrom[j] || k >= thTo[j]) continue;
        const dx = sx - thX[j][k], dy = sy - thY[j][k];
        if (dx * dx + dy * dy < hit2) { alive = false; break; }
      }
      if (dodged) for (const bullet of shots) {
        if (i < bullet.delay) continue;
        const flown = P.muzzleOffset + stride * (i - bullet.delay + 1);
        if (flown >= bullet.reach) continue;
        const dx = sx - bullet.x - bullet.ux * flown, dy = sy - bullet.y - bullet.uy * flown;
        if (dx * dx + dy * dy < hit2) { dodged = false; break; }
      }
    }
    if (alive) { real++; if (dodged) shot++; }
  }
  escapeReal = real / BRANCHES.length;
  escapeShot = shot / BRANCHES.length;
}

function escapeRisk(ci, plan) {
  if (plan.multiplayer) {
    if (candHit[ci] < HORIZON || escapeFoes === undefined) return 0;
    escapeOddsMultiple(ci, escapeFoes);
    const shut = 1 - escapeReal, exposed = 1 - escapeShot;
    const duel = plan.duel && escapeFoes.length === 1 && escapeFoes[0].enemy.id === plan.targetId;
    return TUNE.escapeCost * shut * shut + TUNE.shotEscapeCost * exposed * exposed * (duel ? TUNE.duelEscapeScale : 1);
  }
  if (candHit[ci] < HORIZON || escapeFoe === undefined) return 0;
  escapeOdds(ci, escapeFoe);
  const shut = 1 - escapeReal, exposed = 1 - escapeShot;
  return TUNE.escapeCost * shut * shut + TUNE.shotEscapeCost * exposed * exposed * (plan.duel ? TUNE.duelEscapeScale : 1);
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
        const weighted = plan.multiplayer && plan.duel && thOwner[j] === plan.targetId
          ? urgent * TUNE.duelThreatScale : urgent;
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
      const weighted = plan.multiplayer && plan.duel && zoneEnemies[z].id === plan.targetId
        ? fade * TUNE.duelThreatScale : fade;
      if (dx * dx + dy * dy < zone2 && weighted > zone) zone = weighted;
    }
    for (let m = 0; m < mineHazards.length; m++) {
      const mine = mineHazards[m];
      if (k < mine.armStep) continue;
      const dx = x - mine.x, dy = y - mine.y, d2 = dx * dx + dy * dy;
      if (d2 < mine.trigger2) hitStep = k;
      else if (d2 < mine.blast2 && fade > soft) soft = fade; // 敌人随时引爆：要逃，但不算必中。
    }
    if (k < LASER_STEPS) {
      for (let s = 0; s < laserSegCount; s++) {
        const b = s * 5;
        if (laserSegs[b + 4] > laser && segDist2(x, y, laserSegs[b], laserSegs[b + 1], laserSegs[b + 2], laserSegs[b + 3]) < laser2) {
          laser = laserSegs[b + 4];
        }
      }
    }
    for (let t = 0; t < trampleSpots.length; t++) {
      const dx = x - trampleSpots[t].x, dy = y - trampleSpots[t].y;
      if (dx * dx + dy * dy < loot2) trample = 1;
    }
  }
  const threat = plan.duel && !plan.multiplayer ? TUNE.duelThreatScale : 1;
  let risk = soft * TUNE.softCost + virtual * TUNE.virtualCost * threat + laser * TUNE.laserCost + trample * TUNE.trampleCost + zone * TUNE.zoneCost * threat;
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

// 连续追瞄：每个预测步从本车的候选位置重新算提前角，
// 避免把一整段移动/横穿后的射击机会等同于当前车位的一条固定朝向。
// 只使用既有公开轨迹预测，保持同一套来弹、退路、价值网络择优。
function addTrackingManeuver(me, plan, move) {
  if (candCount >= MAX_CANDIDATES) return;
  const track = plan.aimTrack, ci = candCount++, base = ci * HORIZON;
  specKnown[ci] = 0;
  sx = me.x;
  sy = me.y;
  sa = me.angle;
  for (let k = 0; k < HORIZON; k++) {
    let at = k;
    if (me.laserShots <= 0) {
      // 两次位置迭代覆盖敌方运动造成的飞行时间变化。
      for (let j = 0; j < 2; j++) {
        const flight = Math.max(0, Math.hypot(track.px[at] - sx, track.py[at] - sy) - P.muzzleOffset) / P.bulletSpeed;
        at = Math.min(PRED_STEPS - 1, k + Math.round(flight / (dt * STEP_TICKS)));
      }
    }
    const angle = Math.atan2(track.py[at] - sy, track.px[at] - sx);
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
function generateCandidates(me, plan) {
  if (candidatesReady) return;
  candidatesReady = true;
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
  if (plan.aimTrack && clearSegment(me.x, me.y, plan.aimTrack.px[0], plan.aimTrack.py[0], P.bulletRadius)) {
    for (const move of [0, 1, -1]) addTrackingManeuver(me, plan, move);
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

let escapeFoe;
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
  let foe = null, nearest = Infinity;
  const nearFoes = plan.multiplayer ? [] : null;
  for (const enemy of state.enemies) {
    if (!enemy.alive || !armedWithin(enemy, state, 0.6)) continue;
    const gap = Math.hypot(enemy.x - me.x, enemy.y - me.y);
    if (nearFoes && gap <= 340) nearFoes.push({ enemy,
      ready: enemy.laserShots > 0 || enemy.scatterShots > 0 ? enemy.cooldown : reloadIn(enemy, state) });
    if (gap < nearest) {
      nearest = gap;
      foe = enemy;
    }
  }
  if (nearest > 340) foe = null;
  let realThreats = 0;
  for (let j = 0; j < threatCount; j++) if (!thVirtual[j]) realThreats++;
  escapeFoe = foe || realThreats > 0 ? foe : undefined;
  escapeFoes = nearFoes && (nearFoes.length || realThreats > 0) ? nearFoes : undefined;
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
  const valueTarget = VALUE_NET && mem.targetId !== null ? state.enemies.find(enemy => enemy.id === mem.targetId) : null;
  const valueTrack = valueTarget ? mem.tracks.get(valueTarget.id) : null;
  const useValue = !!(valueTrack && valueTrack.predicted);
  let planValue = 0, planDie = 0;
  if (useValue) {
    planValue = valueRisk(0, state, valueTarget, valueTrack);
    planDie = valueDie;
  }
  let chosen = 0;
  if (unsticking || candHit[0] < HORIZON || candRisk[0] >= TUNE.calmCost || planDie >= TUNE.valueCalm) {
    generateCandidates(me, plan);
    let anySafe = false;
    for (let ci = 0; ci < candCount && !anySafe; ci++) anySafe = candHit[ci] >= HORIZON;
    if (!anySafe) generateRescue(me, plan);
    if (unsticking) candCost[0] += TUNE.hitCost;
    for (let ci = 0; ci < candCount; ci++) {
      let cost = candCost[ci];
      if (ci === contIndex || (ci === 0 && mem.lastCandidate === 0)) cost -= TUNE.commitBonus;
      if (unsticking && candMove[ci] * mem.unstickMove <= 0) cost += TUNE.softCost;
      if (useValue && candHit[ci] >= VALUE_STEP) cost += ci === 0 ? planValue : valueRisk(ci, state, valueTarget, valueTrack);
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

// 开火后必须至少还有一条既躲得开场上来弹、也躲得开这发回弹的路。
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
  modelOpponent(state);
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
  addModeledShot(state);
  const plan = makePlan(state, target);
  const motion = chooseMotion(state, plan);
  if (plan.kind !== 'path' || motion.ci !== 0) mem.pathWaypoint = null;
  const fire = chooseFire(state, plan, motion);
  const special = chooseMine(state, motion);
  mem.lastMove = motion.move;
  mem.lastCandidate = motion.ci;
  const spent = clock() - started;
  if (spent > TUNE.softBudgetMs) mem.scale = Math.max(0.3, mem.scale * 0.85);
  else if (spent < TUNE.softBudgetMs * 0.4) mem.scale = Math.min(1, mem.scale * 1.02);
  return { move: motion.move, turn: motion.turn, fire, special };
}

// Public-state opponent model: an embedded, unmodified decision architecture is
// an extra motion expert, not access to an opponent instance or its private state.
// No name/source matching: any remaining opponent is modelled the same way.
const modelBook = new Map();
let modeledOpponent = null;
function modelOpponent(state) {
  const alive = state.enemies.filter(enemy => enemy.alive);
  modeledOpponent = null;
  if (alive.length !== 1) return;
  const enemy = alive[0];
  let record = modelBook.get(enemy.id);
  if (!record) {
    record = { bot: createDecisionModel(), pending: [], error: 0 };
    modelBook.set(enemy.id, record);
  }
  for (const prediction of record.pending) if (prediction.tick === state.tick) {
    record.error = record.error * 0.8 + Math.hypot(enemy.x - prediction.x, enemy.y - prediction.y) * 0.2;
  }
  record.pending = record.pending.filter(prediction => prediction.tick > state.tick);
  const predicted = record.bot.update({ ...state, self: enemy,
    enemies: [state.self, ...state.enemies.filter(other => other.id !== enemy.id)] });
  record.pending.push({ tick: state.tick + 2, x: predicted.px[0], y: predicted.py[0] });
  modeledOpponent = { id: enemy.id, ...predicted, confidence: Math.max(0, 1 - record.error / 10) };
}
function useModeledTrajectory() {
  if (!modeledOpponent) return;
  const track = mem.tracks.get(modeledOpponent.id);
  if (!track.predicted) return;
  for (let k = 0; k < 18; k++) {
    const weight = modeledOpponent.confidence * (1 - k / 18);
    track.px[k] += (modeledOpponent.px[k] - track.px[k]) * weight;
    track.py[k] += (modeledOpponent.py[k] - track.py[k]) * weight;
  }
}
function createDecisionModel() {
// Opus Gen1「先机」PRESCIENCE
// Tank Trouble 竞技 AI：自包含单文件，只使用 API.md 的公开状态。
// 每 Tick 流程：观测入账 → 威胁表 → 战术计划 → 候选轨迹评估 → 开火/布雷判定。
// 运动模型按公开物理常量实现车身与炮管 OBB、厚墙和接触转动，弹道逐 Tick 外推。
// 候选轨迹除当前来弹外还看退路：走到中途再分支，数还有多少路躲得过，以及对手此刻开火躲不躲得掉。
// 离线训练得到两部分，比赛时不再学习；训练规则为关闭道具、关闭内墙破坏的 1v1，其他规则未验证：
//   1. TUNE：候选打分权重与开火门限，用进化策略按对局胜负优化；
//   2. 价值网络：估计候选 0.4 秒后局面的阵亡与击杀概率，用对局结局在 GPU 上训练，权重内嵌于本文件。
// 局内自我迭代（每局从零开始，没有跨局记忆）：
//   1. 运动预测竞选：多个预测器 0.5 秒后对答案，用误差最小者算提前量；
//   2. 闪避账本：预计命中却落空的炮弹抬高对手的闪避估计，从而收紧开火条件；
//   3. 弹道校准：实测弹道预测误差，放大躲弹安全边距；
//   4. 路线纠错：实际卡住的边临时加权，改走其他路；
//   5. 算力调节：实测耗时超标就缩小搜索规模，防止慢设备超时。

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
  valueDie1: 490.9144,           // 价值网络：1 秒内阵亡概率的代价权重。
  valueDie2: 189.6637,           // 价值网络：2 秒内阵亡概率的代价权重。
  valueKill: 229.271,           // 价值网络：2 秒内击杀概率的收益权重。
  valueCalm: 0.0356,          // 计划的 1 秒阵亡概率超过此值时展开候选。
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
const VALUE_STEP = 12;      // 价值网络在候选第 12 步（0.4 秒后）的状态上打分。
const VALUE_LOOK = 18;      // 炮弹危险向前看 18 步（0.6 秒）。
const FEATURES = 48;
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
const laserSegs = new Float64Array(MAX_LASER_SEGMENTS * 5);
let laserSegCount = 0;

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
  const fan = [0, 1, 0.12, 0.7, -0.12, 0.7, 0.3, 0.4, -0.3, 0.4];
  for (let f = 0; f < fan.length; f += 2) {
    const n = traceLaser(enemy.x, enemy.y, enemy.angle + fan[f]);
    for (let i = 0; i + 1 < n && laserSegCount < MAX_LASER_SEGMENTS; i++) {
      const base = laserSegCount++ * 5;
      laserSegs[base] = laserX[i];
      laserSegs[base + 1] = laserY[i];
      laserSegs[base + 2] = laserX[i + 1];
      laserSegs[base + 3] = laserY[i + 1];
      laserSegs[base + 4] = fan[f + 1];
    }
  }
}

function buildThreats(state) {
  const me = state.self;
  const horizonTime = HORIZON * STEP_TICKS * dt;
  const reach = (P.bulletSpeed + P.moveSpeed) * horizonTime + tankR + P.bulletRadius;
  threatCount = 0;
  laserSegCount = 0;
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

function makePlan(state, target) {
  const me = state.self;
  const plan = {
    kind: 'aim', mode: 'hold', move: 0, faceAngle: me.angle, aimAngle: null, aim: null,
    field: null, goalX: me.x, goalY: me.y, startDist: 0, keepAway: 0, keepX: 0, keepY: 0, charging: false, duel: false,
    foeSeen: false, foeX: 0, foeY: 0,
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

// ---------- 价值网络 ----------

// 价值网络权重：GPU 上由对局结果训练（Float32 按 w1,b1,w2,b2,w3,b3 拼接后 base64）。
// 输入 FEATURES 维局面特征，输出 1/2 秒内阵亡、1/2 秒内击杀的 logit 与折扣结局。
const NET_SHAPE = { h1: 64, h2: 64, out: 5 };
const NET_BASE64 = '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';

// 自带解码：比赛环境只承诺纯 JS，不依赖 atob 或 Buffer。
function decodeNet(text, inputs) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) lookup[alphabet.charCodeAt(i)] = i;
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array(text.length / 4 * 3 - padding);
  for (let i = 0, out = 0; i < text.length; i += 4) {
    const a = lookup[text.charCodeAt(i)], b = lookup[text.charCodeAt(i + 1)];
    const c = Math.max(0, lookup[text.charCodeAt(i + 2)]), d = Math.max(0, lookup[text.charCodeAt(i + 3)]);
    const word = (a << 18) | (b << 12) | (c << 6) | d;
    if (out < bytes.length) bytes[out++] = (word >> 16) & 255;
    if (out < bytes.length) bytes[out++] = (word >> 8) & 255;
    if (out < bytes.length) bytes[out++] = word & 255;
  }
  const floats = new Float32Array(bytes.buffer);
  const { h1, h2, out } = NET_SHAPE;
  let at = 0;
  const take = size => floats.subarray(at, at += size);
  return { h1, h2, out, inputs, w1: take(h1 * inputs), b1: take(h1), w2: take(h2 * h1), b2: take(h2), w3: take(out * h2), b3: take(out) };
}

const VALUE_NET = decodeNet(NET_BASE64, FEATURES);

const feat = new Float64Array(FEATURES);
const netHidden1 = new Float64Array(128), netHidden2 = new Float64Array(128), netOut = new Float64Array(8);
const topMiss = new Float64Array(3), topTime = new Float64Array(3), topCos = new Float64Array(3), topSin = new Float64Array(3), topMine = new Float64Array(3);

// 敌方多久后才有下一发：普通弹满额时取自己最老一颗的剩余寿命。
function reloadIn(tank, state) {
  if (tank.bulletsActive < P.maxBullets) return Math.max(0, tank.cooldown);
  let wait = P.bulletLifetime;
  for (const bullet of state.bullets) {
    if (bullet.ownerId === tank.id) wait = Math.min(wait, P.bulletLifetime - bullet.age);
  }
  return wait;
}

// 全部取本车坐标系，泛化到任意朝向与地图。ammo* 取打分所依据的时刻（可能早于当前位姿）。
function fillFeatures(x, y, a, forward, ex, ey, rawAngle, evx, evy, k, minAge, ownId, myActive, foeActive, foeReload, myReload, foeCool, time) {
  const dx = ex - x, dy = ey - y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
  const bearing = Math.atan2(dy, dx), back = bearing + Math.PI;
  // 敌人朝向外推：假定它在 VALUE_STEP 内朝我转，受转速限制。
  const budget = P.turnSpeed * VALUE_STEP * STEP_TICKS * dt, err = wrap(back - rawAngle);
  const ea = rawAngle + clamp(err, -budget, budget);
  const rel = bearing - a, foeRel = back - ea;
  let i = 0;
  feat[i++] = Math.min(d, 600) / 300;
  feat[i++] = Math.min(d, 150) / 150;
  feat[i++] = Math.cos(rel);
  feat[i++] = Math.sin(rel);
  feat[i++] = Math.cos(foeRel);
  feat[i++] = Math.sin(foeRel);
  feat[i++] = clearSegment(x, y, ex, ey, P.bulletRadius) ? 1 : 0;
  const path = fieldTarget[cellIndex(x, y)];
  feat[i++] = path < 12 ? path / 12 : 1;
  feat[i++] = (P.maxBullets - myActive) / P.maxBullets;
  feat[i++] = (P.maxBullets - foeActive) / P.maxBullets;
  feat[i++] = Math.min(foeReload, 3) / 3;
  feat[i++] = Math.min(myReload, 3) / 3;
  feat[i++] = Math.min(foeCool, P.fireCooldown) / P.fireCooldown;
  feat[i++] = (evx * ux + evy * uy) / 150;
  feat[i++] = (-evx * uy + evy * ux) / 150;
  const mx = Math.cos(a) * forward, my = Math.sin(a) * forward;
  feat[i++] = forward / 150;
  feat[i++] = (mx * ux + my * uy) / 150;
  feat[i++] = (-mx * uy + my * ux) / 150;
  for (let r = 0; r < 8; r++) {
    const angle = a + r * Math.PI / 4;
    feat[i++] = castRay(x, y, Math.cos(angle), Math.sin(angle), tankR, 160) / 160;
  }
  for (let r = 0; r < 4; r++) {
    const angle = ea + r * Math.PI / 2;
    feat[i++] = castRay(ex, ey, Math.cos(angle), Math.sin(angle), tankR, 160) / 160;
  }
  // 站着不动时最紧迫的三颗炮弹：擦身距离、到达时间、来向、是否己方。
  topMiss.fill(Infinity);
  topTime.fill(1);
  topCos.fill(0);
  topSin.fill(0);
  topMine.fill(0);
  const last = Math.min(HORIZON - 1, k + VALUE_LOOK);
  let close = 0, count = 0;
  for (let j = 0; j < threatCount; j++) {
    if (thVirtual[j] || thAge[j] < minAge) continue;
    count++;
    let best = Infinity, at = k;
    const px = thX[j], py = thY[j], from = k < thFrom[j] ? thFrom[j] : k, to = last < thTo[j] ? last : thTo[j] - 1;
    for (let q = from; q <= to; q++) {
      const gx = px[q] - x, gy = py[q] - y, g2 = gx * gx + gy * gy;
      if (g2 < best) {
        best = g2;
        at = q;
      }
    }
    if (best === Infinity) continue;
    const miss = Math.sqrt(best), urgency = miss + (at - k) * 3;
    if (miss < 60) close++;
    let slot = -1;
    for (let t = 0; t < 3; t++) {
      if (urgency < topMiss[t] + (topTime[t] * VALUE_LOOK) * 3) {
        slot = t;
        break;
      }
    }
    if (slot < 0) continue;
    for (let t = 2; t > slot; t--) {
      topMiss[t] = topMiss[t - 1];
      topTime[t] = topTime[t - 1];
      topCos[t] = topCos[t - 1];
      topSin[t] = topSin[t - 1];
      topMine[t] = topMine[t - 1];
    }
    const nextQ = at + 1 < HORIZON ? at + 1 : at, prevQ = nextQ - 1;
    const heading = Math.atan2(py[nextQ] - py[prevQ], px[nextQ] - px[prevQ]) - a;
    topMiss[slot] = miss;
    topTime[slot] = (at - k) / VALUE_LOOK;
    topCos[slot] = Math.cos(heading);
    topSin[slot] = Math.sin(heading);
    topMine[slot] = thOwner[j] === ownId ? 1 : 0;
  }
  for (let t = 0; t < 3; t++) {
    feat[i++] = topMiss[t] === Infinity ? 1.5 : Math.min(topMiss[t], 120) / 80;
    feat[i++] = topTime[t];
    feat[i++] = topCos[t];
    feat[i++] = topSin[t];
    feat[i++] = topMine[t];
  }
  feat[i++] = close / 4;
  feat[i++] = count / 10;
  feat[i++] = Math.min(time, 60) / 60;
  return i;
}

function netForward(net) {
  const n1 = net.h1, n2 = net.h2, w1 = net.w1, b1 = net.b1, w2 = net.w2, b2 = net.b2, w3 = net.w3, b3 = net.b3, inputs = net.inputs;
  for (let h = 0; h < n1; h++) {
    let sum = b1[h];
    const row = h * inputs;
    for (let f = 0; f < inputs; f++) sum += w1[row + f] * feat[f];
    netHidden1[h] = sum > 0 ? sum : 0;
  }
  for (let h = 0; h < n2; h++) {
    let sum = b2[h];
    const row = h * n1;
    for (let f = 0; f < n1; f++) sum += w2[row + f] * netHidden1[f];
    netHidden2[h] = sum > 0 ? sum : 0;
  }
  for (let o = 0; o < net.out; o++) {
    let sum = b3[o];
    const row = o * n2;
    for (let f = 0; f < n2; f++) sum += w3[row + f] * netHidden2[f];
    netOut[o] = sum;
  }
}

const sigmoid = v => 1 / (1 + Math.exp(-v));

// 候选在 VALUE_STEP 处的状态上估值；输出为代价（越高越差）。
let valueDie = 0;
function valueRisk(ci, state, target, track) {
  const me = state.self, at = ci * HORIZON + VALUE_STEP - 1, k = VALUE_STEP - 1, h = dt * STEP_TICKS;
  const x = rollX[at], y = rollY[at], a = rollA[at];
  const forward = ((x - rollX[at - 1]) * Math.cos(a) + (y - rollY[at - 1]) * Math.sin(a)) / h;
  fillFeatures(x, y, a, forward, track.px[k], track.py[k], target.angle, (track.px[k] - track.px[k - 1]) / h, (track.py[k] - track.py[k - 1]) / h,
    VALUE_STEP, 0, me.id, me.bulletsActive, target.bulletsActive, reloadIn(target, state), reloadIn(me, state), target.cooldown, state.time);
  netForward(VALUE_NET);
  valueDie = sigmoid(netOut[0]);
  return TUNE.valueDie1 * valueDie + TUNE.valueDie2 * sigmoid(netOut[1]) - TUNE.valueKill * sigmoid(netOut[3]);
}

// ---------- 候选轨迹 ----------

function objective(ci, plan) {
  const last = ci * HORIZON + HORIZON - 1;
  let value = 0;
  if (plan.field) {
    const end = goalDist(plan.field, plan.goalX, plan.goalY, rollX[last], rollY[last]);
    value += TUNE.progressWeight * (plan.startDist - end) / (HORIZON * moveStep);
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
function escapeOdds(ci, foe) {
  const k0 = Math.min(HORIZON - 8, Math.max(2, Math.round(TUNE.escapeAt))), at = ci * HORIZON + k0 - 1;
  const x0 = rollX[at], y0 = rollY[at], a0 = rollA[at];
  const hitR = tankR + P.bulletRadius + 1, hit2 = hitR * hitR;
  const stride = P.bulletSpeed * dt * STEP_TICKS;
  let shotOn = false, ex = 0, ey = 0, ux = 0, uy = 0, reach = 0;
  if (foe) {
    const track = mem.tracks.get(foe.id);
    ex = track && track.predicted ? track.px[k0 - 1] : foe.x;
    ey = track && track.predicted ? track.py[k0 - 1] : foe.y;
    const gap = Math.hypot(x0 - ex, y0 - ey);
    if (gap > 1 && clearSegment(ex, ey, x0, y0, P.bulletRadius)) {
      shotOn = true;
      ux = (x0 - ex) / gap;
      uy = (y0 - ey) / gap;
      reach = gap + hitR + stride;
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
      if (shotOn && dodged) {
        const flown = P.muzzleOffset + stride * (i + 1);
        if (flown < reach) {
          const dx = sx - ex - ux * flown, dy = sy - ey - uy * flown;
          if (dx * dx + dy * dy < hit2) dodged = false;
        }
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
  if (candHit[ci] < HORIZON || escapeFoe === undefined) return 0;
  escapeOdds(ci, escapeFoe);
  const shut = 1 - escapeReal, exposed = 1 - escapeShot;
  return TUNE.escapeCost * shut * shut + TUNE.shotEscapeCost * exposed * exposed * (plan.duel ? TUNE.duelEscapeScale : 1);
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
        if (d2 < hit2 && urgent > virtual) virtual = urgent;
      } else if (d2 < hit2) {
        hitStep = k;
      } else {
        const graze = (softR - Math.sqrt(d2)) / mem.margin * fade;
        if (graze > soft) soft = graze;
      }
    }
    for (let z = 0; z < zoneEnemies.length; z++) {
      const dx = x - zoneEnemies[z].x, dy = y - zoneEnemies[z].y;
      if (dx * dx + dy * dy < zone2 && fade > zone) zone = fade;
    }
    for (let m = 0; m < mineHazards.length; m++) {
      const mine = mineHazards[m];
      if (k < mine.armStep) continue;
      const dx = x - mine.x, dy = y - mine.y, d2 = dx * dx + dy * dy;
      if (d2 < mine.trigger2) hitStep = k;
      else if (d2 < mine.blast2 && fade > soft) soft = fade; // 敌人随时引爆：要逃，但不算必中。
    }
    if (k < LASER_STEPS) {
      for (let s = 0; s < laserSegCount; s++) {
        const b = s * 5;
        if (laserSegs[b + 4] > laser && segDist2(x, y, laserSegs[b], laserSegs[b + 1], laserSegs[b + 2], laserSegs[b + 3]) < laser2) {
          laser = laserSegs[b + 4];
        }
      }
    }
    for (let t = 0; t < trampleSpots.length; t++) {
      const dx = x - trampleSpots[t].x, dy = y - trampleSpots[t].y;
      if (dx * dx + dy * dy < loot2) trample = 1;
    }
  }
  const threat = plan.duel ? TUNE.duelThreatScale : 1;
  let risk = soft * TUNE.softCost + virtual * TUNE.virtualCost * threat + laser * TUNE.laserCost + trample * TUNE.trampleCost + zone * TUNE.zoneCost * threat;
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
function generateCandidates(me, plan) {
  if (candidatesReady) return;
  candidatesReady = true;
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

let escapeFoe;
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
  let foe = null, nearest = Infinity;
  for (const enemy of state.enemies) {
    if (!enemy.alive || !armedWithin(enemy, state, 0.6)) continue;
    const gap = Math.hypot(enemy.x - me.x, enemy.y - me.y);
    if (gap < nearest) {
      nearest = gap;
      foe = enemy;
    }
  }
  if (nearest > 340) foe = null;
  let realThreats = 0;
  for (let j = 0; j < threatCount; j++) if (!thVirtual[j]) realThreats++;
  escapeFoe = foe || realThreats > 0 ? foe : undefined;
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
  const valueTarget = VALUE_NET && mem.targetId !== null ? state.enemies.find(enemy => enemy.id === mem.targetId) : null;
  const valueTrack = valueTarget ? mem.tracks.get(valueTarget.id) : null;
  const useValue = !!(valueTrack && valueTrack.predicted);
  let planValue = 0, planDie = 0;
  if (useValue) {
    planValue = valueRisk(0, state, valueTarget, valueTrack);
    planDie = valueDie;
  }
  let chosen = 0;
  if (unsticking || candHit[0] < HORIZON || candRisk[0] >= TUNE.calmCost || planDie >= TUNE.valueCalm) {
    generateCandidates(me, plan);
    let anySafe = false;
    for (let ci = 0; ci < candCount && !anySafe; ci++) anySafe = candHit[ci] >= HORIZON;
    if (!anySafe) generateRescue(me, plan);
    if (unsticking) candCost[0] += TUNE.hitCost;
    for (let ci = 0; ci < candCount; ci++) {
      let cost = candCost[ci];
      if (ci === contIndex || (ci === 0 && mem.lastCandidate === 0)) cost -= TUNE.commitBonus;
      if (unsticking && candMove[ci] * mem.unstickMove <= 0) cost += TUNE.softCost;
      if (useValue && candHit[ci] >= VALUE_STEP) cost += ci === 0 ? planValue : valueRisk(ci, state, valueTarget, valueTrack);
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

// 开火后必须至少还有一条既躲得开场上来弹、也躲得开这发回弹的路。
function canSurviveShot(me, plan, motion, pellets) {
  if (!shotHitsRollout(motion.ci, pellets)) return true;
  generateCandidates(me, plan);
  for (let ci = 0; ci < candCount; ci++) {
    if (candHit[ci] >= HORIZON && !shotHitsRollout(ci, pellets)) return true;
  }
  return false;
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
  const laser = me.laserShots > 0, scatter = !laser && me.scatterShots > 0;
  if (!laser && !scatter && me.bulletsActive >= P.maxBullets) return false;
  // 射击发生在本 Tick 转向和移动之后。
  sx = me.x;
  sy = me.y;
  sa = me.angle;
  tickTank(motion.move, motion.turn);
  const fireX = sx, fireY = sy, fireAngle = sa;
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
  const base = motion.ci * HORIZON;
  sx = state.self.x; sy = state.self.y; sa = state.self.angle;
  tickTank(motion.move, motion.turn);
  const firingAngle = sa, barrel = muzzleDistance(sx, sy, Math.cos(sa), Math.sin(sa));
  const firingX = sx + Math.cos(sa) * barrel, firingY = sy + Math.sin(sa) * barrel;
  return { firingX, firingY, firingAngle, move: motion.move, turn: motion.turn, fire, special,
    px: rollX.slice(base, base + HORIZON), py: rollY.slice(base, base + HORIZON) };
}

function sanitize(action) {
  return {
    move: Number.isFinite(action.move) ? clamp(action.move, -1, 1) : 0,
    turn: Number.isFinite(action.turn) ? clamp(action.turn, -1, 1) : 0,
    fire: action.fire === true,
    special: action.special === true,
  };
}


return { update: decide };
}


// A source-derived model's imminent trigger is a prediction, never an actual
// opponent command. Retain all normal threats; add a shot only when the model
// has recently predicted the public motion closely. Long trajectory forecasts
// are deliberately not substituted into the ordinary enemy predictors.
function addModeledShot(state) {
  const prediction = modeledOpponent;
  if (!prediction || !prediction.fire || prediction.confidence < 0.7) return;
  const enemy = state.enemies.find(e => e.id === prediction.id);
  if (enemy.laserShots > 0) return;
  const pellets = enemy.scatterShots > 0 ? P.scatter.pellets : 1;
  for (let pellet = 0; pellet < pellets && threatCount < MAX_THREATS; pellet++) {
    const angle = prediction.firingAngle + (pellet - (pellets - 1) / 2) * P.scatter.spreadAngle;
    addRealBullet({ x: prediction.firingX, y: prediction.firingY,
      vx: Math.cos(angle) * P.bulletSpeed, vy: Math.sin(angle) * P.bulletSpeed,
      age: 0, bounces: 0, ownerId: enemy.id }, state.self);
  }
}

module.exports = { update: decide };
