// SQLite 持久层：跨次运行保留选手版本、比赛结果和历代冠军。录像仍是独立文件。

import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bots (
  hash TEXT PRIMARY KEY, label TEXT NOT NULL, file TEXT, first_seen TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, mode TEXT NOT NULL, ruleset TEXT NOT NULL, ruleset_hash TEXT NOT NULL,
  seed_label TEXT, match_count INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
  run_id TEXT NOT NULL, idx INTEGER NOT NULL, seed INTEGER NOT NULL, seat_rotation INTEGER NOT NULL,
  ticks INTEGER NOT NULL, reason TEXT NOT NULL, winner TEXT, final_hash TEXT NOT NULL, replay TEXT,
  PRIMARY KEY (run_id, idx)
);
CREATE TABLE IF NOT EXISTS participants (
  run_id TEXT NOT NULL, idx INTEGER NOT NULL, actor TEXT NOT NULL, bot_hash TEXT NOT NULL, label TEXT NOT NULL,
  score REAL NOT NULL, kills INTEGER NOT NULL, deaths INTEGER NOT NULL, suicides INTEGER NOT NULL,
  ticks_alive INTEGER NOT NULL, flips INTEGER NOT NULL, reversals INTEGER NOT NULL,
  PRIMARY KEY (run_id, idx, actor)
);
CREATE INDEX IF NOT EXISTS participants_bot ON participants (bot_hash);
CREATE TABLE IF NOT EXISTS champions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ruleset TEXT NOT NULL, bot_hash TEXT NOT NULL, label TEXT NOT NULL,
  file TEXT, promoted_at TEXT NOT NULL, run_id TEXT, note TEXT
);
`;

export class ArenaStore {
  constructor(resultsDir) {
    fs.mkdirSync(resultsDir, { recursive: true });
    // node:sqlite 在部分 22.x 上仍打印实验性警告，这里只屏蔽这一条。
    const emit = process.emitWarning;
    process.emitWarning = (warning, ...rest) => {
      if (String(warning).includes('SQLite')) return;
      emit.call(process, warning, ...rest);
    };
    const { DatabaseSync } = require('node:sqlite');
    process.emitWarning = emit;
    this.db = new DatabaseSync(path.join(resultsDir, 'arena.sqlite'));
    this.db.exec(SCHEMA);
  }

  saveRun({ id, config, bots, tasks, matches, scoresOf, replayPaths }) {
    const now = new Date().toISOString();
    const db = this.db;
    db.exec('BEGIN');
    try {
      const addBot = db.prepare('INSERT OR IGNORE INTO bots (hash, label, file, first_seen) VALUES (?, ?, ?, ?)');
      for (const bot of bots) addBot.run(bot.hash, bot.id, bot.file ?? null, now);
      db.prepare('INSERT OR REPLACE INTO runs (id, mode, ruleset, ruleset_hash, seed_label, match_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, config.mode, config.ruleset, config.rulesetHash, config.seedLabel, matches.length, now);
      const addMatch = db.prepare('INSERT OR REPLACE INTO matches (run_id, idx, seed, seat_rotation, ticks, reason, winner, final_hash, replay) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const addPlayer = db.prepare('INSERT OR REPLACE INTO participants (run_id, idx, actor, bot_hash, label, score, kills, deaths, suicides, ticks_alive, flips, reversals) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      matches.forEach((match, i) => {
        addMatch.run(id, i, match.replay.seed, match.replay.seatRotation, match.result.ticks, match.result.reason,
          match.result.winnerId, match.replay.finalHash, replayPaths[i] ?? null);
        const scores = scoresOf(match);
        for (const entrant of tasks[i].lineup) {
          const s = match.stats[entrant.id];
          addPlayer.run(id, i, entrant.id, entrant.sourceHash, entrant.key, scores[entrant.id], s.kills, s.deaths, s.suicides, s.ticksAlive, s.requestedFlips, s.actualReversals);
        }
      });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  promote({ ruleset, bot, runId, note }) {
    this.db.prepare('INSERT INTO champions (ruleset, bot_hash, label, file, promoted_at, run_id, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(ruleset, bot.hash, bot.id, bot.file ?? null, new Date().toISOString(), runId, note ?? null);
  }

  currentChampion(ruleset) {
    return this.db.prepare('SELECT * FROM champions WHERE ruleset = ? ORDER BY id DESC LIMIT 1').get(ruleset) ?? null;
  }

  champions(ruleset) {
    return this.db.prepare('SELECT * FROM champions WHERE ruleset = ? ORDER BY id').all(ruleset);
  }

  // 累计战绩按源码哈希区分版本：改一个字节就是新选手，历史不混算。
  leaderboard(ruleset) {
    return this.db.prepare(`
      SELECT p.label, p.bot_hash AS hash, COUNT(*) AS matches, AVG(p.score) AS score,
             SUM(p.kills) AS kills, SUM(p.deaths) AS deaths
      FROM participants p JOIN runs r ON r.id = p.run_id
      WHERE r.ruleset = ?
      GROUP BY p.bot_hash ORDER BY score DESC, matches DESC
    `).all(ruleset);
  }

  close() { this.db.close(); }
}
