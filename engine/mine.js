// 地雷：布防计时与可见度。引爆判定需要跨全体坦克，放在 world。纯模拟，无渲染。

export class Mine {
  constructor(x, y, owner, rules) {
    this.x = x;
    this.y = y;
    this.owner = owner;
    this.rules = rules;
    this.age = 0;
    this.exploded = false;
    this.arenaId = 0;
  }

  get armed() { return this.age >= this.rules.armDelay; }

  // 布防期半透明 → 警戒后短暂实色 → 淡出至完全隐形（主人也看不见，靠记忆）。
  visibility() {
    const { armDelay, visibleTime, fadeTime } = this.rules;
    if (this.age < armDelay) return 0.45;
    const armedFor = this.age - armDelay;
    if (armedFor < visibleTime) return 0.95;
    return Math.max(0, 0.95 * (1 - (armedFor - visibleTime) / fadeTime));
  }

  update(dt) { this.age += dt; }
}
