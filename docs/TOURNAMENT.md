# 竞技与迭代

需要 Node.js 22.13 以上，无第三方依赖。比赛期间不调用任何 LLM。

## 跑比赛

选手可以是 `presets.json` 里的 ID，也可以是文件路径，支持 `.js` 和 `.ts`。

```bash
node tournament/cli.js duel astra-basic scout --seeds 50
```

```bash
node tournament/cli.js round-robin --pool reference --seeds 30
```

```bash
node tournament/cli.js melee astra-basic scout rusher sentry --seeds 20
```

| 命令 | 用途 |
| --- | --- |
| `duel A B` | 1v1，每个种子换边各打一局，抵消出生点优势 |
| `mirror A` | 自己打自己，检查稳定性和席位偏差 |
| `melee A B C ...` | 多方混战，每个种子轮换全部席位 |
| `gauntlet A --pool P` | 连续挑战对手池 |
| `round-robin --pool P` | 循环赛，完整排名 |
| `benchmark A --pool P` | 在固定基准集上做版本回归 |
| `gate A --champion B` | 晋级判定 |
| `feedback A B` | 输出给 LLM 的失败报告 |
| `champion` / `leaderboard` | 历代冠军、累计战绩 |
| `replay-verify 文件...` | 重算录像，比对状态哈希 |

产物写到 `results/<运行 ID>/`：`report.md`、`summary.json`、`matches.jsonl`、`replays/`。累计数据在 `results/arena.sqlite`。`results/` 不进 Git。

## 怎么读结果

- **得分率**：胜 1、平 0.5、负 0。混战按名次归一化。
- **Elo**：对全部结果做 Bradley–Terry 拟合后换算到 Elo 刻度。不用逐场更新：逐场 Elo 依赖比赛顺序，并行赛程下不可复现。区间按“同图换边”分组重采样。
- **APS**：对手的平均得分，用来分辨“赢得多”和“对手弱”。
- **请求反向 / 实际倒退**：前者是脚本想反向的次数，后者是车真的倒退的次数。两者差距大说明脚本在抖，被反向门拦下了。

不要只看 Elo。一个专门克制某种简单对手的版本可能分数很高。同时看基准对手、历代冠军和镜像赛。

20 个种子的结果置信区间很宽，下结论前看 95% 区间是否跨过 50%。

## 迭代闭环

```text
LLM 写脚本 → feedback 跑对局并输出失败原因和录像
          → LLM 修改脚本 → gate 判定 → 晋级或淘汰
```

```bash
node tournament/cli.js feedback my-bot.js astra-basic --seeds 30
```

`feedback.md` 列出失败原因分布、运动诊断和可回放的失败样本，不含对手源码。录像用网页的“录像回放”打开，可以逐 Tick 查看和诊断。

```bash
node tournament/cli.js gate my-bot-v2.js --champion my-bot-v1.js --pool reference
```

晋级门分三步，任何一步失败都淘汰：

1. **公开种子**：`classic-v1/public` 100 个种子换边，得分率超过 50%。
2. **留出种子**：200 个私有种子，95% 下限超过 50%。
3. **基准回归**：对基准对手的得分率不低于现任超过 3 个百分点。

留出种子由 `results/.holdout-salt` 派生，文件不进 Git，日常调参看不到，用来发现对公开地图的过拟合。团队共享时用环境变量 `ARENA_HOLDOUT_SALT` 指定同一个盐。

晋级后源码快照保存到 `results/champions/`，之后可以用 `--pool champions` 把历代冠军当对手。

100～200 局是筛选规模，不是统计保证。两个版本实力接近时，门会倾向于淘汰候选版本，这是有意的：宁可少升级，也不要让噪声进冠军名单。

## TypeScript

单文件 TS 用 Node 内置的类型擦除直接参赛。使用 `import` 的多文件工程需要安装 esbuild，平台会打包成单文件。比赛时不下载依赖、不联网。类型定义在 `bot-api/starter-kit/bot-api.d.ts`。

## 运行时间

决策耗时决定一切。复杂 Bot 单局可能要几十秒 CPU 时间，赛事按 CPU 核心并行，默认保留一个核心。
