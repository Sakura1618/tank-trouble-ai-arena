// 跨引擎确定性数学。
// ECMAScript 不规定 Math.sin/cos/hypot 的具体结果，不同浏览器末位可能不同，
// 放进物理循环后误差会被反弹放大，同一录像在两个引擎上走向不同结局。
// 这里只用 + - * / 和 Math.floor（IEEE-754 严格定义），因此逐位可复现。
// 多项式系数来自 fdlibm 的 __kernel_sin / __kernel_cos。

export const TAU = Math.PI * 2;

const PIO2_HI = 1.5707963267341256;
const PIO2_LO = 6.077100506506192e-11;
const INV_PIO2 = 0.6366197723675814;

const S1 = -1.66666666666666324348e-01;
const S2 = 8.33333333332248946124e-03;
const S3 = -1.98412698298579493134e-04;
const S4 = 2.75573137070700676789e-06;
const S5 = -2.50507602534068634195e-08;
const S6 = 1.58969099521155010221e-10;

const C1 = 4.16666666666666019037e-02;
const C2 = -1.38888888888741095749e-03;
const C3 = 2.48015872894767294178e-05;
const C4 = -2.75573143513906633035e-07;
const C5 = 2.08757232129817482790e-09;
const C6 = -1.13596475577881948265e-11;

function kernelSin(x) {
  const z = x * x;
  return x + x * z * (S1 + z * (S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))));
}

function kernelCos(x) {
  const z = x * x;
  return 1 - 0.5 * z + z * z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
}

function quadrant(x) { return Math.floor(x * INV_PIO2 + 0.5); }
function remainder(x, k) { return (x - k * PIO2_HI) - k * PIO2_LO; }

export function dsin(x) {
  const k = quadrant(x);
  const r = remainder(x, k);
  const q = ((k % 4) + 4) % 4;
  if (q === 0) return kernelSin(r);
  if (q === 1) return kernelCos(r);
  if (q === 2) return -kernelSin(r);
  return -kernelCos(r);
}

export function dcos(x) {
  const k = quadrant(x);
  const r = remainder(x, k);
  const q = ((k % 4) + 4) % 4;
  if (q === 0) return kernelCos(r);
  if (q === 1) return -kernelSin(r);
  if (q === 2) return -kernelCos(r);
  return kernelSin(r);
}

export function dlen(x, y) { return Math.sqrt(x * x + y * y); }

export function wrapTau(angle) {
  if (angle >= 0 && angle < TAU) return angle;
  const a = angle - Math.floor(angle / TAU) * TAU;
  return a >= TAU ? 0 : a;
}
