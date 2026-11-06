// 赛事工作线程：一次跑一整场比赛。脚本运行在线程内的 vm 上下文里。

import { parentPort, workerData } from 'node:worker_threads';
import { runMatch } from '../runtime/node-match.js';

const { sources } = workerData;

parentPort.on('message', task => {
  try {
    const entrants = task.lineup.map(e => ({ ...e, source: sources[e.key] }));
    const match = runMatch({ ruleset: task.ruleset, seed: task.seed, entrants, maxSeconds: task.maxSeconds, seatRotation: task.seatRotation });
    parentPort.postMessage({ index: task.index, ok: true, match });
  } catch (error) {
    parentPort.postMessage({ index: task.index, ok: false, error: String(error?.stack ?? error) });
  }
});
