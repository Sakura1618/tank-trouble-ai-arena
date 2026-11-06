// 把比赛结果汇总成排名、战术指标和给 LLM 的失败反馈。

import { bootstrapElo, fitElo, matchScores, pairwise, wilson } from './rating.js';

function blank() {
  return {
    matches: 0, score: 0, wins: 0, draws: 0, losses: 0, kills: 0, deaths: 0, suicides: 0, directKills: 0, ricochetKills: 0,
    shots: 0, forfeits: 0, ticksAlive: 0, firstKillTicks: 0, firstKillCount: 0, opponentScore: 0,
    wallTicks: 0, stuckTicks: 0, gatedTicks: 0, requestedFlips: 0, actualReversals: 0, shortRuns: 0, runs: 0, turnFlips: 0,
    decisionMs: 0, decisionCalls: 0, maxDecisionMs: 0, overBudget: 0,
  };
}

const rate = (value, ticks) => (ticks ? value / (ticks / 60) : 0);

export function summarize(tasks, matches) {
  const keyMaps = tasks.map(task => Object.fromEntries(task.lineup.map(e => [e.id, e.key])));
  const bots = {};
  const versus = {};
  const groups = new Map();

  matches.forEach((match, i) => {
    const task = tasks[i];
    const keyOf = id => keyMaps[i][id];
    const scores = matchScores(match);
    const ids = Object.keys(scores);
    for (const id of ids) {
      const key = keyOf(id);
      const b = bots[key] ||= blank();
      const s = match.stats[id];
      const t = match.timings[id];
      const score = scores[id];
      b.matches++;
      b.score += score;
      b.wins += score === 1 ? 1 : 0;
      b.draws += score > 0 && score < 1 ? 1 : 0;
      b.losses += score === 0 ? 1 : 0;
      b.opponentScore += ids.filter(other => other !== id).reduce((sum, other) => sum + scores[other], 0) / Math.max(1, ids.length - 1);
      for (const field of ['kills', 'deaths', 'suicides', 'directKills', 'ricochetKills', 'shots', 'forfeits', 'ticksAlive',
        'wallTicks', 'stuckTicks', 'gatedTicks', 'requestedFlips', 'actualReversals', 'shortRuns', 'runs', 'turnFlips']) b[field] += s[field];
      if (s.firstKillTick !== null) { b.firstKillTicks += s.firstKillTick; b.firstKillCount++; }
      b.decisionMs += t.totalMs;
      b.decisionCalls += t.calls;
      b.maxDecisionMs = Math.max(b.maxDecisionMs, t.maxMs);
      b.overBudget += t.overBudget;
      for (const other of ids) {
        if (other === id) continue;
        const pair = (versus[key] ||= {})[keyOf(other)] ||= { matches: 0, score: 0 };
        pair.matches++;
        pair.score += score;
      }
    }
    const pairs = pairwise(match, keyOf);
    if (pairs.length) {
      if (!groups.has(task.group)) groups.set(task.group, []);
      groups.get(task.group).push(...pairs);
    }
  });

  const players = Object.keys(bots).sort();
  const groupList = [...groups.keys()].sort().map(key => groups.get(key));
  const allPairs = groupList.flat();
  const elo = players.length > 1 && allPairs.length ? fitElo(players, allPairs) : Object.fromEntries(players.map(p => [p, 1500]));
  const eloCi = players.length > 1 && groupList.length > 1 ? bootstrapElo(players, groupList) : {};

  const table = players.map(id => {
    const b = bots[id];
    const ci = wilson(b.score, b.matches);
    return {
      id, matches: b.matches, wins: b.wins, draws: b.draws, losses: b.losses,
      score: b.score / b.matches, scoreLow: ci.low, scoreHigh: ci.high,
      elo: elo[id], eloLow: eloCi[id]?.low ?? null, eloHigh: eloCi[id]?.high ?? null,
      kd: b.deaths ? b.kills / b.deaths : b.kills,
      aps: b.opponentScore / b.matches,
      directKillRate: b.directKills / b.matches,
      ricochetKillRate: b.ricochetKills / b.matches,
      suicideRate: b.suicides / b.matches,
      shotsPerKill: b.kills ? b.shots / b.kills : null,
      survivalSeconds: b.ticksAlive / 60 / b.matches,
      timeToKillSeconds: b.firstKillCount ? b.firstKillTicks / 60 / b.firstKillCount : null,
      wallContactPct: (b.wallTicks / Math.max(1, b.ticksAlive)) * 100,
      stuckPct: (b.stuckTicks / Math.max(1, b.ticksAlive)) * 100,
      gatedPct: (b.gatedTicks / Math.max(1, b.ticksAlive)) * 100,
      flipsPerSecond: rate(b.requestedFlips, b.ticksAlive),
      reversalsPerSecond: rate(b.actualReversals, b.ticksAlive),
      shortRunPct: b.runs ? (b.shortRuns / b.runs) * 100 : 0,
      turnFlipsPerSecond: rate(b.turnFlips, b.ticksAlive),
      decisionMs: b.decisionCalls ? b.decisionMs / b.decisionCalls : 0,
      maxDecisionMs: b.maxDecisionMs,
      overBudget: b.overBudget,
      forfeits: b.forfeits,
    };
  }).sort((a, b) => b.elo - a.elo);

  return { table, versus };
}

