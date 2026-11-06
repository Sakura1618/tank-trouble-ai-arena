// 并行执行赛程。完成顺序不确定，所以结果一律按比赛序号归位：
// 线程数不同、机器不同，得到的结果数组完全一样。

import os from 'node:os';
import { Worker } from 'node:worker_threads';

export function defaultWorkers() { return Math.max(1, os.availableParallelism() - 1); }

export function runMatches(tasks, { sources, workers = defaultWorkers(), onResult = () => {} }) {
  return new Promise((resolve, reject) => {
    const results = new Array(tasks.length);
    const size = Math.max(1, Math.min(workers, tasks.length));
    const pool = [];
    let next = 0;
    let done = 0;
    let settled = false;

    const stop = () => pool.forEach(w => w.terminate());
    const fail = error => {
      if (settled) return;
      settled = true;
      stop();
      reject(error);
    };
    const running = new Map();
    const feed = worker => {
      if (next >= tasks.length) return;
      running.set(worker, tasks[next]);
      worker.postMessage(tasks[next++]);
    };

    if (tasks.length === 0) { resolve(results); return; }
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL('./worker.js', import.meta.url), {
        workerData: { sources },
        resourceLimits: { maxOldGenerationSizeMb: 1024 },
        env: {},
      });
      pool.push(worker);
      worker.on('error', error => {
        const task = running.get(worker);
        const where = task ? `比赛 #${task.index}（${task.lineup.map(e => e.key).join(' vs ')}，种子 ${task.seed}）` : '工作线程';
        fail(new Error(`${where} 崩溃：${error.message}`));
      });
      worker.on('message', message => {
        if (!message.ok) { fail(new Error(`比赛 #${message.index} 崩溃：${message.error}`)); return; }
        results[message.index] = message.match;
        done++;
        onResult(done, tasks.length, tasks[message.index], message.match);
        if (done === tasks.length) {
          settled = true;
          stop();
          resolve(results);
        } else feed(worker);
      });
      feed(worker);
    }
  });
}
