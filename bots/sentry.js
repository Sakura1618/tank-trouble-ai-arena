// 新手练习：站桩、缓慢转向与低频开火，不寻路或躲弹。
let nextShotTime = 1.8;

module.exports = {
  update(state) {
    const self = state.self;
    let target = null;
    let nearest = Infinity;
    for (const enemy of state.enemies) {
      if (!enemy.alive) continue;
      const distance = Math.hypot(enemy.x - self.x, enemy.y - self.y);
      if (distance < nearest) { nearest = distance; target = enemy; }
    }
    if (!target) return { move: 0, turn: 0, fire: false, special: false };

    const bearing = Math.atan2(target.y - self.y, target.x - self.x) - self.angle;
    const aim = Math.atan2(Math.sin(bearing), Math.cos(bearing));
    const fire = Math.abs(aim) < 0.14 && state.time >= nextShotTime;
    if (fire) nextShotTime = state.time + 1.8;
    return {
      move: 0,
      // classic 控制只有 -1/0/1：用约 22% 的占空比保持原有的慢速转向。
      turn: Math.abs(aim) < 0.03 || state.tick % 9 >= 2 ? 0 : Math.sign(aim),
      fire,
      special: false,
    };
  },
};