const fixed = (value, digits = 2) => (value === null || value === undefined ? '-' : value.toFixed(digits));
const pct = value => `${(value * 100).toFixed(1)}%`;

export function renderTable(summary) {
  const lines = [
    '| 选手 | 局数 | 胜/平/负 | 得分率 (95% CI) | Elo (95% CI) | K/D | APS |',
    '| --- | ---: | :---: | :---: | :---: | ---: | ---: |',
  ];
  for (const r of summary.table) {
    const eloCi = r.eloLow === null ? '' : ` (${r.eloLow.toFixed(0)}–${r.eloHigh.toFixed(0)})`;
    lines.push(`| ${r.id} | ${r.matches} | ${r.wins}/${r.draws}/${r.losses} | ${pct(r.score)} (${pct(r.scoreLow)}–${pct(r.scoreHigh)}) | ${r.elo.toFixed(0)}${eloCi} | ${fixed(r.kd)} | ${fixed(r.aps)} |`);
  }
  return lines.join('\n');
}

export function renderTactics(summary) {
  const lines = [
    '| 选手 | 直射杀/局 | 反弹杀/局 | 自杀/局 | 存活 s | 首杀 s | 撞墙% | 卡住% | 请求反向/s | 实际倒退/s | 短反向% | 转向翻转/s | 门限% | 决策 ms | 最大 ms | 判负 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const r of summary.table) {
    lines.push(`| ${r.id} | ${fixed(r.directKillRate)} | ${fixed(r.ricochetKillRate)} | ${fixed(r.suicideRate)} | ${fixed(r.survivalSeconds, 1)} | ${fixed(r.timeToKillSeconds, 1)} | ${fixed(r.wallContactPct, 1)} | ${fixed(r.stuckPct, 1)} | ${fixed(r.flipsPerSecond)} | ${fixed(r.reversalsPerSecond)} | ${fixed(r.shortRunPct, 0)} | ${fixed(r.turnFlipsPerSecond)} | ${fixed(r.gatedPct, 1)} | ${fixed(r.decisionMs)} | ${fixed(r.maxDecisionMs, 1)} | ${r.forfeits} |`);
  }
  return lines.join('\n');
}

export function renderVersus(summary) {
  const ids = summary.table.map(r => r.id);
  if (ids.length < 2) return '';
  const lines = [`| 行得分率 | ${ids.join(' | ')} |`, `| --- | ${ids.map(() => ':---:').join(' | ')} |`];
  for (const a of ids) {
    const row = ids.map(b => {
      const cell = summary.versus[a]?.[b];
      return a === b || !cell ? '·' : pct(cell.score / cell.matches);
    });
    lines.push(`| ${a} | ${row.join(' | ')} |`);
  }
  return lines.join('\n');
}

