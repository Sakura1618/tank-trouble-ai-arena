// Bot 宿主：在隔离环境里加载脚本、提供确定性环境、执行决策。
// 这个函数会被 toString() 注入浏览器 Worker 和 Node vm，两边跑的是同一份代码，
// 因此不能引用任何外部变量。输入输出都是 JSON 字符串，宿主对象不进入隔离环境。
export function botHostMain(scope) {
  const NativeDate = scope.Date;
  const compile = scope.Function;
  let virtualMs = 0;

  // 脚本可见的时间全部来自 Tick。真实墙钟会让“算到超时就停”的搜索每次走得不一样，
  // 同一份脚本就不再可复现。
  class VirtualDate extends NativeDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(virtualMs);
    }
    static now() { return virtualMs; }
  }

  function define(key, value) {
    try { Object.defineProperty(scope, key, { value, writable: false, configurable: false }); } catch { /* 宿主已锁定 */ }
  }

  define('Date', VirtualDate);
  define('performance', Object.freeze({ now: () => virtualMs, timeOrigin: 0 }));
  // 比赛接口是同步纯 JS：不提供后台任务、子 Worker、外部通信和熵源。
  for (const key of ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebTransport', 'EventSource', 'Worker', 'SharedWorker',
    'BroadcastChannel', 'importScripts', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval',
    'queueMicrotask', 'requestAnimationFrame', 'crypto', 'indexedDB', 'caches', 'navigator']) {
    if (key in scope) define(key, undefined);
  }

  // sfc32：与 engine/rng.js 同一算法。脚本可以调用 Math.random，但结果由比赛种子决定。
  let a = 0;
  let b = 0;
  let c = 0;
  let d = 1;
  function uint() {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  }
  function seedRandom(seed) {
    a = seed ^ 0x9e3779b9;
    b = seed ^ 0x243f6a88;
    c = seed ^ 0xb7e15162;
    d = 1;
    for (let i = 0; i < 12; i++) uint();
  }
  scope.Math.random = () => uint() / 0x100000000;

  let update = null;
  let statics = null;
  let apiVersion = 1;

  return {
    init(json) {
      const { source, seed, context } = JSON.parse(json);
      seedRandom(seed);
      statics = context.statics;
      const module = { exports: {} };
      compile('module', 'exports', `"use strict";\n${source}`)(module, module.exports);
      const bot = module.exports;
      if (!bot || typeof bot.update !== 'function') {
        throw new Error('脚本必须导出 module.exports = { update(state) { ... } }');
      }
      update = bot.update.bind(bot);
      apiVersion = bot.apiVersion === 2 ? 2 : 1;
      if (typeof bot.init === 'function') {
        bot.init({ apiVersion, selfId: context.selfId, playerCount: context.playerCount, ...statics });
      }
      return JSON.stringify({ apiVersion });
    },

    setStatic(json) { statics = JSON.parse(json); return '{}'; },

    tick(json) {
      const state = JSON.parse(json);
      virtualMs = state.tick * state.dt * 1000;
      state.apiVersion = apiVersion;
      state.map = statics.map;
      state.rules = statics.rules;
      state.physics = statics.physics;
      const action = update(state);
      if (!action || typeof action !== 'object' || typeof action.then === 'function' || Array.isArray(action)) {
        throw new Error('update 必须同步返回动作对象');
      }
      const move = action.move ?? 0;
      const turn = action.turn ?? 0;
      // JSON 会把 NaN/Infinity 变成 null，出了宿主就分不清“非法”和“缺省”。
      if ((typeof move === 'number' && !Number.isFinite(move)) || (typeof turn === 'number' && !Number.isFinite(turn))) {
        throw new Error('动作格式错误：move/turn 必须是有限数值');
      }
      return JSON.stringify({ move, turn, fire: action.fire ?? false, special: action.special ?? false });
    },
  };
}
