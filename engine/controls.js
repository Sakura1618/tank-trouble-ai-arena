// 控制层：把任何来源（键盘、摇杆、AI）的动作变成坦克真正执行的指令。
//
// 1. 数字化：classic 只有键盘语义的 -1/0/1。旧脚本的小数按四舍五入归入三档，
//    所以比例控制器在目标附近自然落入死区，不会在目标两侧来回抖。
// 2. 反向门：坦克没有惯性，请求每 Tick 反转就会每 Tick 倒退，60Hz 下肉眼就是抽动，
//    这也是键盘做不到的操作。规则：沿某方向行驶后，必须静止满 dwell 个 Tick
//    才能朝相反方向行驶。
//    不是惯性：速度仍然恒定，起步和停车都是瞬时的；停车指令从不被延迟，
//    按住一个方向开够一段时间后反向也只付出一次 dwell。

export const IDLE_ACTION = Object.freeze({ move: 0, turn: 0, fire: false, special: false });

export class InvalidActionError extends Error {
  constructor(message) {
    super(message);
    this.code = 'invalid_action';
  }
}

// 缺省字段按 0/false 处理；非法类型和越界值判负，不静默裁剪。
export function validateAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw new InvalidActionError('update 必须同步返回动作对象');
  }
  const move = action.move ?? 0;
  const turn = action.turn ?? 0;
  const fire = action.fire ?? false;
  const special = action.special ?? false;
  if (!Number.isFinite(move) || Math.abs(move) > 1 || !Number.isFinite(turn) || Math.abs(turn) > 1 ||
      typeof fire !== 'boolean' || typeof special !== 'boolean') {
    throw new InvalidActionError('动作格式错误：move/turn 应为 [-1,1] 有限数值，fire/special 应为布尔值');
  }
  return { move, turn, fire, special };
}

function digital(value) {
  if (value >= 0.5) return 1;
  if (value <= -0.5) return -1;
  return 0;
}

export function normalizeAction(action) {
  const valid = validateAction(action);
  return { move: digital(valid.move), turn: digital(valid.turn), fire: valid.fire, special: valid.special };
}

export class DirectionGate {
  constructor(dwellTicks) {
    this.dwell = dwellTicks;
    this.direction = 0;
    this.lastActiveTick = -Infinity;
  }

  // 返回本 Tick 实际执行的方向。被门拦下时停车，而不是继续朝旧方向走：
  // 脚本已经放弃了旧方向，继续走可能把它送进炮弹。
  apply(requested, tick) {
    if (requested === 0) return 0;
    if (this.direction !== 0 && requested !== this.direction && tick - this.lastActiveTick <= this.dwell) return 0;
    this.direction = requested;
    this.lastActiveTick = tick;
    return requested;
  }
}

// 统计“请求方向翻转”：只要最近一次非零请求与本次相反就算一次，中间隔着 0 也算。
class FlipCounter {
  constructor(window) {
    this.window = window;
    this.last = 0;
    this.ticks = [];
  }

  add(value, tick) {
    if (value !== 0) {
      if (this.last !== 0 && value !== this.last) this.ticks.push(tick);
      this.last = value;
    }
    while (this.ticks.length && tick - this.ticks[0] >= this.window) this.ticks.shift();
    return this.ticks.length;
  }
}

export class TankControl {
  constructor(controls, tickRate) {
    this.moveGate = new DirectionGate(controls.reverseDwellTicks);
    this.turnGate = new DirectionGate(controls.turnDwellTicks);
    this.moveFlips = new FlipCounter(tickRate);
    this.turnFlips = new FlipCounter(tickRate);
    this.requestedMove = 0;
    this.requestedTurn = 0;
    this.appliedMove = 0;
    this.appliedTurn = 0;
    this.actionFlipCount = 0;
    this.turnFlipCount = 0;
  }

  apply(action, tick) {
    this.requestedMove = action.move;
    this.requestedTurn = action.turn;
    this.appliedMove = this.moveGate.apply(action.move, tick);
    this.appliedTurn = this.turnGate.apply(action.turn, tick);
    this.actionFlipCount = this.moveFlips.add(action.move, tick);
    this.turnFlipCount = this.turnFlips.add(action.turn, tick);
    return { move: this.appliedMove, turn: this.appliedTurn };
  }
}
