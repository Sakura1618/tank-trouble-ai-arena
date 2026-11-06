// Node 端 Bot 执行器：每个选手一个 vm 上下文，与浏览器 Worker 共用 botHostMain。
// vm 不是恶意代码的安全边界，这里防的是互相干扰、卡死和不确定性。
// 只运行你信任的脚本；赛事并发时外层还有 worker_threads 隔离。

import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { botHostMain } from './bot-host.js';

const BOOTSTRAP = new vm.Script(`globalThis.__host = (${botHostMain.toString()})(globalThis);`, { filename: 'bot-host.js' });
const CALLS = {
  init: new vm.Script('__host.init(__input)'),
  tick: new vm.Script('__host.tick(__input)'),
  setStatic: new vm.Script('__host.setStatic(__input)'),
};

export class BotFault extends Error {
  constructor(code, message, elapsedMs) {
    super(message);
    this.code = code;
    this.elapsedMs = elapsedMs;
    this.timeout = code.endsWith('_timeout');
  }
}

export class NodeBot {
  constructor({ source, seed, selfId, playerCount, statics, budget }) {
    this.budget = budget;
    this.context = vm.createContext({}, { codeGeneration: { strings: true, wasm: false }, microtaskMode: 'afterEvaluate' });
    BOOTSTRAP.runInContext(this.context);
    const reply = this.call('init', JSON.stringify({ source, seed, context: { statics, selfId, playerCount } }), budget.initMs, 'init_timeout');
    this.apiVersion = JSON.parse(reply).apiVersion;
  }

  call(name, input, timeout, timeoutCode) {
    this.context.__input = input;
    const start = performance.now();
    try {
      const reply = CALLS[name].runInContext(this.context, { timeout });
      this.lastElapsedMs = performance.now() - start;
      return reply;
    } catch (error) {
      const elapsedMs = performance.now() - start;
      if (error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        throw new BotFault(timeoutCode, `脚本 ${timeout} ms 内未返回`, elapsedMs);
      }
      throw new BotFault('script_error', String(error?.message ?? error).slice(0, 800), elapsedMs);
    }
  }

  setStatic(statics) {
    this.call('setStatic', JSON.stringify(statics), this.budget.hardMs, 'unresponsive_timeout');
  }

  decide(dynamicJson) {
    return JSON.parse(this.call('tick', dynamicJson, this.budget.hardMs, 'unresponsive_timeout'));
  }
}
