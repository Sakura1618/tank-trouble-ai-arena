import { ReplaySession, verifyReplay } from '../replay/format.js';
import { MatchStats } from '../engine/stats.js';
import { ArenaRenderer } from './render/renderer.js';
import { snapshotWorld } from './render/frame.js';

const $ = id => document.getElementById(id);
const LAST_REPLAY_KEY = 'arena-last-replay';
const TRACK_HEIGHT = 58;

const renderer = new ArenaRenderer($('canvas'), { maxDpr: 2 });
let frames = [];
let series = {};
let cursor = 0;
let playing = false;
let tickRate = 60;
let accumulator = 0;
let lastTime = performance.now();

function notice(message) {
  $('notice').textContent = message;
  $('notice').classList.add('error');
  $('notice').hidden = false;
}

// 一次重算整局，把每 Tick 的画面和控制诊断都存下来，拖动时间轴不用再模拟。
function simulate(replay) {
  const session = new ReplaySession(replay);
  const { world } = session;
  const stats = new MatchStats(world);
  const out = [snapshotWorld(world)];
  const lanes = Object.fromEntries(world.actors.map(p => [p.id, { name: p.name, color: p.color, ticks: [] }]));
  for (;;) {
    const before = world.tick;
    session.step();
    if (world.tick === before) break;
    stats.afterStep();
    out.push(snapshotWorld(world));
    for (const p of world.actors) {
      lanes[p.id].ticks.push({
        requested: p.control.requestedMove, applied: p.control.appliedMove,
        wall: Math.abs(p.motion.wallX) + Math.abs(p.motion.wallY) > 1e-6,
        tank: Math.abs(p.motion.tankX) + Math.abs(p.motion.tankY) > 1e-6,
        alive: p.tank.alive,
      });
    }
    if (world.result) break;
  }
  return { frames: out, lanes, stats: stats.finish(), ruleset: world.ruleset };
}

function drawLane(canvas, lane) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(TRACK_HEIGHT * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const width = rect.width;
  const n = Math.max(1, lane.ticks.length);
  const mid = (TRACK_HEIGHT - 12) / 2;
  const x = i => (i / n) * width;
  const y = value => mid - value * (mid - 4);
  ctx.strokeStyle = 'rgba(255,255,255,.14)';
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(width, mid);
  ctx.stroke();
  const trace = (key, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    lane.ticks.forEach((t, i) => (i ? ctx.lineTo(x(i), y(t[key])) : ctx.moveTo(x(i), y(t[key]))));
    ctx.stroke();
  };
  trace('requested', '#73b9ff');
  trace('applied', '#43dfbd');
  lane.ticks.forEach((t, i) => {
    const flags = [[t.requested !== t.applied, '#ef5b6b'], [t.wall, '#ffb86b'], [t.tank, '#b69aff']];
    flags.forEach(([on, color], row) => {
      if (!on) return;
      ctx.fillStyle = color;
      ctx.fillRect(x(i), TRACK_HEIGHT - 10 + row * 3, Math.max(1, width / n), 2);
    });
  });
}

function renderDiagnostics(lanes, stats) {
  const tracks = Object.entries(lanes).map(([id, lane]) => {
    const row = document.createElement('div');
    row.className = 'track';
    const label = document.createElement('div');
    label.className = 'track-label';
    const dot = document.createElement('i');
    dot.className = 'player-dot';
    dot.style.background = lane.color;
    label.append(dot, document.createTextNode(lane.name));
    const canvas = document.createElement('canvas');
    canvas.className = 'track-canvas';
    canvas.style.height = `${TRACK_HEIGHT}px`;
    canvas.dataset.id = id;
    row.append(label, canvas);
    return row;
  });
  $('tracks').replaceChildren(...tracks);
  for (const canvas of document.querySelectorAll('.track-canvas')) drawLane(canvas, lanes[canvas.dataset.id]);

  const rows = Object.entries(stats).map(([id, s]) => {
    const seconds = Math.max(1 / 60, s.ticksAlive / 60);
    const cells = [lanes[id].name, (s.requestedFlips / seconds).toFixed(2), (s.actualReversals / seconds).toFixed(2),
      `${(s.gatedTicks / Math.max(1, s.ticksAlive) * 100).toFixed(1)}%`, `${(s.wallTicks / Math.max(1, s.ticksAlive) * 100).toFixed(1)}%`,
      `${(s.tankContactTicks / Math.max(1, s.ticksAlive) * 100).toFixed(1)}%`];
    const tr = document.createElement('tr');
    for (const text of cells) { const td = document.createElement('td'); td.textContent = text; tr.append(td); }
    return tr;
  });
  const table = document.createElement('table');
  table.className = 'metrics-table';
  const head = document.createElement('tr');
  for (const text of ['选手', '请求反向/s', '实际倒退/s', '门限', '撞墙', '互推']) {
    const th = document.createElement('th');
    th.textContent = text;
    head.append(th);
  }
  table.append(head, ...rows);
  $('metrics').replaceChildren(table);
}

