import { ArenaWorld } from '../engine/world.js';
import { observeDynamic, observeStatic } from '../engine/observation.js';
import { IDLE_ACTION, normalizeAction } from '../engine/controls.js';
import { botSeedFor, hashHex } from '../engine/rng.js';
import { getRuleset } from '../rulesets/index.js';
import { ReplayRecorder } from '../replay/format.js';
import { BotSandbox } from '../runtime/browser-sandbox.js';
import { ArenaRenderer } from './render/renderer.js';
import { snapshotWorld } from './render/frame.js';

// 浏览器比赛循环：与 Node 无头比赛共用世界、观测、控制层、录像格式和 Bot 宿主。
// 本模块只协调浏览器时间和真人输入，所以同一种子和同一批脚本两边结果一致。
export class ChallengeGame {
  constructor({ canvas, onUpdate = () => {}, onEnd = () => {}, onNotice = () => {} }) {
    Object.assign(this, { onUpdate, onEnd, onNotice });
    this.renderer = new ArenaRenderer(canvas, { maxDpr: 2 });
    this.status = 'idle';
    this.world = null;
    this.players = [];
    this.bots = [];
    this.humanAction = { ...IDLE_ACTION };
    this.simRate = 1;
    this.session = 0;
    this.frame = null;
    this.replay = null;
    this.tickStartedAt = 0;
  }

  update(status = this.status) {
    this.status = status;
    this.onUpdate({ world: this.world, status, simRate: this.simRate });
  }

  // rules: { ruleset, seed, maxSeconds?, mapStyle? }
  async start({ players, rules }) {
    this.stop();
    const session = this.session;
    this.players = players;
    this.rules = rules;
    this.humanAction = { ...IDLE_ACTION };
    this.simRate = 1;
    this.slowDevice = false;
    this.replay = null;
    const ruleset = getRuleset(rules.ruleset);
    this.ruleset = ruleset;
    const world = new ArenaWorld(players, { ruleset, seed: rules.seed, maxSeconds: rules.maxSeconds, mapStyle: rules.mapStyle });
    this.world = world;
    this.recorder = new ReplayRecorder(world, {
      maxSeconds: rules.maxSeconds, mapStyle: rules.mapStyle,
      entrants: players.map(p => ({ id: p.id, name: p.name, color: p.color, sourceHash: p.source ? hashHex(p.source) : null, label: p.kind })),
    });
    this.bots = players.filter(p => p.kind === 'ai').map(p => new BotSandbox(p, ruleset.budget));
    this.renderer.reset();
    this.renderer.push(snapshotWorld(world));
    this.update('loading');
    this.render(session);

    const statics = observeStatic(world);
    this.revision = world.mapRevision;
    const bots = this.bots;
    const initialized = await Promise.all(bots.map(bot => this.call(bot, () => bot.start({
      seed: botSeedFor(world.seeds.botSeed, bot.entrant.id), statics,
      selfId: bot.entrant.id, playerCount: players.length,
    }))));
    if (session !== this.session) return;
    this.applyFaults(initialized);
    if (world.result) { this.finish(); return; }
    this.resetPacing();
    this.update('running');
    this.running = this.run(session, world, bots).catch(error => {
      if (session !== this.session) return;
      this.bots.forEach(bot => bot.dispose());
      this.humanAction = { ...IDLE_ACTION };
      this.update('error');
      this.onNotice(`对局已停止：${error.message}`);
    });
  }

  setHumanAction(action) {
    this.humanAction = { move: action.move ?? 0, turn: action.turn ?? 0, fire: !!action.fire, special: !!action.special };
  }

  async call(bot, fn) {
    try {
      return { id: bot.entrant.id, action: await fn() };
    } catch (error) {
      bot.dispose();
      const code = error.code || 'script_error';
      return { id: bot.entrant.id, action: IDLE_ACTION, fault: {
        code, message: error.message, elapsedMs: error.elapsedMs, timeout: code.endsWith('_timeout'),
      } };
    }
  }

  applyFaults(replies) {
    for (const { id, fault } of replies) {
      if (!fault) continue;
      this.recorder.addForfeit(id, fault);
      this.world.forfeit(id, fault);
      const name = this.players.find(p => p.id === id).name;
      const timing = fault.code === 'queue_timeout'
        ? '执行实例排队或启动未响应，可能是设备负载或浏览器限制'
        : fault.code === 'unresponsive_timeout'
          ? `执行后 ${this.ruleset.budget.hardMs} ms 未返回，已终止本选手`
          : fault.message;
      this.onNotice(`${name}：${timing}。本局判负，其他选手继续。`);
    }
    // 所有本 Tick 故障先一起处理，胜负不依赖 Worker 消息到达顺序。
    this.world.settle();
  }

