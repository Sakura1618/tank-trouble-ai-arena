// 确定性随机数。引擎内禁止使用 Math.random：所有随机行为都来自这里的独立流，
// 互不串扰——多抽一次道具不会让下一局的地图变样。
// 只用 32 位整数运算，任何 JS 引擎结果逐位相同。

const U32 = 0x100000000;

function mix32(value) {
  let x = value >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

// FNV-1a + 末端雪崩，按 UTF-16 码元逐个吃入。
export function hashString(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  }
  return mix32(h);
}

// 64 位十六进制指纹：用于 Bot 源码版本和规则集。
export function hashHex(text) {
  return [hashString(text), hashString(`salt:${text}`)]
    .map(part => part.toString(16).padStart(8, '0')).join('');
}

// 种子允许写成数字或字符串；两者都归一化成 uint32。
export function normalizeSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return Math.trunc(seed) >>> 0;
  if (typeof seed === 'string' && seed.length) {
    return /^\d+$/.test(seed) ? Number(BigInt(seed) & 0xffffffffn) : hashString(seed);
  }
  throw new Error('seed 必须是有限数字或非空字符串');
}

// sfc32：周期长、速度快、状态只有 4 个 uint32，便于写进状态哈希。
export class Rng {
  constructor(seed) {
    const s = normalizeSeed(seed);
    this.a = mix32(s ^ 0x9e3779b9);
    this.b = mix32(s ^ 0x243f6a88);
    this.c = mix32(s ^ 0xb7e15162);
    this.d = 1;
    for (let i = 0; i < 12; i++) this.uint();
  }

  uint() {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  next() { return this.uint() / U32; }
  int(n) { return Math.floor(this.next() * n); }
  range(min, max) { return min + this.next() * (max - min); }
  pick(list) { return list[this.int(list.length)]; }
  chance(p) { return this.next() < p; }

  shuffled(list) {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  state() { return [this.a >>> 0, this.b >>> 0, this.c >>> 0, this.d >>> 0]; }
}

const STREAMS = ['mapSeed', 'spawnSeed', 'orderSeed', 'powerupSeed', 'botSeed'];

// 一个主种子派生出全部独立流；任一流都可以单独覆盖，用于“同图不同出生点”这类实验。
export function deriveSeeds(seed, overrides = {}) {
  const master = normalizeSeed(seed);
  const seeds = { seed: master };
  for (const name of STREAMS) {
    seeds[name] = overrides[name] !== undefined
      ? normalizeSeed(overrides[name])
      : mix32(master ^ hashString(name));
  }
  return seeds;
}

// 每个选手的脚本随机流：由 botSeed 和选手 ID 决定，与席位和调度顺序无关。
export function botSeedFor(botSeed, actorId) {
  return mix32(normalizeSeed(botSeed) ^ hashString(String(actorId)));
}