export function renderReport({ title, config, summary }) {
  return [
    `# ${title}`,
    '',
    `规则集 \`${config.ruleset}\` · 模式 \`${config.mode}\` · ${config.matchCount} 局 · 种子集 \`${config.seedLabel}\``,
    '',
    '## 排名',
    '',
    renderTable(summary),
    '',
    '## 对阵',
    '',
    renderVersus(summary),
    '',
    '## 战术与运动',
    '',
    renderTactics(summary),
    '',
    '得分率置信区间把每局当作独立样本；同图换边的两局有相关性，Elo 区间已按图分组重采样，以 Elo 区间为准。',
    '',
  ].join('\n');
}

// 给外部 LLM 的结构化反馈：只包含公开信息和可回放的证据，不含对手源码。
export function buildFeedback(bot, tasks, matches, replayPaths) {
  const losses = [];
  const causes = { direct: 0, ricochet: 0, suicide: 0, timeout: 0, forfeit: 0 };
  matches.forEach((match, i) => {
    const task = tasks[i];
    const me = task.lineup.find(e => e.key === bot);
    if (!me) return;
    const scores = matchScores(match);
    if (scores[me.id] >= 0.5) return;
    const player = match.result.players.find(p => p.id === me.id);
    const s = match.stats[me.id];
    const cause = player.forfeit ? 'forfeit' : s.suicides ? 'suicide' : match.result.reason === 'timeout' ? 'timeout' : null;
    const replay = match.replay;
    const opponent = task.lineup.filter(e => e.key !== bot).map(e => e.key).join('+') || bot;
    const killer = cause ?? killCause(match, me.id);
    causes[killer] = (causes[killer] ?? 0) + 1;
    losses.push({ index: i, seed: replay.seed, seatRotation: replay.seatRotation, opponent, cause: killer,
      ticks: match.result.ticks, forfeit: player.forfeit?.message ?? null, replay: replayPaths[i] ?? null });
  });
  return { bot, matches: matches.filter((_, i) => tasks[i].lineup.some(e => e.key === bot)).length, causes, losses: losses.slice(0, 40) };
}

function killCause(match, id) {
  const others = Object.entries(match.stats).filter(([other]) => other !== id);
  const ricochet = others.some(([, s]) => s.ricochetKills > 0);
  return ricochet ? 'ricochet' : 'direct';
}

export function renderFeedback(feedback, summary) {
  const row = summary.table.find(r => r.id === feedback.bot);
  const lines = [
    `# ${feedback.bot} 对战反馈`,
    '',
    row ? `得分率 ${pct(row.score)}（${pct(row.scoreLow)}–${pct(row.scoreHigh)}），Elo ${row.elo.toFixed(0)}，共 ${row.matches} 局。` : '',
    '',
    '## 失败原因',
    '',
    `直射 ${feedback.causes.direct} · 反弹 ${feedback.causes.ricochet} · 自杀 ${feedback.causes.suicide} · 超时未分胜负 ${feedback.causes.timeout} · 判负 ${feedback.causes.forfeit}`,
    '',
  ];
  if (row) {
    lines.push('## 运动诊断', '',
      `请求反向 ${fixed(row.flipsPerSecond)}/s，其中 ${fixed(row.shortRunPct, 0)}% 持续不足 6 Tick；实际倒退 ${fixed(row.reversalsPerSecond)}/s；反向门拦截 ${fixed(row.gatedPct, 1)}% 的 Tick；撞墙 ${fixed(row.wallContactPct, 1)}%，卡住 ${fixed(row.stuckPct, 1)}%。`,
      '被门拦下的 Tick 坦克是静止的：频繁请求反向等于主动停车。',
      '');
  }
  lines.push('## 失败样本', '', '| 种子 | 换边 | 对手 | 原因 | 时长 s | 录像 |', '| ---: | ---: | --- | --- | ---: | --- |');
  for (const loss of feedback.losses) {
    lines.push(`| ${loss.seed} | ${loss.seatRotation} | ${loss.opponent} | ${loss.cause}${loss.forfeit ? `：${loss.forfeit}` : ''} | ${(loss.ticks / 60).toFixed(1)} | ${loss.replay ?? '未保留'} |`);
  }
  lines.push('');
  return lines.join('\n');
}
