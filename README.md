# Tank Trouble AI Arena

[打开游戏](https://walkersifolia.github.io/tank-trouble-ai-arena/) · [下载 AI 开发包](https://walkersifolia.github.io/tank-trouble-ai-arena/AI_Starter_Kit.zip) · [下载 Windows 本地训练场](https://github.com/Walkersifolia/tank-trouble-ai-arena/releases/latest/download/AI_Training_Arena_Windows_x64.zip)

真人挑战 AI，或观看多个 AI 混战。物理与 AI 决策均在访客浏览器本地运行，不需要账号或实时游戏服务器。

- 电脑：W/S 前进倒车，A/D 转向，Space 开火，Shift 布雷，Esc 暂停。
- 手机：横屏，左摇杆控制前后与转向，右侧开火和特殊按钮。
- 自定义 AI：导入自包含的 CommonJS JavaScript 文件，仅在本机读取与执行。
- 网站选手按来源和代数排列，默认从新手对手开始。

开发包包含 API、示例与允许迭代的提示词。Windows x64 本地训练场包含运行环境，仅内置 Astra Gen1、ChatGPT Gen1，并支持将自己的历史版本添加为训练对手。

本仓库保存公开的静态发布文件，通过 `main` 分支根目录发布 GitHub Pages。训练场 ZIP 位于 Releases，避免把大型二进制文件写入 Git 历史。更新静态文件后推送 `main` 即会触发 Pages 更新。

网页维护默认直接更新 GitHub Pages；本地 5173 服务已关闭，不自动重新启动。只有用户明确要求本地预览时才启用本地服务。

MIT License，见 [LICENSE](LICENSE)。
