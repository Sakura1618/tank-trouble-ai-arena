// 新手练习：直接追人、低频射击；撞墙后短暂倒车转向，不寻路或预测弹道。
let previousPosition = null;
let movedForward = false;
let stuckTime = 0;
let reverseUntil = 0;
let reverseTurn = 1;
let nextShotTime = 1.2;

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

    if (previousPosition && movedForward &&
        Math.hypot(self.x - previousPosition.x, self.y - previousPosition.y) < state.physics.moveSpeed * state.dt * 0.15) {
      stuckTime += state.dt;
    } else {
      stuckTime = 0;
    }
    previousPosition = { x: self.x, y: self.y };
    if (stuckTime >= 0.7) {
      reverseUntil = state.time + 0.65;
      reverseTurn *= -1;
      stuckTime = 0;
    }
    if (state.time < reverseUntil) {
      movedForward = false;
      return { move: -0.65, turn: reverseTurn * 0.7, fire: false, special: false };
    }

    const bearing = Math.atan2(target.y - self.y, target.x - self.x) - self.angle;
    const aim = Math.atan2(Math.sin(bearing), Math.cos(bearing));
    movedForward = Math.abs(aim) < 0.7;
    const fire = Math.abs(aim) < 0.18 && state.time >= nextShotTime;
    if (fire) nextShotTime = state.time + 1.2;
    return {
      move: movedForward ? 1 : 0,
      turn: Math.max(-0.6, Math.min(0.6, aim / (state.physics.turnSpeed * state.dt))),
      fire,
      special: false,
    };
  },
};
