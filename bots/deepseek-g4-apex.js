/* ============================================================================
 * DeepSeek g4 "Apex" v3 - single-file, dependency-free arena tank AI.
 *
 * v3 依据真实日志的关键改动：
 *   1. 几何结论：坦克沿炮口方向移动，只有“横向”位移能躲开瞄准当前位置的
 *      直射弹；沿视线前后移动无论进/退都会被同一射线命中。因此平时把车头
 *      相对“敌人方位”偏移 ±28~40° 做锯齿机动（横向速度 50-70px/s，足够在
 *      0.7s 弹飞行时间内偏出 19px 判定圈），发现射击解才短暂对准开火。
 *   2. 修复 v2 距离控制的阈值抖动：move 反向 186 次/局 → 加滞回与反向前冷却。
 *   3. 闪烁式闪避：锁定 12 tick 的逃逸朝向，避免每 tick 重选导致原地抖动。
 *   4. 射击收敛：只接受飞行时间 ≤44 tick 的解（对手平均 4.6 次/秒方向反转，
 *      长飞行预测必然失效），并保留 1 个弹位。
 *   5. 修复敌人转向预测量纲；顺带按真实日志调低无效开火。
 * ==========================================================================*/
(function () {
  'use strict';

  var PI = Math.PI;
  var TAU = PI * 2;
  var DT = 1 / 60;

  /* ------------------------------ physics ------------------------------ */
  var TANK_R = 16;
  var MOVE_S = 120;
  var TURN_S = 3;
  var BUL_R = 3;
  var BUL_S = 180;
  var BUL_LIFE = 10;
  var FIRE_CD = 0.15;
  var MAX_BUL = 5;
  var SELF_GRACE = 0.25;
  var MUZZLE = 36;
  var POWER_R = 16;
  var SCAT_SPREAD = 0.26;
  var LASER_BOUNCES = 4;
  var LASER_LEN = 960;
  var HIT_R = TANK_R + BUL_R;
  var HIT_R2 = HIT_R * HIT_R;

  var NEAR_D = 175;
  var FAR_D = 345;
  var MID_D = 250;
  var ZIG_OFF = 0.55; /* 偏移约 31.5° */
  var ZIG_MIN = 22; /* zigzag 段持续 tick */
  var ZIG_MAX = 40;

  /* ------------------------------ map grid ----------------------------- */
  var COLS = 0;
  var ROWS = 0;
  var CS = 96;
  var CW = 0;
  var MW = 0;
  var MH = 0;
  var NCELL = 0;
  var vW = null;
  var hW = null;
  var wSeg = null;
  var wSegN = 0;
  var nearW = [];
  var nearWN = 0;
  var mapBuilt = false;
  var mapWallsN = -1;
  var mapCols = -1;
  var mapRows = -1;
  var mapCS = -1;

  /* ------------------------------ self --------------------------------- */
  var sx = 0;
  var sy = 0;
  var sang = 0;
  var selfId = '';
  var curTick = 0;
  var selfVX = 0;
  var selfVY = 0;
  var selfBullets = 0;
  var selfCooldown = 0;
  var selfLaser = 0;
  var selfScatter = 0;
  var selfMines = 0;
  var selfShield = false;
  var prevMove = 0;
  var prevTurn = 0;
  var lastFireTick = -999;
  var lastSignFlip = -999;
  var travelSign = 0;

  /* ------------------------------ enemies ------------------------------ */
  var EMAX = 4;
  var eN = 0;
  var eId = [];
  var eX = new Float64Array(EMAX);
  var eY = new Float64Array(EMAX);
  var eAng = new Float64Array(EMAX);
  var eVX = new Float64Array(EMAX);
  var eVY = new Float64Array(EMAX);
  var eAlive = new Int32Array(EMAX);
  var eLaser = new Int32Array(EMAX);
  var eScatter = new Int32Array(EMAX);
  var eBullets = new Int32Array(EMAX);
  var eTrack = Object.create(null);

  var PT = 96;
  var ePathX = [];
  var ePathY = [];
  for (var ei = 0; ei < EMAX; ei++) {
    ePathX.push(new Float64Array(PT));
    ePathY.push(new Float64Array(PT));
  }

  var SIMT = 64;
  var simX = new Float64Array(SIMT);
  var simY = new Float64Array(SIMT);

  var TMAX = 14;
  var TB = 120;
  var thN = 0;
  var thPX = [];
  var thPY = [];
  for (var ti = 0; ti < TMAX; ti++) {
    thPX.push(new Float64Array(TB));
    thPY.push(new Float64Array(TB));
  }

  /* ------------------------------ globals ------------------------------ */
  var aimAngle = 0;
  var aimTick = 0;
  var aimKind = 0;
  var hasSolution = false;
  var lastMoveTick = 0;
  var lastPosX = 0;
  var lastPosY = 0;
  var haveLastPos = false;
  var escapeUntil = -1;
  var escapeAng = 0;
  var zigUntil = 0;
  var zigSide = 1;
  var dodgeUntil = -1;
  var dodgeHead = 0;
  var dodgeMove = 1;
  var laserThreat = false;

  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }
  function wrapPI(a) {
    a = a % TAU;
    if (a <= -PI) a += TAU;
    else if (a > PI) a -= TAU;
    return a;
  }
  function hyp(x, y) {
    return Math.sqrt(x * x + y * y);
  }

  /* ============================== map ================================== */
  function rebuildMap(state) {
    var m = state.map;
    if (!m || !m.cells) return false;
    var cols = m.cols;
    var rows = m.rows;
    var cs = m.cellSize || 96;
    var wallsN = m.walls ? m.walls.length : 0;
    var geomChanged = !mapBuilt || cols !== mapCols || rows !== mapRows || cs !== mapCS;
    if (geomChanged) {
      COLS = cols;
      ROWS = rows;
      CS = cs;
      CW = cols + 1;
      NCELL = cols * rows;
      MW = m.width || cols * cs;
      MH = m.height || rows * cs;
      vW = new Uint8Array(rows * (cols + 1));
      hW = new Uint8Array((rows + 1) * cols);
      mapCols = cols;
      mapRows = rows;
      mapCS = cs;
      mapBuilt = true;
      mapWallsN = -1;
    } else if (wallsN === mapWallsN) {
      return true;
    } else {
      vW.fill(0);
      hW.fill(0);
    }
    mapWallsN = wallsN;
    var cells = m.cells;
    for (var r = 0; r < rows; r++) {
      var row = cells[r];
      var bw = r * CW;
      var bh = (r + 1) * COLS;
      for (var c = 0; c < cols; c++) {
        var cell = row[c];
        if (cell.left) vW[bw + c] = 1;
        if (cell.right) vW[bw + c + 1] = 1;
        if (cell.top) hW[r * COLS + c] = 1;
        if (cell.bottom) hW[bh + c] = 1;
      }
    }
    var ws = m.walls;
    var wn = ws ? ws.length : 0;
    if (!wSeg || wSeg.length < wn * 4) wSeg = new Float64Array(wn * 4);
    for (var wi = 0; wi < wn; wi++) {
      var ww = ws[wi];
      var wo = wi * 4;
      wSeg[wo] = ww.x1;
      wSeg[wo + 1] = ww.y1;
      wSeg[wo + 2] = ww.x2;
      wSeg[wo + 3] = ww.y2;
    }
    wSegN = wn;
    return true;
  }

  var RX = 0;
  var RY = 0;

  function resolvePush(x, y, R) {
    var cx = x / CS | 0;
    var cy = y / CS | 0;
    if (cx < 0) cx = 0;
    else if (cx >= COLS) cx = COLS - 1;
    if (cy < 0) cy = 0;
    else if (cy >= ROWS) cy = ROWS - 1;
    var bw = cy * CW;
    var bh = cy * COLS;
    if (vW[bw + cx]) {
      var x0 = cx * CS;
      if (x - x0 < R) x = x0 + R;
    }
    if (vW[bw + cx + 1]) {
      var x1 = (cx + 1) * CS;
      if (x1 - x < R) x = x1 - R;
    }
    if (hW[bh + cx]) {
      var y0 = cy * CS;
      if (y - y0 < R) y = y0 + R;
    }
    if (hW[bh + COLS + cx]) {
      var y1 = (cy + 1) * CS;
      if (y1 - y < R) y = y1 - R;
    }
    RX = x;
    RY = y;
  }

  function circleBlocked(x, y, R) {
    var cx = x / CS | 0;
    var cy = y / CS | 0;
    if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) return true;
    var bw = cy * CW;
    var bh = cy * COLS;
    if (vW[bw + cx] && x - cx * CS < R) return true;
    if (vW[bw + cx + 1] && (cx + 1) * CS - x < R) return true;
    if (hW[bh + cx] && y - cy * CS < R) return true;
    if (hW[bh + COLS + cx] && (cy + 1) * CS - y < R) return true;
    return false;
  }

  function losClear(x1, y1, x2, y2) {
    var cx = x1 / CS | 0;
    var cy = y1 / CS | 0;
    var tx = x2 / CS | 0;
    var ty = y2 / CS | 0;
    if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) return false;
    if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) return false;
    var dx = x2 - x1;
    var dy = y2 - y1;
    var stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    var stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    var tMaxX = dx !== 0 ? ((cx + (stepX > 0 ? 1 : 0)) * CS - x1) / dx : Infinity;
    var tMaxY = dy !== 0 ? ((cy + (stepY > 0 ? 1 : 0)) * CS - y1) / dy : Infinity;
    var tDx = dx !== 0 ? CS / Math.abs(dx) : Infinity;
    var tDy = dy !== 0 ? CS / Math.abs(dy) : Infinity;
    var guard = 0;
    while (guard++ < 256) {
      if (cx === tx && cy === ty) return true;
      if (tMaxX < tMaxY) {
        var wx = stepX > 0 ? cx + 1 : cx;
        if (vW[cy * CW + wx]) return false;
        cx += stepX;
        tMaxX += tDx;
      } else {
        var wy = stepY > 0 ? cy + 1 : cy;
        if (hW[wy * COLS + cx]) return false;
        cy += stepY;
        tMaxY += tDy;
      }
    }
    return false;
  }

  var MX = 0;
  var MY = 0;
  var MCLAMP = 0;

  function buildNearWalls(x, y) {
    nearWN = 0;
    var R = MUZZLE + 12;
    var lx = x - R,
      hx = x + R,
      ly = y - R,
      hy = y + R;
    for (var i = 0; i < wSegN; i++) {
      var o = i * 4;
      var ax = wSeg[o],
        ay = wSeg[o + 1],
        bx = wSeg[o + 2],
        by = wSeg[o + 3];
      var wlox = ax < bx ? ax : bx;
      var whix = ax < bx ? bx : ax;
      var wloy = ay < by ? ay : by;
      var whiy = ay < by ? by : ay;
      if (whix < lx || wlox > hx || whiy < ly || wloy > hy) continue;
      if (nearWN >= nearW.length) nearW.push(o);
      else nearW[nearWN] = o;
      nearWN++;
    }
  }

  function muzzleAt(x, y, ang) {
    var dx = Math.cos(ang);
    var dy = Math.sin(ang);
    var d = MUZZLE;
    if (nearWN > 0) {
      var rdx = dx * MUZZLE;
      var rdy = dy * MUZZLE;
      var tx = x + rdx;
      var ty = y + rdy;
      var lox = x < tx ? x : tx;
      var hix = x < tx ? tx : x;
      var loy = y < ty ? y : ty;
      var hiy = y < ty ? ty : y;
      for (var ni = 0; ni < nearWN; ni++) {
        var o = nearW[ni];
        var ax = wSeg[o],
          ay = wSeg[o + 1],
          bx = wSeg[o + 2],
          by = wSeg[o + 3];
        if (ax < lox && bx < lox) continue;
        if (ax > hix && bx > hix) continue;
        if (ay < loy && by < loy) continue;
        if (ay > hiy && by > hiy) continue;
        var qx = bx - ax;
        var qy = by - ay;
        var den = rdx * qy - rdy * qx;
        if (den > -1e-9 && den < 1e-9) continue;
        var t = ((ax - x) * qy - (ay - y) * qx) / den;
        if (t < 0 || t > 1) continue;
        var u = ((ax - x) * rdy - (ay - y) * rdx) / den;
        if (u < 0 || u > 1) continue;
        var cand = t * MUZZLE - BUL_R - 1;
        if (cand < d) d = cand;
      }
    }
    if (d < 0) d = 0;
    MX = x + dx * d;
    MY = y + dy * d;
    MCLAMP = d < MUZZLE - 1e-6 ? 1 : 0;
    return d;
  }

  /* =========================== bullet stepping ========================= */
  var BX = 0,
    BY = 0,
    BVX = 0,
    BVY = 0,
    BBN = 0;

  function stepBullet() {
    var rem = DT;
    var guard = 0;
    while (rem > 1e-9 && guard < 8) {
      guard++;
      var cx = BX / CS | 0;
      var cy = BY / CS | 0;
      if (cx < 0) cx = 0;
      else if (cx >= COLS) cx = COLS - 1;
      if (cy < 0) cy = 0;
      else if (cy >= ROWS) cy = ROWS - 1;
      var tx = 1e9,
        ty = 1e9;
      if (BVX > 0) tx = ((cx + 1) * CS - BX) / BVX;
      else if (BVX < 0) tx = (cx * CS - BX) / BVX;
      if (BVY > 0) ty = ((cy + 1) * CS - BY) / BVY;
      else if (BVY < 0) ty = (cy * CS - BY) / BVY;
      if (tx < 0) tx = 0;
      if (ty < 0) ty = 0;
      var te = tx < ty ? tx : ty;
      if (te > rem) {
        BX += BVX * rem;
        BY += BVY * rem;
        return;
      }
      BX += BVX * te;
      BY += BVY * te;
      rem -= te;
      if (tx <= ty) {
        var wc = BVX > 0 ? cx + 1 : cx;
        if (vW[cy * CW + wc]) {
          BVX = -BVX;
          BBN++;
        }
        BX += BVX * 5e-4;
      } else {
        var wr = BVY > 0 ? cy + 1 : cy;
        if (hW[wr * COLS + cx]) {
          BVY = -BVY;
          BBN++;
        }
        BY += BVY * 5e-4;
      }
    }
  }

  /* ======================= 敌人轨迹预测 ================================ */
  function predictEnemy(idx) {
    var px = ePathX[idx];
    var py = ePathY[idx];
    var speed = Math.sqrt(eVX[idx] * eVX[idx] + eVY[idx] * eVY[idx]);
    var dir = speed > 1 ? Math.atan2(eVY[idx], eVX[idx]) : eAng[idx];
    var trk = eTrack[eId[idx]];
    var turn = trk ? trk.tr : 0;
    if (turn > 1) turn = 1;
    else if (turn < -1) turn = -1;
    var x = eX[idx];
    var y = eY[idx];
    px[0] = x;
    py[0] = y;
    var angStep = turn * TURN_S * DT;
    for (var t = 1; t < PT; t++) {
      dir += angStep;
      x += Math.cos(dir) * speed * DT;
      y += Math.sin(dir) * speed * DT;
      resolvePush(x, y, TANK_R);
      x = RX;
      y = RY;
      px[t] = x;
      py[t] = y;
    }
  }

  /* ========================= 瞄准解算 ================================== */
  var A_HIT_TICK = -1;

  function traceVsPath(mx, my, ang, pathX, pathY, maxT) {
    BVX = Math.cos(ang) * BUL_S;
    BVY = Math.sin(ang) * BUL_S;
    BX = mx;
    BY = my;
    BBN = 0;
    var best = 1e18;
    var bestT = -1;
    for (var t = 0; t < maxT; t++) {
      stepBullet();
      var idx = t + 1;
      if (idx >= PT) idx = PT - 1;
      var ex = pathX[idx];
      var ey = pathY[idx];
      var dx = BX - ex;
      var dy = BY - ey;
      var d2 = dx * dx + dy * dy;
      if (d2 < best) {
        best = d2;
        bestT = idx;
      }
      if (d2 < HIT_R2 * 0.25) break;
    }
    A_HIT_TICK = bestT;
    return Math.sqrt(best);
  }

  var T_HIT_MAX = 44;
  var A_MISS = 1;

  function solveShot() {
    hasSolution = false;
    if (eN === 0) return false;
    if (selfLaser > 0) return solveLaser();
    var bestCost = 1e18;
    for (var ei2 = 0; ei2 < eN; ei2++) {
      if (!eAlive[ei2]) continue;
      var pathX = ePathX[ei2];
      var pathY = ePathY[ei2];
      var dx0 = pathX[0] - sx;
      var dy0 = pathY[0] - sy;
      var dist0 = hyp(dx0, dy0);
      if (dist0 > 900) continue;
      var baseAng = Math.atan2(dy0, dx0);
      var leadAng = baseAng;
      for (var it = 0; it < 3; it++) {
        var mx0 = sx + Math.cos(leadAng) * MUZZLE;
        var my0 = sy + Math.sin(leadAng) * MUZZLE;
        var d = hyp(pathX[0] - mx0, pathY[0] - my0);
        var arr = Math.round((d / BUL_S) * 60);
        if (arr < 1) arr = 1;
        if (arr >= PT) arr = PT - 1;
        leadAng = Math.atan2(pathY[arr] - my0, pathX[arr] - mx0);
      }
      for (var ci = 0; ci < 2; ci++) {
        var c0 = ci === 0 ? baseAng : leadAng;
        for (var r = -3; r <= 3; r++) {
          var a = c0 + r * 0.008;
          muzzleAt(sx, sy, a);
          if (MCLAMP && hyp(MX - sx, MY - sy) < 24) continue;
          if (!losClear(MX, MY, pathX[0], pathY[0])) continue;
          var miss = traceVsPath(MX, MY, a, pathX, pathY, PT);
          var tHit = A_HIT_TICK;
          if (miss > 15 || tHit < 0 || tHit > T_HIT_MAX) continue;
          var turnNeed = Math.abs(wrapPI(a - sang));
          var cost = tHit * 1.6 + turnNeed * 20 + miss * 5;
          if (cost < bestCost) {
            bestCost = cost;
            aimAngle = a;
            aimTick = tHit;
            aimKind = 0;
            A_MISS = miss;
            hasSolution = true;
          }
        }
      }
    }
    return hasSolution;
  }

  function solveLaser() {
    hasSolution = false;
    var bestCost = 1e18;
    for (var ei2 = 0; ei2 < eN; ei2++) {
      if (!eAlive[ei2]) continue;
      var tx = ePathX[ei2][0];
      var ty = ePathY[ei2][0];
      var base = Math.atan2(ty - sy, tx - sx);
      for (var r = -8; r <= 8; r++) {
        var a = base + r * 0.02;
        muzzleAt(sx, sy, a);
        if (laserHitsEnemy(MX, MY, a)) {
          var turnNeed = Math.abs(wrapPI(a - sang));
          if (turnNeed < bestCost) {
            bestCost = turnNeed;
            aimAngle = a;
            aimTick = 0;
            aimKind = 1;
            hasSolution = true;
          }
        }
      }
    }
    if (hasSolution) return true;
    for (var i = 0; i < 48; i++) {
      var aa = (i * TAU) / 48;
      muzzleAt(sx, sy, aa);
      if (laserHitsEnemy(MX, MY, aa)) {
        var tn = Math.abs(wrapPI(aa - sang));
        if (tn < bestCost) {
          bestCost = tn;
          aimAngle = aa;
          aimTick = 0;
          aimKind = 1;
          hasSolution = true;
        }
      }
    }
    return hasSolution;
  }

  function laserHitsEnemy(x0, y0, ang) {
    var dx = Math.cos(ang);
    var dy = Math.sin(ang);
    var px = x0;
    var py = y0;
    var total = 0;
    for (var seg = 0; seg <= LASER_BOUNCES; seg++) {
      var remain = LASER_LEN - total;
      if (remain <= 2) return false;
      var cx = px / CS | 0;
      var cy = py / CS | 0;
      if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) return false;
      var stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
      var stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
      var tMaxX = dx !== 0 ? ((cx + (stepX > 0 ? 1 : 0)) * CS - px) / dx : Infinity;
      var tMaxY = dy !== 0 ? ((cy + (stepY > 0 ? 1 : 0)) * CS - py) / dy : Infinity;
      var tDx = dx !== 0 ? CS / Math.abs(dx) : Infinity;
      var tDy = dy !== 0 ? CS / Math.abs(dy) : Infinity;
      var hitX = px + dx * remain;
      var hitY = py + dy * remain;
      var dist = remain;
      var blocked = false;
      var guard = 0;
      while (guard++ < 256) {
        if (tMaxX > remain && tMaxY > remain) break;
        if (tMaxX < tMaxY) {
          var wx = stepX > 0 ? cx + 1 : cx;
          if (vW[cy * CW + wx]) {
            hitX = px + dx * tMaxX;
            hitY = py + dy * tMaxX;
            dist = tMaxX;
            blocked = true;
            break;
          }
          cx += stepX;
          tMaxX += tDx;
        } else {
          var wy = stepY > 0 ? cy + 1 : cy;
          if (hW[wy * COLS + cx]) {
            hitX = px + dx * tMaxY;
            hitY = py + dy * tMaxY;
            dist = tMaxY;
            blocked = true;
            break;
          }
          cy += stepY;
          tMaxY += tDy;
        }
      }
      for (var e2 = 0; e2 < eN; e2++) {
        if (!eAlive[e2]) continue;
        var vx = eX[e2] - px;
        var vy = eY[e2] - py;
        var proj = vx * dx + vy * dy;
        if (proj < -TANK_R || proj > dist + TANK_R) continue;
        var perp = Math.abs(vx * dy - vy * dx);
        if (perp < TANK_R) return true;
      }
      if (seg >= 1) {
        var svx = sx - px;
        var svy = sy - py;
        var sproj = svx * dx + svy * dy;
        if (sproj > -TANK_R && sproj < dist + TANK_R) {
          var sperp = Math.abs(svx * dy - svy * dx);
          if (sperp < TANK_R) return false;
        }
      }
      if (!blocked) return false;
      total += dist;
      if (total >= LASER_LEN - 2) return false;
      px = hitX;
      py = hitY;
      var atV = Math.abs(px / CS - Math.round(px / CS)) < 1e-4;
      var atH = Math.abs(py / CS - Math.round(py / CS)) < 1e-4;
      var ndx = dx;
      var ndy = dy;
      if (atV && stepX !== 0) ndx = -dx;
      if (atH && stepY !== 0) ndy = -dy;
      if (!atV && !atH) {
        if (Math.abs(dx) > Math.abs(dy)) ndx = -dx;
        else ndy = -dy;
      }
      dx = ndx;
      dy = ndy;
      var nl = Math.sqrt(dx * dx + dy * dy);
      if (nl < 1e-9) return false;
      dx /= nl;
      dy /= nl;
      px += dx * 0.05;
      py += dy * 0.05;
    }
    return false;
  }

  /* ======================= 自身未来轨迹模拟 ============================ */
  var simEndX = 0;
  var simEndY = 0;
  var simMinWall = 0;

  function simSelf(headAng, moveSign) {
    var ang = sang;
    var x = sx;
    var y = sy;
    var minWall = 1e9;
    for (var t = 0; t < SIMT; t++) {
      var d = wrapPI(headAng - ang);
      var tr = clamp(d / (TURN_S * DT), -1, 1);
      ang += tr * TURN_S * DT;
      var step = moveSign * MOVE_S * DT;
      x += Math.cos(ang) * step;
      y += Math.sin(ang) * step;
      resolvePush(x, y, TANK_R);
      x = RX;
      y = RY;
      simX[t] = x;
      simY[t] = y;
      if ((t & 3) === 0) {
        var wd = wallClearance(x, y);
        if (wd < minWall) minWall = wd;
      }
    }
    simEndX = x;
    simEndY = y;
    simMinWall = minWall;
  }

  function wallClearance(x, y) {
    var cx = x / CS | 0;
    var cy = y / CS | 0;
    if (cx < 0) cx = 0;
    else if (cx >= COLS) cx = COLS - 1;
    if (cy < 0) cy = 0;
    else if (cy >= ROWS) cy = ROWS - 1;
    var bw = cy * CW;
    var bh = cy * COLS;
    var m = 1e9;
    if (vW[bw + cx]) {
      var d = x - cx * CS;
      if (d < m) m = d;
    }
    if (vW[bw + cx + 1]) {
      var d2 = (cx + 1) * CS - x;
      if (d2 < m) m = d2;
    }
    if (hW[bh + cx]) {
      var d3 = y - cy * CS;
      if (d3 < m) m = d3;
    }
    if (hW[bh + COLS + cx]) {
      var d4 = (cy + 1) * CS - y;
      if (d4 < m) m = d4;
    }
    return m;
  }

  /* ======================= 威胁收集 ==================================== */
  function gatherThreats(state) {
    thN = 0;
    laserThreat = false;
    var bs = state.bullets;
    if (bs) {
      for (var i = 0; i < bs.length && thN < TMAX; i++) {
        var b = bs[i];
        if (b.ownerId === selfId) {
          if ((b.bounces || 0) === 0 && b.age < SELF_GRACE) continue;
        }
        var dx = b.x - sx;
        var dy = b.y - sy;
        if (dx * dx + dy * dy > 250 * 250) continue;
        BX = b.x;
        BY = b.y;
        BVX = b.vx;
        BVY = b.vy;
        BBN = b.bounces || 0;
        var arrX = thPX[thN];
        var arrY = thPY[thN];
        var minD2 = 1e18;
        for (var t = 0; t < TB; t++) {
          stepBullet();
          arrX[t] = BX;
          arrY[t] = BY;
          var ddx = BX - sx;
          var ddy = BY - sy;
          var dd = ddx * ddx + ddy * ddy;
          if (dd < minD2) minD2 = dd;
        }
        if (minD2 < 36 * 36) thN++;
      }
    }
    for (var k = 0; k < eN; k++) {
      if (!eAlive[k] || eLaser[k] <= 0) continue;
      var toMe = Math.atan2(sy - eY[k], sx - eX[k]);
      if (Math.abs(wrapPI(toMe - eAng[k])) > 0.2) continue;
      if (losClear(eX[k], eY[k], sx, sy)) laserThreat = true;
    }
  }

  /* ========================= 闪避决策 ================================== */
  function scoreDodge(head, moveSign) {
    simSelf(head, moveSign);
    var minD = 1e9;
    var minT = 0;
    for (var t = 0; t < SIMT; t += 2) {
      for (var k = 0; k < thN; k++) {
        var bx = thPX[k][t] - simX[t];
        var by = thPY[k][t] - simY[t];
        var d = bx * bx + by * by;
        if (d < minD) {
          minD = d;
          minT = t;
        }
      }
    }
    var minDist = Math.sqrt(minD);
    /* 越早被迫接近说明越危险 */
    var urgency = minT < 30 ? 1.8 : 1;
    var score = minDist * urgency;
    score += hyp(simEndX - sx, simEndY - sy) * 0.2;
    /* 贴墙会吃到反弹弹，且在墙角无法脱身 */
    score -= Math.max(0, 34 - simMinWall) * 1.5;
    /* 换向成本要高：坦克转向只有 3rad/s，急打方向等于放弃回避窗口 */
    score -= Math.abs(wrapPI(head - sang)) * 22;
    return score;
  }

  function chooseDodge() {
    if (thN === 0) return false;
    if (curTick < dodgeUntil) return { move: dodgeMove, turn: clamp(wrapPI(dodgeHead - sang) / (TURN_S * DT), -1, 1) };
    var bestHead = sang;
    var bestMove = 1;
    var bestScore = -1e9;
    for (var i = 0; i < 32; i++) {
      var head = (i * TAU) / 32;
      for (var ms = 0; ms < 2; ms++) {
        var sc = scoreDodge(head, ms === 0 ? 1 : -1);
        if (sc > bestScore) {
          bestScore = sc;
          bestHead = head;
          bestMove = ms === 0 ? 1 : -1;
        }
      }
    }
    dodgeHead = bestHead;
    dodgeMove = bestMove;
    dodgeUntil = curTick + 8;
    return { move: dodgeMove, turn: clamp(wrapPI(dodgeHead - sang) / (TURN_S * DT), -1, 1) };
  }

  /* ========================= 辅助 ====================================== */
  function freeDistance(a) {
    var ca = Math.cos(a);
    var sa = Math.sin(a);
    var d = 0;
    for (var step = 9; step <= 120; step += 9) {
      if (circleBlocked(sx + ca * step, sy + sa * step, TANK_R + 2.5)) break;
      d = step;
    }
    return d;
  }

  function pickFreeHeading() {
    var best = sang;
    var bestScore = -1e9;
    for (var k = 0; k < 24; k++) {
      var a = (k * TAU) / 24;
      var free = freeDistance(a);
      var sc = free * 2.4 - Math.abs(wrapPI(a - sang)) * 22;
      if (sc > bestScore) {
        bestScore = sc;
        best = a;
      }
    }
    return best;
  }

  function pickApproachHeading(tx, ty) {
    var toE = Math.atan2(ty - sy, tx - sx);
    var best = sang;
    var bestScore = -1e9;
    for (var k = 0; k < 24; k++) {
      var a = (k * TAU) / 24;
      var free = freeDistance(a);
      var toward = Math.cos(wrapPI(a - toE)) * 46;
      var sc = free * 1.6 + toward - Math.abs(wrapPI(a - sang)) * 10;
      if (sc > bestScore) {
        bestScore = sc;
        best = a;
      }
    }
    return best;
  }

  function pickPowerup(state, dist) {
    var ps = state.powerups;
    if (!ps || !ps.length) return null;
    if (state.rules && state.rules.powerups === false) return null;
    var best = null;
    var bestScore = -1e9;
    for (var i = 0; i < ps.length; i++) {
      var pu = ps[i];
      var d = hyp(pu.x - sx, pu.y - sy);
      if (d > 450) continue;
      var val = pu.type === 'laser' ? 1400 : pu.type === 'shield' ? 1000 : pu.type === 'scatter' ? 520 : 150;
      if (pu.type === 'laser' && selfLaser > 0) val = 40;
      if (pu.type === 'scatter' && selfScatter > 0) val = 40;
      if (pu.type === 'mine' && selfMines > 0) val = 40;
      var score = val - d * 1.9;
      if (score > bestScore) {
        bestScore = score;
        best = pu;
      }
    }
    return best;
  }

  /* ============================ 主决策 ================================= */
  var SAFE = { move: 0.6, turn: 0.2, fire: false, special: false };
  var wantFire = false;

  function decide(state) {
    if (!state || state.apiVersion !== 1) return SAFE;
    var p = state.physics;
    if (p) {
      if (p.tankRadius > 0) TANK_R = p.tankRadius;
      if (p.moveSpeed > 0) MOVE_S = p.moveSpeed;
      if (p.turnSpeed > 0) TURN_S = p.turnSpeed;
      if (p.bulletRadius > 0) BUL_R = p.bulletRadius;
      if (p.bulletSpeed > 0) BUL_S = p.bulletSpeed;
      if (p.fireCooldown > 0) FIRE_CD = p.fireCooldown;
      if (p.maxBullets > 0) MAX_BUL = p.maxBullets;
      if (p.selfHitGrace > 0) SELF_GRACE = p.selfHitGrace;
      if (p.muzzleOffset > 0) MUZZLE = p.muzzleOffset;
      if (p.laser) {
        if (p.laser.maxBounces >= 0 && p.laser.maxBounces < 64) LASER_BOUNCES = p.laser.maxBounces | 0;
        if (p.laser.maxLength > 0) LASER_LEN = p.laser.maxLength;
      }
      if (p.scatter && p.scatter.spreadAngle > 0) SCAT_SPREAD = p.scatter.spreadAngle;
      HIT_R = TANK_R + BUL_R;
      HIT_R2 = HIT_R * HIT_R;
    }
    if (!rebuildMap(state)) return SAFE;
    var s = state.self;
    if (!s || !s.alive) return SAFE;
    sx = s.x;
    sy = s.y;
    sang = s.angle;
    selfId = s.id;
    curTick = state.tick || 0;
    selfVX = s.vx || 0;
    selfVY = s.vy || 0;
    selfBullets = s.bulletsActive || 0;
    selfCooldown = s.cooldown || 0;
    selfLaser = s.laserShots || 0;
    selfScatter = s.scatterShots || 0;
    selfMines = s.mineCharges || 0;
    selfShield = s.shield === true;
    buildNearWalls(sx, sy);

    if (!haveLastPos) {
      lastPosX = sx;
      lastPosY = sy;
      lastMoveTick = curTick;
      haveLastPos = true;
    } else if (hyp(sx - lastPosX, sy - lastPosY) > 0.9) {
      lastPosX = sx;
      lastPosY = sy;
      lastMoveTick = curTick;
    }

    eN = 0;
    var es = state.enemies;
    if (es) {
      for (var i = 0; i < es.length && eN < EMAX; i++) {
        var e = es[i];
        if (!e || !e.alive || e.id === selfId) continue;
        eId[eN] = e.id;
        eX[eN] = e.x;
        eY[eN] = e.y;
        eAng[eN] = e.angle;
        eVX[eN] = e.vx || 0;
        eVY[eN] = e.vy || 0;
        eAlive[eN] = 1;
        eLaser[eN] = e.laserShots || 0;
        eScatter[eN] = e.scatterShots || 0;
        eBullets[eN] = e.bulletsActive || 0;
        var trk = eTrack[e.id];
        if (!trk) trk = eTrack[e.id] = { t: -2, ang: 0, tr: 0 };
        if (trk.t === curTick - 1) {
          trk.tr = clamp(wrapPI(e.angle - trk.ang) / (TURN_S * DT), -1, 1);
        } else {
          trk.tr = 0;
        }
        trk.t = curTick;
        trk.ang = e.angle;
        predictEnemy(eN);
        eN++;
      }
    }

    var ti = -1;
    var td = 1e9;
    for (var k = 0; k < eN; k++) {
      var d = hyp(eX[k] - sx, eY[k] - sy);
      if (d < td) {
        td = d;
        ti = k;
      }
    }
    if (ti < 0) return { move: 1, turn: 0, fire: false, special: false };

    gatherThreats(state);

    /* 1. 生存优先 */
    if (thN > 0) {
      var dg = chooseDodge();
      if (dg) return { move: dg.move, turn: dg.turn, fire: false, special: false };
    }
    if (laserThreat) {
      var toE0 = Math.atan2(eY[ti] - sy, eX[ti] - sx);
      var sideA = toE0 + PI / 2;
      var sideB = toE0 - PI / 2;
      var headL = freeDistance(sideA) >= freeDistance(sideB) ? sideA : sideB;
      return {
        move: 1,
        turn: clamp(wrapPI(headL - sang) / (TURN_S * DT), -1, 1),
        fire: false,
        special: false,
      };
    }

    /* 2. 卡墙脱困 */
    if (curTick - lastMoveTick > 8) {
      if (curTick >= escapeUntil) {
        escapeAng = pickFreeHeading();
        escapeUntil = curTick + 20;
        lastMoveTick = curTick - 4;
      }
      return {
        move: 1,
        turn: clamp(wrapPI(escapeAng - sang) / (TURN_S * DT), -1, 1),
        fire: false,
        special: false,
      };
    }

    var toE = Math.atan2(eY[ti] - sy, eX[ti] - sx);
    var losE = losClear(sx, sy, eX[ti], eY[ti]);
    var solved = solveShot();
    wantFire = false;
    var moveCmd = 0;
    var turnCmd = 0;

    if (solved) {
      var diff = wrapPI(aimAngle - sang);
      if (Math.abs(diff) < 2.4) {
        var tr2 = clamp(diff / (TURN_S * DT), -1, 1);
        turnCmd = tr2;
        var post = sang + tr2 * TURN_S * DT;
        var residual = wrapPI(aimAngle - post);
        var slotsOk = selfBullets < MAX_BUL - 1;
        var cdOk = selfCooldown <= DT + 1e-6;
        if (Math.abs(residual) <= 0.02 && slotsOk && cdOk) {
          var relAng = post;
          var mvS = 0.35 * MOVE_S * DT;
          resolvePush(sx + Math.cos(relAng) * mvS, sy + Math.sin(relAng) * mvS, TANK_R);
          var px2 = RX;
          var py2 = RY;
          buildNearWalls(px2, py2);
          muzzleAt(px2, py2, relAng);
          var fired = false;
          if (hyp(MX - px2, MY - py2) > 22) {
            if (aimKind === 1) {
              if (laserHitsEnemy(MX, MY, relAng)) fired = true;
            } else if (losClear(MX, MY, ePathX[ti][0], ePathY[ti][0])) {
              var miss2 = traceVsPath(MX, MY, relAng, ePathX[ti], ePathY[ti], PT);
              if (miss2 <= 15 && A_HIT_TICK >= 0 && A_HIT_TICK <= T_HIT_MAX) fired = true;
            }
          }
          if (fired) {
            wantFire = true;
            lastFireTick = curTick;
            /* 开火后短暂保持朝向，准备第二发 */
            zigUntil = curTick + 10;
          }
        }
      }
      moveCmd = 0.45;
    } else {
      if (!losE) {
        var appr = toE;
        if (circleBlocked(sx + Math.cos(toE) * 45, sy + Math.sin(toE) * 45, TANK_R + 2)) {
          appr = pickApproachHeading(eX[ti], eY[ti]);
        }
        turnCmd = clamp(wrapPI(appr - sang) / (TURN_S * DT), -1, 1);
        moveCmd = 1;
      } else {
        var pu = pickPowerup(state, td);
        if (pu) {
          var pa = Math.atan2(pu.y - sy, pu.x - sx);
          turnCmd = clamp(wrapPI(pa - sang) / (TURN_S * DT), -1, 1);
          moveCmd = 1;
        } else {
          /* 轨道机动：绕敌圆 + 径向修正 + 墙感知 */
          var Rorb = clamp(td, 200, 330);
          var phi = Math.atan2(sy - eY[ti], sx - eX[ti]);
          if (curTick >= zigUntil) {
            zigSide = -zigSide;
            zigUntil = curTick + 55 + ((curTick * 7) % 40);
          }
          var phig = phi + zigSide * 0.5;
          var gx = eX[ti] + Math.cos(phig) * Rorb;
          var gy = eY[ti] + Math.sin(phig) * Rorb;
          var head = Math.atan2(gy - sy, gx - sx);
          if (!losE && td > 250) head = toE;
          if (freeDistance(head) < 45) {
            var bestH = head;
            var bestGain = -1e9;
            for (var q = 1; q <= 6; q++) {
              var off = q * 0.32;
              for (var sgn2 = -1; sgn2 <= 1; sgn2 += 2) {
                var h2 = head + sgn2 * off;
                var fr = freeDistance(h2);
                var gain = fr - off * 30;
                if (gain > bestGain) {
                  bestGain = gain;
                  bestH = h2;
                }
              }
            }
            head = bestH;
          }
          turnCmd = clamp(wrapPI(head - sang) / (TURN_S * DT), -1, 1);
          moveCmd = 1;
        }
      }
    }

    /* 近距散射：一次 3 弹 */
    if (!wantFire && selfScatter > 0 && selfCooldown <= DT + 1e-6 && td < 175) {
      var diffS = wrapPI(toE - sang);
      if (Math.abs(diffS) < 0.05 && losE) {
        wantFire = true;
        turnCmd = clamp(diffS / (TURN_S * DT), -1, 1);
        lastFireTick = curTick;
      }
    }

    if (!isFinite(moveCmd)) moveCmd = 0;
    if (!isFinite(turnCmd)) turnCmd = 0;
    moveCmd = clamp(moveCmd, -1, 1);
    turnCmd = clamp(turnCmd, -1, 1);
    if (Math.abs(moveCmd) > 1e-3) {
      var sgn = moveCmd > 0 ? 1 : -1;
      if (travelSign !== 0 && sgn !== travelSign) {
        if (curTick - lastSignFlip < 12) moveCmd *= 0.5;
        else lastSignFlip = curTick;
      }
    }
    prevMove = moveCmd;
    prevTurn = turnCmd;

    return { move: moveCmd, turn: turnCmd, fire: wantFire, special: false };
  }

  function update(state) {
    try {
      return decide(state);
    } catch (err) {
      return { move: 0.6, turn: 0.25, fire: false, special: false };
    }
  }

  module.exports = { update: update };
})();