  resetPacing() {
    const now = performance.now();
    this.due = now;
    this.sampleTime = now;
    this.sampleTick = this.world.tick;
    this.lastUpdate = now;
    this.tickStartedAt = now;
  }

  async waitForResume(session) {
    if (this.status === 'paused') await new Promise(resolve => { this.resumeWait = resolve; });
    return session === this.session && this.status === 'running';
  }

  async decideAll(world, bots) {
    return Promise.all(bots.map(bot => {
      const actor = world.byId.get(bot.entrant.id);
      if (!actor.tank.alive) return { id: bot.entrant.id, action: IDLE_ACTION };
      return this.call(bot, async () => {
        if (world.mapRevision !== this.revision) await bot.setStatic(observeStatic(world));
        const raw = await bot.decide(JSON.stringify(observeDynamic(world, bot.entrant.id, bot.apiVersion)));
        return normalizeAction(raw);
      });
    }));
  }

  async run(session, world, bots) {
    const dt = world.dt;
    while (session === this.session && !world.result) {
      if (!(await this.waitForResume(session))) return;
      // 所有 AI 观察同一个 Tick；全部回复后才推进一次固定物理。
      const replies = await this.decideAll(world, bots);
      this.revision = world.mapRevision;
      if (!(await this.waitForResume(session))) return;
      const actions = Object.fromEntries(replies.map(reply => [reply.id, reply.action]));
      for (const player of this.players) {
        if (player.kind === 'human') actions[player.id] = normalizeAction(this.humanAction);
      }
      if (replies.some(reply => reply.fault)) this.applyFaults(replies);
      if (world.result) break;
      this.recorder.capture(actions);
      world.step(actions);
      this.recorder.afterStep();
      this.renderer.push(snapshotWorld(world));

      const now = performance.now();
      this.tickDuration = Math.max(dt * 1000, now - this.tickStartedAt);
      this.tickStartedAt = now;
      if (now - this.sampleTime >= 2000) {
        this.simRate = Math.min(1, (world.tick - this.sampleTick) * dt * 1000 / (now - this.sampleTime));
        const slow = this.simRate < 0.85;
        if (slow !== this.slowDevice) {
          this.slowDevice = slow;
          this.onNotice(slow
            ? `当前设备约以 ${Math.round(this.simRate * 100)}% 实时速度运行。物理仍为固定 60 Hz，比赛结果不受影响。`
            : '设备已恢复实时运行。');
        }
        this.sampleTime = now;
        this.sampleTick = world.tick;
      }
      if (now - this.lastUpdate >= 100) { this.lastUpdate = now; this.update(); }
      // 设备较慢时放慢模拟时间，不跳过物理 Tick，也不在恢复后突发追帧。
      this.due = Math.max(this.due + dt * 1000, now);
      const wait = this.due - performance.now();
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    }
    if (session === this.session && world.result) this.finish();
  }

  render(session) {
    let last = performance.now();
    const draw = () => {
      if (session !== this.session) return;
      const now = performance.now();
      const elapsed = (now - last) / 1000;
      last = now;
      const running = this.status === 'running';
      const alpha = running && this.tickDuration ? Math.min(1, (now - this.tickStartedAt) / this.tickDuration) : 1;
      this.renderer.draw(elapsed, !running && this.status !== 'finished', alpha);
      this.frame = requestAnimationFrame(draw);
    };
    this.frame = requestAnimationFrame(draw);
  }

  finish() {
    this.bots.forEach(bot => bot.dispose());
    this.humanAction = { ...IDLE_ACTION };
    this.replay = this.recorder.finish();
    this.update('finished');
    this.onEnd(this.world.result);
  }

  pause() {
    this.humanAction = { ...IDLE_ACTION };
    if (this.status === 'running') this.update('paused');
  }

  resume() {
    if (this.status !== 'paused') return;
    this.resetPacing();
    this.update('running');
    this.resumeWait?.();
    this.resumeWait = null;
  }

  stop() {
    this.session++;
    this.humanAction = { ...IDLE_ACTION };
    this.bots.forEach(bot => bot.dispose());
    this.bots = [];
    this.resumeWait?.();
    this.resumeWait = null;
    cancelAnimationFrame(this.frame);
    this.frame = null;
    this.update('stopped');
  }
}
