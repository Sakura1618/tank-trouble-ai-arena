# Tank Trouble AI Arena

[打开网页竞技场](https://walkersifolia.github.io/tank-trouble-ai-arena/) · [AI 开发包](https://walkersifolia.github.io/tank-trouble-ai-arena/AI_Starter_Kit.zip) · [Windows 训练工具](https://github.com/Walkersifolia/tank-trouble-ai-arena/releases/latest/download/AI_Training_Arena_Windows_x64.zip)

Web 是唯一维护的游戏版本。真人挑战、多人 AI 混战、连续比赛、回放与诊断都使用同一套 `src/arena` 引擎。比赛在浏览器运行，无需账号或游戏服务器。原 Electron 游戏入口永久退役；Electron 仅作为独立黑盒训练服务的运行环境保留。

本机唯一维护工作区为 `D:\Documents\ChatGPT\tank-trouble-ai-arena`，远端为 `Walkersifolia/tank-trouble-ai-arena`。原 `D:\Documents\ChatGPT\坦克动荡AI斗蛐蛐\tank-trouble` 只保留本地神谕实验、历史数据及其冻结依赖，不再作为网页开发或发布源，不再双向同步。

## 使用

- 电脑：W/S 前进倒车，A/D 转向，Space 开火，Shift 布雷，Esc 暂停；手机使用触控。
- 自定义 AI：导入单文件 CommonJS 脚本，只在浏览器内执行，源码不上传。
- 有道具与无道具玩法均不破坏墙体，正式决策预算始终为 50 ms。
- 同种子重赛固定地图、出生与随机流；墙钟预算、设备负载和真人输入仍会影响结果。
- 回放读取真实状态，支持逐帧、时间轴、运动/接触诊断及下载；录像不包含脚本源码。

## 维护与发布

根目录 `index.html` 是唯一游戏入口，`presets.json` 是公开选手清单，`bots/` 保存独立脚本，`web-challenge/` 保存界面与浏览器协调逻辑，`src/` 保存共享规则。Astra Gen3 和 Opus 原版保留。

提交并推送 `main` 后，沿用 GitHub Pages 的 **main / 根目录** 与自动 **pages-build-deployment** 工作流发布。仓库文件本身即网站源文件，`.nojekyll` 保留。已删除本地 `build.mjs`、`serve.mjs` 和 `dev/build/preview` 包装命令；无需生成或同步第二份 `dist`，也不额外启动本地预览服务。

开发包资料改变时运行 `npm run kit:package`，将生成的 `AI_Starter_Kit.zip` 和资料一并提交。Windows 训练包仍通过 `npm run training:package` 生成并上传 Releases；大 ZIP 不提交到 Git。

Node.js 20+ 可运行无界面批量对战。使用与网页相同的 `ArenaWorld`、公开观测及 50 ms 决策预算，见 [PROTEUS 评测说明](research/proteus/README.md)。本地训练服务使用 `npm run training`，说明见 [training/README.md](training/README.md)。这些是策略开发工具，不是第二个游戏版本。

神谕 ORACLE 的源码、模型、训练数据、导出、日志与状态只留在原本地目录，未纳入本仓库。其训练方案与运行进程保持原安排。DeepSeek Gen5「导师」保留为本地评测对照，通过评测命令显式指定路径。

[网页操作与发布说明](web-challenge/README.md) · [无相策略、对战结果和限制](research/proteus/README.md)

引擎源于 [AbyssWhalen/tank-trouble](https://github.com/AbyssWhalen/tank-trouble)，MIT 许可证见 [LICENSE](LICENSE)。Opus 来自 [Sakura1618 的 PR #2](https://github.com/Walkersifolia/tank-trouble-ai-arena/pull/2)；无相的代码来源说明随独立脚本保留。Planck 的许可证见 `src/vendor/planck.LICENSE.txt`。
