#!/usr/bin/env node
// 竞技场命令行。比赛期间不调用任何 LLM；LLM 读 feedback，改脚本，再提交给 gate。

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { getRuleset, DEFAULT_RULESET, rulesetHash } from '../rulesets/index.js';
import { verifyReplay } from '../replay/format.js';
import { prepareBots, resolveBot, resolvePool, ROOT } from './bots.js';
import * as schedule from './schedule.js';
import { executeRun } from './run.js';
import { defaultWorkers } from './pool.js';
import { buildFeedback, renderFeedback, renderTable, renderTactics } from './report.js';
import { runGate } from './gate.js';
import { ArenaStore } from './store.js';

const HELP = `用法：node tournament/cli.js <命令> [选手...] [选项]

比赛：
  duel <A> <B>              1v1，每个种子换边各打一局
  mirror <A>                自己打自己，检查稳定性和席位偏差
  melee <A> <B> [C] [D]...  多方混战，每个种子轮换全部席位
  gauntlet <A> --pool <P>   连续挑战对手池
  round-robin --pool <P>    循环赛，输出完整排名
  benchmark <A> --pool <P>  固定基准集回归

进化：
  gate <候选> --champion <现任> [--pool <P>]   公开种子 → 留出种子 → 基准回归
  feedback <A> <B>          跑一组对局并写出给 LLM 的失败报告
  champion                  查看历代冠军
  leaderboard               查看累计战绩

录像：
  replay-verify <文件...>    重算录像并比对状态哈希

选项：
  --seeds N        种子数（默认 20；gate 公开阶段使用基准集）
  --suite ID       基准集，如 classic-v1/public
  --ruleset ID     规则集（默认 ${DEFAULT_RULESET}）
  --pool P         all | baseline | reference | champions | id1,id2,...
  --max-seconds N  单局时限
  --replays M      all | losses | none（默认 losses）
  --workers N      并行线程（默认 ${defaultWorkers()}）
  --holdout N      留出种子数（默认 200）
  --results DIR    输出目录（默认 results/）
`;

// champions 是一个动态池：从数据库读出历代冠军的源码快照。
async function poolFrom(spec, rulesetId, resultsDir) {
  if (spec !== 'champions') return resolvePool(spec);
  const store = new ArenaStore(resultsDir);
  const list = store.champions(rulesetId);
  store.close();
  if (!list.length) throw new Error(`${rulesetId} 还没有历代冠军，先用 gate 晋级一名选手`);
  const bots = await Promise.all(list.map(c => resolveBot(c.file)));
  return [...new Map(bots.map(b => [b.hash, b])).values()];
}

const OPTIONS = {
  seeds: { type: 'string' }, suite: { type: 'string' }, ruleset: { type: 'string' }, pool: { type: 'string' },
  'max-seconds': { type: 'string' }, replays: { type: 'string' }, workers: { type: 'string' }, holdout: { type: 'string' },
  results: { type: 'string' }, champion: { type: 'string' }, help: { type: 'boolean', short: 'h' },
};

function seedsFrom(values, fallbackSuite) {
  if (values.suite) {
    const suite = schedule.loadSuite(values.suite);
    return { seeds: suite.seeds, label: suite.id };
  }
  const count = Number(values.seeds ?? 20);
  const label = `${fallbackSuite}:${count}`;
  return { seeds: schedule.seedList(fallbackSuite, count), label };
}

