// 稳定控制工具。比赛只接受单文件脚本：把需要的函数复制进 bot.js 即可。
// 坦克没有惯性，决策每 Tick 重算时，阈值附近的小噪声会直接变成动作翻转。
// 这些工具把“每 Tick 的判断”变成“有记忆的决定”。

// 最短角差，范围 [-π, π]，正值表示顺时针。
function angleDifference(target, current) {
  const delta = target - current;
  return Math.atan2(Math.sin(delta), Math.cos(delta));
}

// 转向目标角。转速每 Tick 约 0.05 弧度，误差小于半步时再转只会过冲，所以给一个死区。
function steerTo(state, targetAngle, deadband = state.physics.turnSpeed * state.dt * 0.5) {
  const error = angleDifference(targetAngle, state.self.angle);
  if (Math.abs(error) <= deadband) return 0;
  return error > 0 ? 1 : -1;
}

// 滞回：进入和退出用两个阈值，数值在阈值附近抖动时状态不翻转。
class Hysteresis {
  constructor(enterAt, exitAt, active = false) {
    this.enterAt = enterAt;
    this.exitAt = exitAt;
    this.active = active;
  }

  // 数值上升到 enterAt 才激活，下降到 exitAt 才退出。enterAt 要大于 exitAt。
  update(value) {
    if (!this.active && value >= this.enterAt) this.active = true;
    else if (this.active && value <= this.exitAt) this.active = false;
    return this.active;
  }
}

// 决定保持：换到新决定后至少保持 minTicks，短暂的反向念头不会变成动作。
class Commitment {
  constructor(minTicks, initial = 0) {
    this.minTicks = minTicks;
    this.value = initial;
    this.since = -Infinity;
  }

  decide(next, tick) {
    if (next !== this.value && tick - this.since >= this.minTicks) {
      this.value = next;
      this.since = tick;
    }
    return this.value;
  }
}

// 反向门的本地模型，需要 apiVersion: 2。每 Tick 调用一次 observe，再用 blocked 判断请求会不会被拦下。
// 被拦下的 Tick 坦克是静止的，规划躲弹路线时应该把这段停顿算进去。
class ReverseGateModel {
  constructor() {
    this.direction = 0;
    this.lastActiveTick = -Infinity;
  }

  // self.appliedMove 是上一 Tick 实际执行的方向。
  observe(state) {
    if (state.self.appliedMove !== 0) {
      this.direction = state.self.appliedMove;
      this.lastActiveTick = state.tick - 1;
    }
  }

  blocked(state, direction) {
    return direction !== 0 && this.direction !== 0 && direction !== this.direction &&
      state.tick - this.lastActiveTick <= state.physics.reverseDwellTicks;
  }
}

if (typeof module !== 'undefined') module.exports = { angleDifference, steerTo, Hysteresis, Commitment, ReverseGateModel };
