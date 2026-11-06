# Tank Trouble AI Arena

[打开游戏](https://walkersifolia.github.io/tank-trouble-ai-arena/) · [下载 AI 开发包](https://walkersifolia.github.io/tank-trouble-ai-arena/AI_Starter_Kit.zip) · [下载 Windows 本地训练场](https://github.com/Walkersifolia/tank-trouble-ai-arena/releases/latest/download/AI_Training_Arena_Windows_x64.zip)

真人挑战 AI，或观看多个 AI 混战。物理与 AI 决策均在访客浏览器本地运行，不需要账号或实时游戏服务器。

- 电脑：W/S 前进倒车，A/D 转向，Space 开火，Shift 布雷，Esc 暂停。
- 手机：横屏，左摇杆控制前后与转向，右侧开火和特殊按钮。
- 自定义 AI：导入自包含的 CommonJS JavaScript 文件，仅在本机读取与执行。
- 网站选手按来源和代数排列，默认从新手对手开始。
- 玩法可选“有道具对战”或“纯走位开火 · 无道具”；两种玩法均关闭墙体破坏。
- 结果弹窗支持同种子重赛、回放与诊断、下载录像；大厅可以打开下载的 JSON 录像。

运动使用车身、炮管与厚墙的刚体接触，保留连续 `move/turn` 输入、无驾驶惯性和立即反向。前进153.12px/s、倒车122.88px/s、转速5rad/s；显示平滑独立于真实物理位置。正式单次 AI 决策预算仍为50ms。

同种子重赛复用地图、出生与独立随机序列；真人操作、按墙钟限时搜索及超时仍可能改变结果。回放读取当局实际状态，不重新运行 AI。诊断分别展示输入反向、实际运动反向与接触情况，不能仅凭低位移认定碰撞错误。

本次整合借鉴了 [Sakura1618 的 PR #1](https://github.com/Walkersifolia/tank-trouble-ai-arena/pull/1) 中的独立种子流、重赛和诊断思路，并接入现有运动、录像和发布结构。未采用输入数字化、反向停车门、放宽决策判负预算或整套平台重写。Planck 1.5.1 的 MIT 许可证随 `src/vendor/planck.LICENSE.txt` 发布。

开发包包含 API、示例与允许迭代的提示词。Windows x64 本地训练场包含运行环境，仅内置 Astra Gen1、ChatGPT Gen1，并支持将自己的历史版本添加为训练对手。

本仓库保存公开的静态发布文件，通过 `main` 分支根目录发布 GitHub Pages。训练场 ZIP 位于 Releases，避免把大型二进制文件写入 Git 历史。更新静态文件后推送 `main` 即会触发 Pages 更新。

网页维护默认直接更新 GitHub Pages；本地 5173 服务已关闭，不自动重新启动。只有用户明确要求本地预览时才启用本地服务。

MIT License，见 [LICENSE](LICENSE)。
