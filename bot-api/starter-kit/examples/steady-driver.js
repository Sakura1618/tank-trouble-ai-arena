// API v2 示例：用 init 建立记忆，用滞回和决定保持让控制稳定。
// 演示接口用法，不是比赛策略：不寻路、不躲弹。

function angleDifference(target, current) {
  const delta = target - current;
  return Math.atan2(Math.sin(delta), Math.cos(delta));
}

function steerTo(state, targetAngle) {
  const error = angleDifference(targetAngle, state.self.angle);
  if (Math.abs(error) <= state.physics.turnSpeed * state.dt * 0.5) return 0;
  return error > 0 ? 1 : -1;
}

module.exports = {
  apiVersion: 2,

  init() {
    this.memory = { retreating: false, direction: 0, directionSince: -Infinity };
  },

  update(state) {
    const self = state.self;
    const target = state.enemies.find(enemy => enemy.alive);
    if (!target) return {};

    const distance = Math.hypot(target.x - self.x, target.y - self.y);
    const bearing = Math.atan2(target.y - self.y, target.x - self.x);

    // 滞回：近到 110 才开始后撤，退到 170 才恢复前进，距离抖动不会让方向翻转。
    if (distance < 110) this.memory.retreating = true;
    else if (distance > 170) this.memory.retreating = false;

    // 决定保持：方向改变后至少维持 20 Tick。
    const wanted = this.memory.retreating ? -1 : 1;
    if (wanted !== this.memory.direction && state.tick - this.memory.directionSince >= 20) {
      this.memory.direction = wanted;
      this.memory.directionSince = state.tick;
    }

    const aim = Math.abs(angleDifference(bearing, self.angle));
    return {
      move: aim < 0.6 ? this.memory.direction : 0,
      turn: steerTo(state, bearing),
      fire: aim < 0.08 && self.cooldown === 0,
    };
  },
};
