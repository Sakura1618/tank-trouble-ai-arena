/* ============================================================================
 * Tank Arena AI - single-file, dependency-free tournament bot.
 *
 * Layered decision pipeline, 60 Hz:
 *   1. Grid ballistics  - exact mirror-bounce trajectory simulation against the
 *                         published wall grid (O(1) edge tests per cell).
 *   2. Threat field     - every nearby bullet is forward-simulated ~1.1 s and
 *                         compared, time-aligned, with all candidate self
 *                         trajectories; the earliest interception is recorded.
 *   3. Movement (MPC)   - 54 (move x turn) candidates are simulated for 1.1 s
 *                         and scored: safety dominates, then travel-direction
 *                         progress, barrel alignment and exposure penalties.
 *   4. Aiming           - current-bearing interception test, analytic direct
 *                         line-of-sight lead, and a reflective fan search; the
 *                         cheapest turn that provably intercepts wins.
 *   5. Self-harm guard  - every shot is traced against our own planned
 *                         trajectory, so a bounced bullet can never hit us.
 *   6. Weapons          - laser (instant reflective ray), scatter spray, area
 *                         denial mines, shield / powerup economy.
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
  var SCAT_SPREAD = 0.26;
  var DANGER_R = 22;
  var DANGER_R2 = DANGER_R * DANGER_R;
  var SELF_RISK2 = 23 * 23;
  var LASER_BOUNCES = 4;
  var LASER_LEN = 960;
  var MINE_TRIG = 40;
  var MINE_BLAST = 60;

  /* ------------------------------ map grid ----------------------------- */
  var CS = 96;
  var COLS = 0;
  var ROWS = 0;
  var CW = 0;
  var NCELL = 0;
  var MW = 0;
  var MH = 0;
  var vW = null;
  var hW = null;
  var mapBuilt = false;
  var mapWalls = -1;
  var mapCols = -1;
  var mapRows = -1;
  var mapCS = -1;

  /* --------------------------- search buffers -------------------------- */
  var astG = null;
  var expoCost = null;
  var astFrom = null;
  var astClosed = null;
  var heapN = null;
  var heapF = null;
  var heapSize = 0;
  var pathCells = null;

  /* ------------------------- candidate buffers ------------------------- */
  var MOVES = [1, 0.82, 0.62, 0.4, 0.2, 0, -0.6, -0.82, -1];
  var TURNS = [-1, -0.78, -0.55, -0.32, -0.14, 0, 0.14, 0.32, 0.55, 0.78, 1];
  var NMC = MOVES.length; /* 6 */
  var NTC = TURNS.length; /* 9 */
  var MAXC = NMC * NTC; /* 54 */
  var SIMT = 132; /* 2.2 s of self-motion */
  var PT = 132; /* 2.2 s of enemy prediction */
  var candX = new Float32Array(MAXC * SIMT);
  var candY = new Float32Array(MAXC * SIMT);
  var candMin = new Float32Array(MAXC);
  var candDng = new Float32Array(MAXC);
  var candMv = new Float32Array(MAXC);
  var candTr = new Float32Array(MAXC);
  var NCAND = 0;
  var turnCos = new Float32Array(NTC);
  var turnSin = new Float32Array(NTC);

  /* --------------------------- threat buffers -------------------------- */
  var TMAX = 24;
  var tbX = new Float64Array(TMAX);
  var tbY = new Float64Array(TMAX);
  var tbVX = new Float64Array(TMAX);
  var tbVY = new Float64Array(TMAX);
  var tbGr = new Int32Array(TMAX);
  var tbBn = new Int32Array(TMAX);
  var tbD2 = new Float64Array(TMAX);
  var tbN = 0;

  /* ------------------------- enemy predictions ------------------------- */
  var EMAX = 4;
  var epX = new Float64Array(EMAX * PT);
  var epY = new Float64Array(EMAX * PT);
  var epAngle = new Float64Array(EMAX);
  var epN = 0;
  var epThreat = new Float64Array(EMAX); /* how much this foe aims at us */
  var hist = Object.create(null);

  /* ------------------------------ globals ------------------------------ */
  var sx = 0;
  var sy = 0;
  var sang = 0;
  var selfId = '';
  var curTick = 0;
  var RX = 0;
  var RY = 0;

  var BX = 0;
  var BY = 0;
  var BVX = 0;
  var BVY = 0;
  var BBN = 0;

  var ownMines = [];
  var seenMines = [];
  var strafeSign = 1;
  var strafePhase = 0;
  var strafePeriod = 90;
  var lastFireTick = 0;
  var selfShield = false;
  var prevMove = 0;
  var prevTurn = 0;

  var HIT2 = 19 * 19;

  var SAFE_ACTION = { move: 0, turn: 0, fire: false, special: false };

  var aimAngles = new Float64Array(512);
  var aimAngle = 0;
  var aimValid = false;
  var aimHit = false;
  var aimMinD2 = 1e18;

  var laserAng = 0;
  var laserValid = false;

  var goalX = 0;
  var goalY = 0;
  var moveDirX = 1;
  var moveDirY = 0;
  var bestCand = 0;
  var closestEnemyD = 1e9;
  var hasLaserShot = false;
  var hasScatterShot = false;
  var hasMines = false;

  /* ============================ utilities ============================== */

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

  function allocSearch(n) {
    astG = new Int32Array(n);
    expoCost = new Float32Array(n);
    astFrom = new Int32Array(n);
    astClosed = new Uint8Array(n);
    heapN = new Int32Array(n * 5 + 8);
    heapF = new Int32Array(n * 5 + 8);
    pathCells = new Int32Array(n);
    heapSize = 0;
  }

  function rebuildMap(state) {
    var m = state.map;
    if (!m || !m.cells) return false;
    var cols = m.cols;
    var rows = m.rows;
    var cs = m.cellSize || 96;
    var wallsN = m.walls ? m.walls.length : 0;
    var geomChanged =
      !mapBuilt || cols !== mapCols || rows !== mapRows || cs !== mapCS;
    if (geomChanged) {
      COLS = cols;
      ROWS = rows;
      CS = cs;
      CW = cols + 1;
      NCELL = cols * rows;
      MW = m.width;
      MH = m.height;
      vW = new Uint8Array(rows * (cols + 1));
      hW = new Uint8Array((rows + 1) * cols);
      allocSearch(NCELL);
      mapCols = cols;
      mapRows = rows;
      mapCS = cs;
      mapBuilt = true;
      mapWalls = -1;
    } else if (wallsN === mapWalls) {
      return true;
    } else {
      vW.fill(0);
      hW.fill(0);
    }
    mapWalls = wallsN;
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
    return true;
  }

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

  /* distance from a point to the nearest wall of its own cell */
  function wallDist(x, y) {
    var cx = x / CS | 0;
    var cy = y / CS | 0;
    if (cx < 0) cx = 0;
    else if (cx >= COLS) cx = COLS - 1;
    if (cy < 0) cy = 0;
    else if (cy >= ROWS) cy = ROWS - 1;
    var bw = cy * CW;
    var bh = cy * COLS;
    var m = 1e9;
    var d;
    if (vW[bw + cx]) {
      d = x - cx * CS;
      if (d < m) m = d;
    }
    if (vW[bw + cx + 1]) {
      d = (cx + 1) * CS - x;
      if (d < m) m = d;
    }
    if (hW[bh + cx]) {
      d = y - cy * CS;
      if (d < m) m = d;
    }
    if (hW[bh + COLS + cx]) {
      d = (cy + 1) * CS - y;
      if (d < m) m = d;
    }
    return m;
  }

  function lineClear(x1, y1, x2, y2) {
    var dx = x2 - x1;
    var dy = y2 - y1;
    var len2 = dx * dx + dy * dy;
    if (len2 < 4) return true;
    var len = Math.sqrt(len2);
    var steps = Math.ceil(len / 9);
    var ux = dx / len;
    var uy = dy / len;
    var R = TANK_R + 1.3;
    for (var i = 1; i <= steps; i++) {
      var d = (i * len) / steps;
      if (d < TANK_R + 2) continue;
      if (circleBlocked(x1 + ux * d, y1 + uy * d, R)) return false;
    }
    return true;
  }

  /* zero-width line-of-sight test for bullets */
  function ddaClear(x1, y1, x2, y2) {
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
    var tMaxX =
      dx !== 0 ? ((cx + (stepX > 0 ? 1 : 0)) * CS - x1) / dx : Infinity;
    var tMaxY =
      dy !== 0 ? ((cy + (stepY > 0 ? 1 : 0)) * CS - y1) / dy : Infinity;
    var tDeltaX = dx !== 0 ? CS / Math.abs(dx) : Infinity;
    var tDeltaY = dy !== 0 ? CS / Math.abs(dy) : Infinity;
    var guard = 0;
    while (guard++ < 512) {
      if (cx === tx && cy === ty) return true;
      if (tMaxX < tMaxY) {
        var wx = stepX > 0 ? cx + 1 : cx;
        if (vW[cy * CW + wx]) return false;
        cx += stepX;
        tMaxX += tDeltaX;
      } else {
        var wy = stepY > 0 ? cy + 1 : cy;
        if (hW[wy * COLS + cx]) return false;
        cy += stepY;
        tMaxY += tDeltaY;
      }
    }
    return false;
  }

  /* ============================ A* search ============================== */

  function heapPush(node, f) {
    var i = heapSize++;
    if (i >= heapN.length) {
      heapSize = heapN.length;
      return;
    }
    heapN[i] = node;
    heapF[i] = f;
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (heapF[p] <= heapF[i]) break;
      var tn = heapN[p];
      heapN[p] = heapN[i];
      heapN[i] = tn;
      var tf = heapF[p];
      heapF[p] = heapF[i];
      heapF[i] = tf;
      i = p;
    }
  }

  function heapPop() {
    var top = heapN[0];
    heapSize--;
    if (heapSize > 0) {
      heapN[0] = heapN[heapSize];
      heapF[0] = heapF[heapSize];
      var i = 0;
      for (;;) {
        var l = i * 2 + 1;
        var r = l + 1;
        var m = i;
        if (l < heapSize && heapF[l] < heapF[m]) m = l;
        if (r < heapSize && heapF[r] < heapF[m]) m = r;
        if (m === i) break;
        var tn = heapN[m];
        heapN[m] = heapN[i];
        heapN[i] = tn;
        var tf = heapF[m];
        heapF[m] = heapF[i];
        heapF[i] = tf;
        i = m;
      }
    }
    return top;
  }

  function astar(sCell, gCell, maxExpand) {
    if (!astG) return 0;
    if (sCell === gCell) {
      pathCells[0] = sCell;
      return 1;
    }
    astG.fill(-1);
    astClosed.fill(0);
    heapSize = 0;
    var gc = gCell % COLS;
    var gr = (gCell / COLS) | 0;
    var sc = sCell % COLS;
    var sr = (sCell / COLS) | 0;
    astG[sCell] = 0;
    heapPush(sCell, Math.abs(gc - sc) + Math.abs(gr - sr));
    var best = sCell;
    var bestH = Math.abs(gc - sc) + Math.abs(gr - sr);
    var expanded = 0;
    var limit = maxExpand || NCELL;
    while (heapSize > 0) {
      var cur = heapPop();
      if (astClosed[cur]) continue;
      astClosed[cur] = 1;
      if (cur === gCell) {
        best = gCell;
        break;
      }
      if (++expanded > limit) break;
      var cc = cur % COLS;
      var cr = (cur / COLS) | 0;
      var gcur = astG[cur] + 1;
      var hc = Math.abs(gc - cc) + Math.abs(gr - cr);
      if (hc < bestH) {
        bestH = hc;
        best = cur;
      }
      var bw = cr * CW;
      var bh = cr * COLS;
      var ni;
      if (cc + 1 < COLS && !vW[bw + cc + 1]) {
        ni = cur + 1;
        var gnx = gcur + expoCost[ni];
        if (!astClosed[ni] && (astG[ni] < 0 || gnx < astG[ni])) {
          astG[ni] = gnx;
          astFrom[ni] = cur;
          heapPush(ni, gnx + Math.abs(gc - cc - 1) + Math.abs(gr - cr));
        }
      }
      if (cc > 0 && !vW[bw + cc]) {
        ni = cur - 1;
        var gnx = gcur + expoCost[ni];
        if (!astClosed[ni] && (astG[ni] < 0 || gnx < astG[ni])) {
          astG[ni] = gnx;
          astFrom[ni] = cur;
          heapPush(ni, gnx + Math.abs(gc - cc + 1) + Math.abs(gr - cr));
        }
      }
      if (cr + 1 < ROWS && !hW[bh + COLS + cc]) {
        ni = cur + COLS;
        var gnx = gcur + expoCost[ni];
        if (!astClosed[ni] && (astG[ni] < 0 || gnx < astG[ni])) {
          astG[ni] = gnx;
          astFrom[ni] = cur;
          heapPush(ni, gnx + Math.abs(gc - cc) + Math.abs(gr - cr - 1));
        }
      }
      if (cr > 0 && !hW[bh + cc]) {
        ni = cur - COLS;
        var gnx = gcur + expoCost[ni];
        if (!astClosed[ni] && (astG[ni] < 0 || gnx < astG[ni])) {
          astG[ni] = gnx;
          astFrom[ni] = cur;
          heapPush(ni, gnx + Math.abs(gc - cc) + Math.abs(gr - cr + 1));
        }
      }
    }
    var n = 0;
    var node = best;
    var guard = 0;
    while (node !== sCell && n < NCELL && guard++ < NCELL + 2) {
      pathCells[n++] = node;
      node = astFrom[node];
    }
    pathCells[n++] = sCell;
    for (var a = 0, b = n - 1; a < b; a++, b--) {
      var t = pathCells[a];
      pathCells[a] = pathCells[b];
      pathCells[b] = t;
    }
    return n;
  }

  /* =========================== bullet engine =========================== */

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
      var tx = 1e9;
      var ty = 1e9;
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

  /* ======================== self prediction =========================== */

  function buildCandidates() {
    var ti;
    for (ti = 0; ti < NTC; ti++) {
      turnCos[ti] = Math.cos(TURNS[ti] * TURN_S * DT);
      turnSin[ti] = Math.sin(TURNS[ti] * TURN_S * DT);
    }
    var n = 0;
    for (var mi = 0; mi < NMC; mi++) {
      var step = MOVES[mi] * MOVE_S * DT;
      for (var t2 = 0; t2 < NTC; t2++) {
        var dc = turnCos[t2];
        var ds = turnSin[t2];
        var px = sx;
        var py = sy;
        var ca = Math.cos(sang);
        var sa = Math.sin(sang);
        for (var t = 0; t < SIMT; t++) {
          var nca = ca * dc - sa * ds;
          var nsa = sa * dc + ca * ds;
          ca = nca;
          sa = nsa;
          px += ca * step;
          py += sa * step;
          var cx = px / CS | 0;
          var cy = py / CS | 0;
          if (cx < 0) cx = 0;
          else if (cx >= COLS) cx = COLS - 1;
          if (cy < 0) cy = 0;
          else if (cy >= ROWS) cy = ROWS - 1;
          var bw = cy * CW;
          var bh = cy * COLS;
          if (vW[bw + cx]) {
            var x0 = cx * CS;
            if (px - x0 < TANK_R) px = x0 + TANK_R;
          }
          if (vW[bw + cx + 1]) {
            var x1 = (cx + 1) * CS;
            if (x1 - px < TANK_R) px = x1 - TANK_R;
          }
          if (hW[bh + cx]) {
            var y0 = cy * CS;
            if (py - y0 < TANK_R) py = y0 + TANK_R;
          }
          if (hW[bh + COLS + cx]) {
            var y1 = (cy + 1) * CS;
            if (y1 - py < TANK_R) py = y1 - TANK_R;
          }
          /* layout is time-major: [tick * MAXC + candidate] */
          candX[t * MAXC + n] = px;
          candY[t * MAXC + n] = py;
        }
        candMv[n] = MOVES[mi];
        candTr[n] = TURNS[t2];
        n++;
      }
    }
    NCAND = n;
  }

  /* ========================= threat collection ========================= */

  function collectThreats(state) {
    tbN = 0;
    var bs = state.bullets;
    if (!bs || !bs.length) return;
    var maxD2 = 600 * 600;
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i];
      var dx = b.x - sx;
      var dy = b.y - sy;
      var d2 = dx * dx + dy * dy;
      if (d2 > maxD2) continue;
      var grace = 0;
      if (b.ownerId === selfId && b.bounces === 0 && b.age < SELF_GRACE) {
        var g = (SELF_GRACE - b.age) * 60;
        if (g > 0) grace = Math.ceil(g);
      }
      var pos = tbN;
      if (tbN >= TMAX) {
        if (d2 >= tbD2[tbN - 1]) continue;
        pos = tbN - 1;
      } else {
        tbN++;
      }
      while (pos > 0 && tbD2[pos - 1] > d2) {
        tbX[pos] = tbX[pos - 1];
        tbY[pos] = tbY[pos - 1];
        tbVX[pos] = tbVX[pos - 1];
        tbVY[pos] = tbVY[pos - 1];
        tbGr[pos] = tbGr[pos - 1];
        tbBn[pos] = tbBn[pos - 1];
        tbD2[pos] = tbD2[pos - 1];
        pos--;
      }
      tbX[pos] = b.x;
      tbY[pos] = b.y;
      tbVX[pos] = b.vx;
      tbVY[pos] = b.vy;
      tbGr[pos] = grace;
      tbBn[pos] = b.bounces || 0;
      tbD2[pos] = d2;
    }
  }

  /* ==================== threat vs candidate scoring ==================== */

  function scoreCandidates() {
    var i, ci, t;
    for (ci = 0; ci < NCAND; ci++) {
      candMin[ci] = 1e18;
      candDng[ci] = SIMT;
    }
    for (i = 0; i < tbN; i++) {
      BX = tbX[i];
      BY = tbY[i];
      BVX = tbVX[i];
      BVY = tbVY[i];
      BBN = tbBn[i];
      var bn0 = tbBn[i];
      var grace = tbGr[i];
      for (t = 0; t < SIMT; t++) {
        stepBullet();
        if (BBN === bn0 && t < grace) continue;
        var base = t * MAXC;
        var bx = BX;
        var by = BY;
        for (ci = 0; ci < NCAND; ci++) {
          var dx = candX[base + ci] - bx;
          var dy = candY[base + ci] - by;
          var d2 = dx * dx + dy * dy;
          if (d2 < candMin[ci]) candMin[ci] = d2;
          if (d2 < DANGER_R2 && candDng[ci] > t) candDng[ci] = t;
        }
      }
    }
  }

  /* ========================= enemy prediction ========================== */

  function predictEnemies(state) {
    epN = 0;
    var es = state.enemies;
    if (!es) return;
    for (var i = 0; i < es.length && epN < EMAX; i++) {
      var e = es[i];
      if (!e || !e.alive || e.id === selfId) continue;
      var h = hist[e.id];
      if (!h) h = hist[e.id] = { t: -2, a: 0, tr: 0, st: 0 };
      var mv = 0;
      var tr = 0;
      var steady = false;
      if (h.t === curTick - 1) {
        tr = wrapPI(e.angle - h.a) / (TURN_S * DT);
        if (tr > 1) tr = 1;
        else if (tr < -1) tr = -1;
        var sp = e.vx * Math.cos(e.angle) + e.vy * Math.sin(e.angle);
        mv = sp / MOVE_S;
        if (mv > 1) mv = 1;
        else if (mv < -1) mv = -1;
        /* is the target turning steadily in one direction? */
        if (Math.abs(tr - h.tr) < 0.22 && Math.abs(tr) > 0.12) h.st++;
        else if (Math.abs(tr) > 0.12) h.st = 1;
        else h.st = 0;
        steady = h.st >= 2;
      }
      h.t = curTick;
      h.a = e.angle;
      h.tr = tr;
      var px = e.x;
      var py = e.y;
      var off = epN * PT;
      epX[off] = px;
      epY[off] = py;
      epAngle[epN] = e.angle;
      var daFull = tr * TURN_S * DT;
      var step = mv * MOVE_S * DT;
      var ca = Math.cos(e.angle);
      var sa = Math.sin(e.angle);
      var c2 = Math.cos(daFull);
      var s2 = Math.sin(daFull);
      var decay = 1;
      var decayRate = steady ? 0.985 : 0.82;
      for (var t = 1; t < PT; t++) {
        if ((t & 15) === 0) {
          decay *= decayRate;
          var ddt = daFull * decay;
          c2 = Math.cos(ddt);
          s2 = Math.sin(ddt);
        }
        var nca = ca * c2 - sa * s2;
        var nsa = sa * c2 + ca * s2;
        ca = nca;
        sa = nsa;
        px += ca * step;
        py += sa * step;
        var cx = px / CS | 0;
        var cy = py / CS | 0;
        if (cx < 0) cx = 0;
        else if (cx >= COLS) cx = COLS - 1;
        if (cy < 0) cy = 0;
        else if (cy >= ROWS) cy = ROWS - 1;
        var bw = cy * CW;
        var bh = cy * COLS;
        if (vW[bw + cx]) {
          var x0 = cx * CS;
          if (px - x0 < TANK_R) px = x0 + TANK_R;
        }
        if (vW[bw + cx + 1]) {
          var x1 = (cx + 1) * CS;
          if (x1 - px < TANK_R) px = x1 - TANK_R;
        }
        if (hW[bh + cx]) {
          var y0 = cy * CS;
          if (py - y0 < TANK_R) py = y0 + TANK_R;
        }
        if (hW[bh + COLS + cx]) {
          var y1 = (cy + 1) * CS;
          if (y1 - py < TANK_R) py = y1 - TANK_R;
        }
        epX[off + t] = px;
        epY[off + t] = py;
      }
      /* how directly is this foe aiming at us? */
      var bearing = Math.atan2(sy - e.y, sx - e.x);
      var off2 = Math.abs(wrapPI(bearing - e.angle));
      var aimClose = off2 < 0.35 ? 1 : off2 < 0.8 ? 0.5 : 0;
      epThreat[epN] = aimClose;
      epN++;
    }
  }

  /* ============================ shot tracing =========================== */

  var MX = 0;
  var MY = 0;
  function muzzleAt(ang) {
    var dx = Math.cos(ang);
    var dy = Math.sin(ang);
    var fx = sx + dx * MUZZLE;
    var fy = sy + dy * MUZZLE;
    if (!circleBlocked(fx, fy, BUL_R + 0.5)) {
      MX = fx;
      MY = fy;
      return;
    }
    var lo = 0;
    var hi = MUZZLE;
    for (var i = 0; i < 7; i++) {
      var mid = (lo + hi) * 0.5;
      if (circleBlocked(sx + dx * mid, sy + dy * mid, BUL_R + 0.5)) hi = mid;
      else lo = mid;
    }
    MX = sx + dx * lo;
    MY = sy + dy * lo;
  }

  var traceHit = -1;
  var traceMin = 1e18;

  function traceShot(x0, y0, ang, maxT) {
    BVX = Math.cos(ang) * BUL_S;
    BVY = Math.sin(ang) * BUL_S;
    BX = x0;
    BY = y0;
    BBN = 0;
    var best = 1e18;
    var n = maxT < PT ? maxT : PT;
    for (var t = 0; t < n; t++) {
      stepBullet();
      var bx = BX;
      var by = BY;
      var et = t + 1;
      if (et >= PT) et = PT - 1;
      for (var e = 0; e < epN; e++) {
        var idx = e * PT + et;
        var dx = bx - epX[idx];
        var dy = by - epY[idx];
        var d2 = dx * dx + dy * dy;
        if (d2 < best) best = d2;
        if (d2 < HIT2) {
          traceHit = t;
          traceMin = d2;
          return true;
        }
      }
    }
    traceHit = -1;
    traceMin = best;
    return false;
  }

  /* would this shot come back and hit us?  Two hypotheses are checked: our
     planned trajectory for this candidate, and staying near the current spot
     (in case the next tick picks a different action). */
  function shotSelfRisk(ang, sel, ticks) {
    muzzleAt(ang);
    BVX = Math.cos(ang) * BUL_S;
    BVY = Math.sin(ang) * BUL_S;
    BX = MX;
    BY = MY;
    BBN = 0;
    var n = ticks < SIMT ? ticks : SIMT;
    for (var t = 0; t < n; t++) {
      stepBullet();
      if (BBN === 0 && t < 16) continue;
      var px = candX[t * MAXC + sel];
      var py = candY[t * MAXC + sel];
      var dx = BX - px;
      var dy = BY - py;
      if (dx * dx + dy * dy < SELF_RISK2) return true;
      var dx2 = BX - sx;
      var dy2 = BY - sy;
      if (dx2 * dx2 + dy2 * dy2 < SELF_RISK2) return true;
    }
    return false;
  }

  /* ======================== aiming search ============================== */

  /* analytic direct lead: iterate muzzle -> predicted point */
  function directAimFor(e) {
    var off = e * PT;
    var ang = Math.atan2(epY[off] - sy, epX[off] - sx);
    muzzleAt(ang);
    var mx = MX;
    var my = MY;
    for (var it = 0; it < 4; it++) {
      var d = hyp(epX[off] - mx, epY[off] - my);
      var tArr = d / BUL_S;
      var ti = Math.round(tArr * 60);
      if (ti < 0) ti = 0;
      if (ti >= PT) ti = PT - 1;
      var txp = epX[off + ti];
      var typ = epY[off + ti];
      ang = Math.atan2(typ - my, txp - mx);
      muzzleAt(ang);
      mx = MX;
      my = MY;
    }
    return ang;
  }

  function computeAim() {
    aimHit = false;
    aimValid = false;
    aimMinD2 = 1e18;
    if (epN === 0) return;

    var n = 0;
    var e;
    var bestAng = 0;
    var bestCost = 1e18;
    var found = false;

    /* candidate angle list */
    for (e = 0; e < epN; e++) {
      aimAngles[n++] = directAimFor(e);
      var base = Math.atan2(epY[e * PT] - sy, epX[e * PT] - sx);
      var d = hyp(epX[e * PT] - sx, epY[e * PT] - sy);
      var spread = d > 90 ? Math.min(0.28, 22 / d) : 0.26;
      aimAngles[n++] = base - spread;
      aimAngles[n++] = base + spread;
    }
    for (var c = 0; c < 192; c++) aimAngles[n++] = (c * TAU) / 192;

    var i;
    for (i = 0; i < n; i++) {
      var a = aimAngles[i];
      muzzleAt(a);
      var hit = traceShot(MX, MY, a, PT);
      if (hit) {
        var cost = Math.abs(wrapPI(a - sang)) * 20 + traceHit;
        if (cost < bestCost) {
          bestCost = cost;
          bestAng = a;
          found = true;
          aimMinD2 = traceMin;
        }
      } else if (!found && traceMin < aimMinD2) {
        aimMinD2 = traceMin;
        bestAng = a;
      }
    }

    if ((found && bestCost > 26) || (!found && aimMinD2 < 260 * 260)) {
      var refineCenter = bestAng;
      for (var r = -16; r <= 16; r++) {
        if (r === 0) continue;
        var ra = refineCenter + r * 0.011;
        muzzleAt(ra);
        var rhit = traceShot(MX, MY, ra, PT);
        if (rhit) {
          var rcost = Math.abs(wrapPI(ra - sang)) * 20 + traceHit;
          if (rcost < bestCost) {
            bestCost = rcost;
            bestAng = ra;
            found = true;
            aimMinD2 = traceMin;
          }
        } else if (!found && traceMin < aimMinD2) {
          aimMinD2 = traceMin;
          bestAng = ra;
        }
      }
    }

    aimValid = found || aimMinD2 < 110 * 110;
    aimAngle = bestAng;
    aimHit = found;
  }

  /* ============================ laser ================================== */

  function laserTrace(x0, y0, ang) {
    var dx = Math.cos(ang);
    var dy = Math.sin(ang);
    var px = x0;
    var py = y0;
    var total = 0;
    for (var seg = 0; seg <= LASER_BOUNCES; seg++) {
      var segLen = LASER_LEN - total;
      if (segLen <= 2) return false;
      var cx = px / CS | 0;
      var cy = py / CS | 0;
      if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) return false;
      var stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
      var stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
      var tMaxX =
        dx !== 0 ? ((cx + (stepX > 0 ? 1 : 0)) * CS - px) / dx : Infinity;
      var tMaxY =
        dy !== 0 ? ((cy + (stepY > 0 ? 1 : 0)) * CS - py) / dy : Infinity;
      var tDeltaX = dx !== 0 ? CS / Math.abs(dx) : Infinity;
      var tDeltaY = dy !== 0 ? CS / Math.abs(dy) : Infinity;
      var hitX = px + dx * segLen;
      var hitY = py + dy * segLen;
      var dist = segLen;
      var blocked = false;
      var guard = 0;
      while (guard++ < 512) {
        if (tMaxX > segLen && tMaxY > segLen) break;
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
          tMaxX += tDeltaX;
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
          tMaxY += tDeltaY;
        }
      }
      var bestT = 1e18;
      var bestKind = 0;
      for (var e = 0; e < epN; e++) {
        var ex = epX[e * PT];
        var ey = epY[e * PT];
        var vx = ex - px;
        var vy = ey - py;
        var proj = vx * dx + vy * dy;
        if (proj < -TANK_R || proj > dist + TANK_R) continue;
        var perp = Math.abs(vx * dy - vy * dx);
        if (perp < TANK_R && proj < bestT) {
          bestT = proj;
          bestKind = 1;
        }
      }
      if (seg >= 1) {
        var svx = sx - px;
        var svy = sy - py;
        var sproj = svx * dx + svy * dy;
        if (sproj > -TANK_R && sproj < dist + TANK_R) {
          var sperp = Math.abs(svx * dy - svy * dx);
          if (sperp < TANK_R && sproj < bestT) {
            bestT = sproj;
            bestKind = 2;
          }
        }
      }
      if (bestKind === 1) return true;
      if (bestKind === 2) return false;
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

  function computeLaser() {
    laserValid = false;
    if (epN === 0) return;
    var bestCost = 1e18;
    var i;
    for (i = 0; i < 180; i++) {
      var a = (i * TAU) / 180;
      muzzleAt(a);
      if (laserTrace(MX, MY, a)) {
        var cost = Math.abs(wrapPI(a - sang));
        if (cost < bestCost) {
          bestCost = cost;
          laserAng = a;
          laserValid = true;
        }
      }
    }
    if (!laserValid) {
      for (var e = 0; e < epN; e++) {
        var base = Math.atan2(epY[e * PT] - sy, epX[e * PT] - sx);
        for (var r = -11; r <= 11; r++) {
          var ra = base + r * 0.02;
          muzzleAt(ra);
          if (laserTrace(MX, MY, ra)) {
            laserAng = ra;
            laserValid = true;
            return;
          }
        }
      }
    }
  }

  /* ======================== goal selection ============================= */

  function computeGoal(state) {
    var t = state.time || curTick * DT;
    var timeout = (state.rules && state.rules.timeout) || 60;
    var prog = timeout > 1 ? t / timeout : 0;
    var aggr;
    if (prog < 0.22) aggr = 0.35;
    else if (prog < 0.5) aggr = 0.65;
    else if (prog < 0.75) aggr = 0.85;
    else aggr = 1.0;

    var nearestD = 1e9;
    var ne = null;
    var es = state.enemies;
    if (es) {
      for (var i = 0; i < es.length; i++) {
        var e = es[i];
        if (!e || !e.alive || e.id === selfId) continue;
        var d = hyp(e.x - sx, e.y - sy);
        if (d < nearestD) {
          nearestD = d;
          ne = e;
        }
      }
    }
    closestEnemyD = nearestD;

    var puScore = -1e18;
    var puX = 0;
    var puY = 0;
    var pus = state.powerups;
    if (pus && (!state.rules || state.rules.powerups !== false)) {
      for (var p = 0; p < pus.length; p++) {
        var pu = pus[p];
        var pd = hyp(pu.x - sx, pu.y - sy);
        if (pd > 480) continue;
        var val = 0;
        if (pu.type === 'shield') val = 1500;
        else if (pu.type === 'laser') val = 1200;
        else if (pu.type === 'scatter') val = 1050;
        else if (pu.type === 'mine') val = 500;
        var s = val - pd * 1.8;
        if (s > puScore) {
          puScore = s;
          puX = pu.x;
          puY = pu.y;
        }
      }
    }

    var desired = 330 - 175 * aggr;
    if (curTick - lastFireTick > 180) desired *= 0.7;
    var gx = sx;
    var gy = sy;

    if (ne) {
      var nd = nearestD;
      var puWanted = puScore > -1e17 && puScore > 520 - nd * 0.3;
      if (puWanted) {
        gx = puX;
        gy = puY;
      } else if (nd < Math.max(135, desired * 0.45)) {
        var ax = sx - ne.x;
        var ay = sy - ne.y;
        var al = hyp(ax, ay);
        if (al < 1) {
          ax = 1;
          ay = 0;
          al = 1;
        }
        gx = sx + (ax / al) * 250;
        gy = sy + (ay / al) * 250;
      } else if (nd > desired * 1.4) {
        gx = ne.x;
        gy = ne.y;
      } else {
        var dx = sx - ne.x;
        var dy = sy - ne.y;
        var dl = hyp(dx, dy);
        if (dl < 1) {
          dx = 1;
          dy = 0;
          dl = 1;
        }
        var ux = dx / dl;
        var uy = dy / dl;
        gx = ne.x + ux * desired - uy * strafeSign * 170;
        gy = ne.y + uy * desired + ux * strafeSign * 170;
      }
    }

    if (gx < TANK_R) gx = TANK_R;
    if (gy < TANK_R) gy = TANK_R;
    if (gx > MW - TANK_R) gx = MW - TANK_R;
    if (gy > MH - TANK_R) gy = MH - TANK_R;
    goalX = gx;
    goalY = gy;

    /* exposure grid: how much enemy fire can reach each cell */
    if (expoCost) {
      expoCost.fill(0);
      for (var ec = 0; ec < epN; ec++) {
        var eux = epX[ec * PT];
        var euy = epY[ec * PT];
        var wgt = 0.55 * (epThreat[ec] > 0 ? 1.6 : 1);
        for (var rr = 0; rr < ROWS; rr++) {
          for (var ccc = 0; ccc < COLS; ccc++) {
            var midx = rr * COLS + ccc;
            var mxp = ccc * CS + CS * 0.5;
            var myp = rr * CS + CS * 0.5;
            var ddx = mxp - eux, ddy = myp - euy;
            if (ddx * ddx + ddy * ddy > 620 * 620) continue;
            if (ddaClear(mxp, myp, eux, euy)) expoCost[midx] += wgt;
          }
        }
      }
    }
    var sc = clamp(sx / CS | 0, 0, COLS - 1);
    var sr = clamp(sy / CS | 0, 0, ROWS - 1);
    var gcv = clamp(gx / CS | 0, 0, COLS - 1);
    var grv = clamp(gy / CS | 0, 0, ROWS - 1);
    var n = astar(sr * COLS + sc, grv * COLS + gcv, 2200);
    var tx = gx;
    var ty = gy;
    if (n > 1) {
      var lim = n - 1 < 8 ? n - 1 : 8;
      var reached = 0;
      for (var i2 = 1; i2 <= lim; i2++) {
        var cell = pathCells[i2];
        var cc = cell % COLS;
        var cr = (cell / COLS) | 0;
        var px = cc * CS + CS * 0.5;
        var py = cr * CS + CS * 0.5;
        if (lineClear(sx, sy, px, py)) {
          reached = i2;
          tx = px;
          ty = py;
        } else break;
      }
      if (reached === 0) {
        var c1 = pathCells[1];
        tx = (c1 % COLS) * CS + CS * 0.5;
        ty = ((c1 / COLS) | 0) * CS + CS * 0.5;
      }
    }
    var mdx = tx - sx;
    var mdy = ty - sy;
    var ml = hyp(mdx, mdy);
    if (ml < 1e-6) {
      mdx = 1;
      mdy = 0;
      ml = 1;
    }
    moveDirX = mdx / ml;
    moveDirY = mdy / ml;
  }

  /* ========================= mine handling ============================= */

  function refreshMines(state) {
    var ms = state.mines;
    seenMines.length = 0;
    if (ms) {
      for (var i = 0; i < ms.length && seenMines.length < 20; i++) {
        var m = ms[i];
        if (!m) continue;
        seenMines.push(m.x, m.y);
        if (m.ownerId !== selfId) continue;
        var found = false;
        for (var j = 0; j < ownMines.length; j++) {
          if (ownMines[j].id === m.id) {
            ownMines[j].x = m.x;
            ownMines[j].y = m.y;
            ownMines[j].t = curTick;
            found = true;
            break;
          }
        }
        if (!found && ownMines.length < 10) {
          ownMines.push({ id: m.id, x: m.x, y: m.y, t: curTick });
        }
      }
    }
    for (var k = ownMines.length - 1; k >= 0; k--) {
      if (curTick - ownMines[k].t > 60 * 16) ownMines.splice(k, 1);
    }
  }

  function safeToDropMine(mx, my) {
    var last = (SIMT - 1) * MAXC + bestCand;
    var dx = candX[last] - mx;
    var dy = candY[last] - my;
    if (dx * dx + dy * dy < (MINE_TRIG + 9) * (MINE_TRIG + 9)) return false;
    var mid = 45 * MAXC + bestCand;
    var mdx = candX[mid] - mx;
    var mdy = candY[mid] - my;
    if (mdx * mdx + mdy * mdy < (MINE_TRIG + 2) * (MINE_TRIG + 2))
      return false;
    return true;
  }

  /* ========================== candidate eval =========================== */

  function evaluateCandidates(state) {
    buildCandidates();
    scoreCandidates();

    var aimA = aimValid ? aimAngle : Math.atan2(moveDirY, moveDirX);
    var useAim = aimValid && aimHit;
    var bestScore = -1e18;
    var chosen = 0;
    var i;

    for (var ci = 0; ci < NCAND; ci++) {
      var lastOff = (SIMT - 1) * MAXC + ci;
      var fx = candX[lastOff];
      var fy = candY[lastOff];
      var ex = fx - sx;
      var ey = fy - sy;
      var travel = hyp(ex, ey);
      var proj = ex * moveDirX + ey * moveDirY;
      var lat = Math.abs(ex * moveDirY - ey * moveDirX);

      var score;
      var dng = candDng[ci];
      var md = candMin[ci];
      var mdSqrt = Math.sqrt(md);
      if (mdSqrt > 42) mdSqrt = 42;

      if (dng >= SIMT) score = 1000000;
      else score = dng * (selfShield ? 640 : 950) + mdSqrt * 13;

      score += proj * 3.4 + travel * 0.55 - lat * 1.1;

      /* hidden/memory mine avoidance (own mines are lethal if stepped on) */
      for (i = 0; i < ownMines.length; i++) {
        var mm = ownMines[i];
        var ddx = fx - mm.x;
        var ddy = fy - mm.y;
        if (ddx * ddx + ddy * ddy < (MINE_BLAST + 10) * (MINE_BLAST + 10))
          score -= 330;
      }
      /* any currently visible mine (either owner) is also a hazard */
      for (i = 0; i < seenMines.length; i += 2) {
        var sdx = fx - seenMines[i];
        var sdy = fy - seenMines[i + 1];
        if (sdx * sdx + sdy * sdy < (MINE_BLAST + 10) * (MINE_BLAST + 10))
          score -= 190;
      }

      /* exposure: standing on a clear line of fire is bad */
      if (epN > 0) {
        var expo = 0;
        for (i = 0; i < epN; i++) {
          var exx = epX[i * PT];
          var eyy = epY[i * PT];
          var dxe = exx - fx;
          var dye = eyy - fy;
          var dde = dxe * dxe + dye * dye;
          if (dde > 620 * 620) continue;
          var aimFactor = epThreat[i] > 0 ? 1.0 : 0.45;
          if (ddaClear(fx, fy, exx, eyy)) {
            expo += 26 * aimFactor;
          }
        }
        score -= expo;
      }

      /* do not hug walls: it costs mobility and makes our own bounces riskier */
      var wd = wallDist(fx, fy);
      if (wd < 26) score -= (26 - wd) * 7;

      /* barrel alignment: when a kill shot exists, reward the fastest slew
         onto the firing bearing instead of the slowest sufficient turn */
      if (aimValid) {
        var initDiff = wrapPI(aimA - sang);
        var finAng = sang + candTr[ci] * TURN_S * SIMT * DT;
        var diff = wrapPI(finAng - aimA);
        var align = Math.cos(diff);
        if (useAim) {
          score += align * 90 - Math.abs(diff) * 30;
          var omega = candTr[ci] * TURN_S;
          var tAlign = 1e9;
          if (Math.abs(initDiff) < 0.035) tAlign = 0;
          else if (omega !== 0 && (initDiff > 0) === (omega > 0)) {
            tAlign = Math.floor((Math.abs(initDiff) / Math.abs(omega)) * 60);
          }
          if (tAlign <= SIMT) score += (SIMT - tAlign) * 5;
          else score -= 90;
        } else {
          score += align * 50 - Math.abs(diff) * 24;
        }
      }

      /* smooth the controls so the bot does not oscillate */
      score -= Math.abs(candMv[ci] - prevMove) * 14;
      score -= Math.abs(candTr[ci] - prevTurn) * 9;

      /* a little noise breaks perfectly predictable patterns */
      score += (Math.random() - 0.5) * 26;

      if (score > bestScore) {
        bestScore = score;
        chosen = ci;
      }
    }
    bestCand = chosen;
  }

  /* ============================ decisions ============================== */

  function shouldDropMine(state) {
    var s = state.self;
    var rearX = sx - Math.cos(sang) * 29;
    var rearY = sy - Math.sin(sang) * 29;
    if (circleBlocked(rearX, rearY, 7)) return false;

    var nd = closestEnemyD;
    if (nd > 1e8) return false;
    var hold = s.mineHoldTime || 0;
    var expiring = hold > 0 && hold < 2.5;
    var closing = false;
    var es = state.enemies;
    if (es) {
      for (var i = 0; i < es.length; i++) {
        var e = es[i];
        if (!e || !e.alive || e.id === selfId) continue;
        var ex = sx - e.x;
        var ey = sy - e.y;
        var ed = hyp(ex, ey);
        if (ed > 360 || ed < 1) continue;
        if ((e.vx * ex + e.vy * ey) / ed > 45) closing = true;
      }
    }
    if (!closing && !expiring) return false;
    if (!safeToDropMine(rearX, rearY)) return false;
    return true;
  }

  /* ============================== update =============================== */

  function readPhysics(state) {
    var p = state.physics;
    if (!p) return;
    if (p.tankRadius > 0) TANK_R = p.tankRadius;
    if (p.moveSpeed > 0 && p.moveSpeed < 2000) MOVE_S = p.moveSpeed;
    if (p.turnSpeed > 0.05 && p.turnSpeed < 50) TURN_S = p.turnSpeed;
    if (p.bulletRadius > 0) BUL_R = p.bulletRadius;
    if (p.bulletSpeed > 0) BUL_S = p.bulletSpeed;
    if (p.fireCooldown > 0) FIRE_CD = p.fireCooldown;
    if (p.maxBullets > 0) MAX_BUL = p.maxBullets;
    if (p.selfHitGrace > 0) SELF_GRACE = p.selfHitGrace;
    if (p.muzzleOffset > 0) MUZZLE = p.muzzleOffset;
    if (p.laser) {
      if (p.laser.maxBounces >= 0 && p.laser.maxBounces < 64)
        LASER_BOUNCES = p.laser.maxBounces | 0;
      if (p.laser.maxLength > 0) LASER_LEN = p.laser.maxLength;
    }
    if (p.mine) {
      if (p.mine.triggerRadius > 0) MINE_TRIG = p.mine.triggerRadius;
      if (p.mine.blastRadius > 0) MINE_BLAST = p.mine.blastRadius;
    }
    if (p.scatter && p.scatter.spreadAngle > 0) SCAT_SPREAD = p.scatter.spreadAngle;
    /* derived collision radii follow the published physics */
    var hitR = TANK_R + BUL_R;
    HIT2 = hitR * hitR;
    DANGER_R = hitR + 3;
    DANGER_R2 = DANGER_R * DANGER_R;
    var selfR = hitR + 4;
    SELF_RISK2 = selfR * selfR;
  }

  function decide(state) {
    if (!state || state.apiVersion !== 1) return SAFE_ACTION;
    readPhysics(state);
    if (!rebuildMap(state)) return SAFE_ACTION;
    var s = state.self;
    if (!s || !s.alive) return SAFE_ACTION;
    sx = s.x;
    sy = s.y;
    sang = s.angle;
    selfId = s.id;
    curTick = state.tick || 0;

    strafePhase += 1;
    if (strafePhase > strafePeriod) {
      strafePhase = 0;
      strafeSign = -strafeSign;
      strafePeriod = 60 + ((Math.random() * 100) | 0);
    }

    hasLaserShot = (s.laserShots || 0) > 0;
    hasScatterShot = (s.scatterShots || 0) > 0;
    hasMines = (s.mineCharges || 0) > 0;
    selfShield = s.shield === true;

    predictEnemies(state);
    collectThreats(state);
    refreshMines(state);
    computeAim();
    if (hasLaserShot) {
      computeLaser();
      if (laserValid) {
        /* a guaranteed laser kill outranks any ordinary shot */
        aimAngle = laserAng;
        aimValid = true;
        aimHit = true;
      }
    }

    computeGoal(state);
    evaluateCandidates(state);

    var sel = bestCand;
    var fire = false;
    var special = false;

    /* --- laser: instant kill if the current bearing connects --- */
    if (hasLaserShot) {
      muzzleAt(sang);
      if (laserTrace(MX, MY, sang)) fire = true;
    }

    /* --- primary gun: only fire on a verified interception --- */
    if (!fire) {
      muzzleAt(sang);
      var hitNow = traceShot(MX, MY, sang, PT);
      if (hitNow) {
        if (!shotSelfRisk(sang, sel, SIMT)) fire = true;
      }
    }

    /* --- scatter spray --- */
    if (!fire && hasScatterShot && epN > 0) {
      for (var e = 0; e < epN; e++) {
        var ea = Math.atan2(epY[e * PT] - sy, epX[e * PT] - sx);
        if (Math.abs(wrapPI(ea - sang)) < 0.55) {
          muzzleAt(sang);
          var ok0 = traceShot(MX, MY, sang, PT);
          muzzleAt(sang + SCAT_SPREAD);
          var ok1 = traceShot(MX, MY, sang + SCAT_SPREAD, PT);
          muzzleAt(sang - SCAT_SPREAD);
          var ok2 = traceShot(MX, MY, sang - SCAT_SPREAD, PT);
          var ok = ok0 || ok1 || ok2;
          if (ok) {
            if (
              !shotSelfRisk(sang, sel, SIMT) &&
              !shotSelfRisk(sang + SCAT_SPREAD, sel, SIMT) &&
              !shotSelfRisk(sang - SCAT_SPREAD, sel, SIMT)
            )
              fire = true;
          }
          break;
        }
      }
    }

    /* --- mines --- */
    if (!fire && hasMines && (s.deployCooldown || 0) < 1e-4) {
      if (shouldDropMine(state)) special = true;
    }
    if (fire) lastFireTick = curTick;

    var move = candMv[sel];
    var turn = candTr[sel];
    if (!isFinite(move)) move = 0;
    if (!isFinite(turn)) turn = 0;
    move = clamp(move, -1, 1);
    turn = clamp(turn, -1, 1);
    prevMove = move;
    prevTurn = turn;

    return { move: move, turn: turn, fire: fire, special: special };
  }

  function update(state) {
    try {
      return decide(state);
    } catch (err) {
      /* Never freeze in place: a slow crawl beats a stationary target. */
      return { move: 0.55, turn: 0.35, fire: false, special: false };
    }
  }

  module.exports = { update: update };
})();
