// 浏览器 Bot 执行器：每个选手一个不透明来源 iframe 里的 Web Worker。
// 宿主逻辑与 Node 端共用 botHostMain，保证同一场比赛两边结果一致。
// 墙钟只用来统计和拦截卡死：超过 budget.hardMs 判负，decisionMs 只统计。

import { botHostMain } from './bot-host.js';

export const QUEUE_MS = 2000;

// 只在 Worker 内运行。真实计时必须在 botHostMain 替换 performance 之前取到。
function workerMain(hostSource) {
  const send = globalThis.postMessage.bind(globalThis);
  const now = performance.now.bind(performance);
  // eslint-disable-next-line no-new-func
  const host = new Function('scope', `return (${hostSource})(scope);`)(globalThis);
  globalThis.onmessage = ({ data }) => {
    send({ phase: 'started' });
    const start = now();
    try {
      const reply = host[data.type](data.payload);
      send({ reply, elapsedMs: now() - start });
    } catch (error) {
      send({ error: String(error?.message || error).slice(0, 800), code: 'script_error', elapsedMs: now() - start });
    }
  };
}

// 可信中继只持有本选手 Worker，使用专属 MessagePort，不接受其他选手的消息。
function frameMain() {
  window.onmessage = event => {
    if (event.source !== parent || !event.ports[0]) return;
    window.onmessage = null;
    const port = event.ports[0];
    const url = URL.createObjectURL(new Blob([event.data.worker], { type: 'text/javascript' }));
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    port.onmessage = e => {
      if (e.data.type === 'terminate') { worker.terminate(); port.close(); } else worker.postMessage(e.data);
    };
    worker.onmessage = e => port.postMessage(e.data);
    worker.onerror = e => { e.preventDefault(); port.postMessage({ error: e.message || 'Worker 执行异常', code: 'script_error' }); };
    port.postMessage({ connected: true });
  };
}

const WORKER_SOURCE = `(${workerMain.toString()})(${JSON.stringify(botHostMain.toString())})`;
const CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; connect-src 'none'";

export class BotSandbox {
  constructor(entrant, budget) {
    this.entrant = entrant;
    this.budget = budget;
    this.apiVersion = 1;
    this.lastElapsedMs = 0;
  }

  // init: { seed, statics, selfId, playerCount }
  async start(init) {
    this.frame = document.createElement('iframe');
    this.frame.hidden = true;
    this.frame.setAttribute('sandbox', 'allow-scripts');
    this.frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="${CSP}"><script>(${frameMain.toString()})()<\/script>`;
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = ({ data }) => this.receive(data);
    const ready = this.waitForReply(this.budget.initMs, 'connect');
    this.frame.onload = () => this.frame.contentWindow.postMessage({ worker: WORKER_SOURCE }, '*', [channel.port2]);
    document.body.append(this.frame);
    await ready;
    const payload = JSON.stringify({ source: this.entrant.source, seed: init.seed,
      context: { statics: init.statics, selfId: init.selfId, playerCount: init.playerCount } });
    const reply = await this.request({ type: 'init', payload }, this.budget.initMs);
    this.apiVersion = JSON.parse(reply.reply).apiVersion;
  }

  receive(data) {
    const pending = this.pending;
    if (!pending) return;
    if (data.phase === 'started') {
      if (!pending.started) { pending.started = true; this.armTimer(pending, pending.executionMs); }
      return;
    }
    clearTimeout(pending.timer);
    this.pending = null;
    if (data.error) pending.reject(Object.assign(new Error(data.error), { code: data.code || 'script_error', elapsedMs: data.elapsedMs }));
    else pending.resolve(data);
  }

  armTimer(pending, ms) {
    clearTimeout(pending.timer);
    const due = performance.now() + ms;
    pending.timer = setTimeout(() => {
      if (this.pending !== pending) return;
      // 宿主定时器本身严重迟到（如页面被挂起）时，给已排队的回复一次派发机会。
      if (!pending.resumeGrace && performance.now() - due > this.budget.decisionMs) {
        pending.resumeGrace = true;
        this.armTimer(pending, this.budget.hardMs);
        return;
      }
      this.pending = null;
      const code = !pending.started ? 'queue_timeout' : pending.type === 'init' ? 'init_timeout' : 'unresponsive_timeout';
      const message = !pending.started ? '执行实例排队或启动后未响应'
        : pending.type === 'init' ? `脚本初始化 ${this.budget.initMs} ms 内未返回`
          : `Worker 开始执行后 ${this.budget.hardMs} ms 内未返回（硬终止）`;
      this.dispose();
      pending.reject(Object.assign(new Error(message), { code }));
    }, ms);
  }

  waitForReply(executionMs, type) {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, executionMs, type, started: false, resumeGrace: false };
      this.armTimer(this.pending, QUEUE_MS);
    });
  }

  request(message, ms = this.budget.hardMs) {
    const reply = this.waitForReply(ms, message.type);
    this.port.postMessage(message);
    return reply;
  }

  setStatic(statics) { return this.request({ type: 'setStatic', payload: JSON.stringify(statics) }); }

  async decide(dynamicJson) {
    const { reply, elapsedMs } = await this.request({ type: 'tick', payload: dynamicJson });
    this.lastElapsedMs = elapsedMs;
    return JSON.parse(reply);
  }

  dispose() {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error('比赛已停止'));
      this.pending = null;
    }
    this.port?.postMessage({ type: 'terminate' });
    this.port?.close();
    this.frame?.remove();
  }
}
