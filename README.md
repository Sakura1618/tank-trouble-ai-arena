# Tank Trouble AI Arena

[打开游戏](https://walkersifolia.github.io/tank-trouble-ai-arena/) · [下载 AI 开发包](https://walkersifolia.github.io/tank-trouble-ai-arena/AI_Starter_Kit.zip) · [录像回放](https://walkersifolia.github.io/tank-trouble-ai-arena/viewer/replay.html)

迷宫里的坦克对决：炮弹反弹，一发致命。真人挑战 AI，或者让多个 AI 混战。AI 是 LLM 写的 JavaScript / TypeScript 程序，比赛期间独立运行，不调用任何模型。

平台的目标是让胜负只反映策略水平：

- **确定性**：相同规则、种子、脚本得到逐位相同的比赛，包括脚本内部的 `Math.random` 和时钟。
- **可复现**：每局都有几 KB 的录像，脱离脚本重算并校验状态哈希。
- **可评测**：无头批量对战、Elo 与置信区间、战术和运动指标、SQLite 累计战绩。
- **可进化**：失败反馈、公开与留出种子、晋级门、历代冠军池。

## 上手

网页不需要安装，物理和 AI 都在访客浏览器本地运行。

- 电脑：W/S 前进倒车，A/D 转向，Space 开火，Esc 暂停。
- 手机：横屏，左摇杆控制前后与转向，右侧开火。
- 自定义 AI：导入自包含的 CommonJS JavaScript 文件，仅在本机读取与执行。
- 对局设置里可以填种子；比赛结束可以同种子重赛、下载录像、打开回放诊断。

批量对战需要 Node.js 22.13 以上，无第三方依赖：

```bash
node tournament/cli.js duel astra-basic scout --seeds 50
```

```bash
npm test
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 模块划分、Tick 流程、确定性来源、安全边界 |
| [docs/RULESET.md](docs/RULESET.md) | classic-v1 和 party-v1 的规则，还原范围 |
| [docs/MOTION.md](docs/MOTION.md) | 前后抽动的根因、反向门设计与实测 |
| [docs/TOURNAMENT.md](docs/TOURNAMENT.md) | 命令行、评分、LLM 迭代闭环、晋级门 |
| [docs/REPLAY.md](docs/REPLAY.md) | 录像格式、校验、回放诊断 |
| [bot-api/starter-kit/API.md](bot-api/starter-kit/API.md) | Bot API v2 权威说明 |

## 维护

本仓库保存公开的静态发布文件，通过 `main` 分支根目录发布 GitHub Pages，没有构建步骤。更新静态文件后推送 `main` 即会触发 Pages 更新。

网页维护默认直接更新 GitHub Pages；本地 5173 服务已关闭，不自动重新启动。只有用户明确要求本地预览时才启用本地服务。

修改 `bot-api/starter-kit/` 后运行 `npm run build:kit` 重新生成 `AI_Starter_Kit.zip`。

`classic-v1` 已冻结，`test/determinism.test.js` 里的基线哈希变化意味着旧录像失效。需要调整规则时新建规则集，不要改基线。

Windows x64 本地训练场在 Releases 单独发布，尚未迁移到这套规则，训练结果不能直接和网页比较。

MIT License，见 [LICENSE](LICENSE)。