function show(index, jump) {
  cursor = Math.max(0, Math.min(frames.length - 1, index));
  renderer.push(frames[cursor], { jump });
  $('seek').value = String(cursor);
  $('clock').textContent = `${(cursor / tickRate).toFixed(2)} s`;
}

function setPlaying(next) {
  playing = next;
  $('play').textContent = playing ? '暂停' : '播放';
  accumulator = 0;
}

function open(replay) {
  try {
    const simulation = simulate(replay);
    frames = simulation.frames;
    series = simulation.lanes;
    tickRate = simulation.ruleset.tickRate;
    const names = replay.entrants.map(e => e.name).join(' · ');
    const winner = replay.entrants.find(e => e.id === replay.result.winnerId);
    $('replay-meta').textContent = `${names} · ${replay.ruleset.id} · 种子 ${replay.seed} · ${(replay.result.ticks / tickRate).toFixed(1)} 秒 · ${winner ? `${winner.name} 获胜` : '无胜者'}`;
    $('replay-main').hidden = false;
    $('seek').max = String(frames.length - 1);
    renderer.reset();
    show(0, true);
    renderDiagnostics(series, simulation.stats);
    const report = verifyReplay(replay);
    $('verify').textContent = report.ok
      ? `逐位复现：${report.ticks} Tick，${report.checkpoints} 个检查点全部一致`
      : `第 ${report.firstMismatchTick} Tick 分叉（${report.reason}）`;
    $('verify').classList.toggle('bad', !report.ok);
    setPlaying(false);
  } catch (error) {
    notice(`无法打开录像：${error.message}`);
  }
}

async function openFile(file) {
  try { open(JSON.parse(await file.text())); } catch (error) { notice(`无法读取 ${file.name}：${error.message}`); }
}

function loop(now) {
  const elapsed = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;
  let alpha = 1;
  if (playing && frames.length) {
    accumulator += elapsed * Number($('speed').value) * tickRate;
    while (accumulator >= 1) {
      accumulator -= 1;
      if (cursor >= frames.length - 1) { setPlaying(false); break; }
      show(cursor + 1, false);
    }
    alpha = Math.min(1, accumulator);
  }
  if (renderer.current) renderer.draw(elapsed, !playing, alpha);
  requestAnimationFrame(loop);
}

$('open-file').onclick = () => $('file').click();
$('file').onchange = e => { if (e.target.files[0]) openFile(e.target.files[0]); };
$('play').onclick = () => {
  if (!frames.length) return;
  if (cursor >= frames.length - 1) show(0, true);
  setPlaying(!playing);
};
$('back').onclick = () => { setPlaying(false); show(cursor - 1, true); };
$('forward').onclick = () => { setPlaying(false); show(cursor + 1, true); };
$('seek').oninput = e => { setPlaying(false); show(Number(e.target.value), true); };
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  if (e.dataTransfer.files[0]) openFile(e.dataTransfer.files[0]);
});
window.addEventListener('keydown', e => {
  if (!frames.length || e.target.closest('input, select')) return;
  if (e.code === 'Space') { e.preventDefault(); $('play').click(); }
  if (e.code === 'ArrowLeft') $('back').click();
  if (e.code === 'ArrowRight') $('forward').click();
});
window.addEventListener('resize', () => {
  for (const canvas of document.querySelectorAll('.track-canvas')) drawLane(canvas, series[canvas.dataset.id]);
});

requestAnimationFrame(loop);
try {
  const saved = sessionStorage.getItem(LAST_REPLAY_KEY);
  if (saved) open(JSON.parse(saved));
} catch { /* 隐私模式下读不到存储，等用户手动选择文件 */ }
