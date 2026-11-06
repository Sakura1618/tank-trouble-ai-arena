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

本仓库同时管理公开网页和本地工具，通过 `main` 分支根目录发布 GitHub Pages。HTML、JS、CSS、`bots/` 和 `presets.json` 都直接在本仓库维护。训练场 ZIP 位于 Releases；更新网页文件后推送 `main` 即会触发 Pages 更新。

本地仓库位置为 `D:\Documents\ChatGPT\坦克动荡AI斗蛐蛐\tank-trouble\web-challenge`，目录内容与 GitHub 一致。仓库内部的 `web-challenge/` 保存页面脚本与样式；根目录的 `index.html` 是网站入口。以后直接在该仓库执行 `git pull`、修改、提交和推送，无需往返同步另一个发布目录。

本地工具要求 Node.js 20+。在仓库根目录运行：

```sh
npm install --omit=dev
npm run build
npm run preview
```

`build` 生成独立静态目录 `dist/`，同时更新根目录的 `AI_Starter_Kit.zip`；`preview` 提供本地预览，`dev` 监听源码并重新构建。GitHub Pages 继续发布根目录，`dist/` 不提交。只修改网页时可直接提交对应源码；开发包资料变动时运行 `npm run kit:package` 后一并提交 ZIP。

需要本地训练服务或 Windows 训练场打包时，先运行完整的 `npm install` 安装 Electron，再执行 `npm run training` 或 `npm run training:package`。训练包输出到 `training/dist/`，通过 Releases 上传。详见 [网页与发布说明](web-challenge/README.md)、[训练工具说明](training/README.md)。

网页维护默认直接更新 GitHub Pages；本地 5173 服务已关闭，不自动重新启动。只有用户明确要求本地预览时才启用本地服务。

MIT License，见 [LICENSE](LICENSE)。