async function main() {
  const { values, positionals } = parseArgs({ options: OPTIONS, allowPositionals: true });
  const [command, ...specs] = positionals;
  if (!command || values.help) { console.log(HELP); return; }

  const rulesetId = values.ruleset ?? DEFAULT_RULESET;
  getRuleset(rulesetId);
  const resultsDir = path.resolve(values.results ?? path.join(ROOT, 'results'));
  const maxSeconds = values['max-seconds'] ? Number(values['max-seconds']) : undefined;
  const workers = values.workers ? Number(values.workers) : defaultWorkers();
  const replays = values.replays ?? 'losses';
  const common = { rulesetId, resultsDir, maxSeconds, workers, replays };

  const finish = run => {
    console.log(`\n${renderTable(run.summary)}\n\n${renderTactics(run.summary)}\n`);
    console.log(`报告：${path.relative(process.cwd(), path.join(run.dir, 'report.md'))}`);
    return run;
  };

  switch (command) {
    case 'duel': {
      const bots = prepareBots(await Promise.all(specs.slice(0, 2).map(s => resolveBot(s))));
      if (bots.length !== 2) throw new Error('duel 需要两名选手');
      const { seeds, label } = seedsFrom(values, 'duel');
      finish(await executeRun({ ...common, title: `对决：${bots[0].id} vs ${bots[1].id}`, mode: 'duel', bots, matches: schedule.duel(bots[0], bots[1], seeds), seedLabel: label }));
      break;
    }
    case 'mirror': {
      const [bot] = prepareBots([await resolveBot(specs[0])]);
      const { seeds, label } = seedsFrom(values, 'mirror');
      const run = await executeRun({ ...common, title: `镜像：${bot.id}`, mode: 'mirror', bots: [bot], matches: schedule.mirror(bot, seeds), seedLabel: label });
      const bySpawn = [0, 0];
      run.results.forEach(match => {
        const seat = match.seat.indexOf(match.result.winnerId);
        if (seat >= 0) bySpawn[(seat + match.replay.seatRotation) % 2]++;
      });
      finish(run);
      console.log(`出生点胜场：A ${bySpawn[0]}，B ${bySpawn[1]}`);
      break;
    }
    case 'melee': {
      const bots = prepareBots(await Promise.all(specs.map(s => resolveBot(s))));
      if (bots.length < 3) throw new Error('melee 至少需要三名选手');
      const { seeds, label } = seedsFrom(values, 'melee');
      finish(await executeRun({ ...common, title: `混战：${bots.map(b => b.id).join('、')}`, mode: 'melee', bots, matches: schedule.melee(bots, seeds), seedLabel: label }));
      break;
    }
    case 'gauntlet':
    case 'benchmark': {
      const challenger = await resolveBot(specs[0]);
      const pool = await poolFrom(values.pool ?? 'reference', rulesetId, resultsDir);
      const bots = prepareBots([challenger, ...pool.filter(b => b.id !== challenger.id)]);
      const { seeds, label } = command === 'benchmark'
        ? seedsFrom({ ...values, suite: values.suite ?? `${rulesetId}/public` }, 'benchmark')
        : seedsFrom(values, 'gauntlet');
      finish(await executeRun({ ...common, title: `${command === 'benchmark' ? '基准' : '车轮战'}：${challenger.id}`, mode: command, bots, matches: schedule.gauntlet(bots[0], bots.slice(1), seeds), seedLabel: label, focus: challenger.id }));
      break;
    }
    case 'round-robin': {
      const bots = prepareBots(await poolFrom(values.pool ?? 'all', rulesetId, resultsDir));
      const { seeds, label } = seedsFrom(values, 'round-robin');
      finish(await executeRun({ ...common, title: '循环赛', mode: 'round-robin', bots, matches: schedule.roundRobin(bots, seeds), seedLabel: label }));
      break;
    }
    case 'gate': {
      if (!values.champion) throw new Error('gate 需要 --champion');
      const [candidate, champion] = prepareBots([await resolveBot(specs[0]), await resolveBot(values.champion)]);
      const pool = values.pool ? prepareBots(await poolFrom(values.pool, rulesetId, resultsDir)) : [];
      const outcome = await runGate({ candidate, champion, pool, rulesetId, resultsDir, workers, replays, maxSeconds,
        suiteId: values.suite ?? `${rulesetId}/public`, holdoutCount: Number(values.holdout ?? 200) });
      for (const s of outcome.stages) {
        const detail = s.ci ? `得分率 ${(s.rate * 100).toFixed(1)}%（95% 下限 ${(s.ci.low * 100).toFixed(1)}%）` : `得分率 ${(s.rate * 100).toFixed(1)}%（现任 ${(s.baseline * 100).toFixed(1)}%）`;
        console.log(`${s.pass ? '通过' : '未通过'} · ${s.name} · ${detail}`);
      }
      console.log(outcome.promoted ? `晋级：${candidate.id} 成为 ${rulesetId} 新冠军` : `淘汰：${champion.id} 继续卫冕`);
      process.exitCode = outcome.promoted ? 0 : 2;
      break;
    }
    case 'feedback': {
      const bots = prepareBots(await Promise.all(specs.slice(0, 2).map(s => resolveBot(s))));
      if (bots.length !== 2) throw new Error('feedback 需要自己和一名对手');
      const { seeds, label } = seedsFrom(values, 'feedback');
      const run = await executeRun({ ...common, title: `反馈：${bots[0].id}`, mode: 'feedback', bots, matches: schedule.duel(bots[0], bots[1], seeds), seedLabel: label, focus: bots[0].id });
      const feedback = buildFeedback(bots[0].id, run.tasks, run.results, run.replayPaths);
      const file = path.join(run.dir, 'feedback.md');
      fs.writeFileSync(file, renderFeedback(feedback, run.summary));
      fs.writeFileSync(path.join(run.dir, 'feedback.json'), JSON.stringify(feedback, null, 2));
      console.log(renderFeedback(feedback, run.summary));
      console.log(`反馈：${path.relative(process.cwd(), file)}`);
      break;
    }
    case 'champion': {
      const store = new ArenaStore(resultsDir);
      const list = store.champions(rulesetId);
      store.close();
      if (!list.length) console.log(`${rulesetId} 还没有冠军。`);
      for (const c of list) console.log(`${c.promoted_at}  ${c.label}  ${c.bot_hash}  ${c.note ?? ''}`);
      break;
    }
    case 'leaderboard': {
      const store = new ArenaStore(resultsDir);
      const rows = store.leaderboard(rulesetId);
      store.close();
      console.log('选手\t版本\t局数\t得分率\tK/D');
      for (const r of rows) console.log(`${r.label}\t${r.hash.slice(0, 8)}\t${r.matches}\t${(r.score * 100).toFixed(1)}%\t${(r.kills / Math.max(1, r.deaths)).toFixed(2)}`);
      break;
    }
    case 'replay-verify': {
      if (!specs.length) throw new Error('需要录像文件路径');
      let failed = 0;
      for (const file of specs) {
        const report = verifyReplay(JSON.parse(fs.readFileSync(file, 'utf8')));
        if (report.ok) console.log(`通过 ${file}：${report.ticks} Tick，${report.checkpoints} 个检查点，终态 ${report.finalHash}`);
        else { failed++; console.log(`失败 ${file}：第 ${report.firstMismatchTick} Tick 分叉（${report.reason}）`); }
      }
      process.exitCode = failed ? 1 : 0;
      break;
    }
    case 'ruleset': {
      const ruleset = getRuleset(rulesetId);
      console.log(`${ruleset.id}  ${rulesetHash(ruleset)}`);
      console.log(JSON.stringify(ruleset, null, 2));
      break;
    }
    default:
      throw new Error(`未知命令：${command}\n\n${HELP}`);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
