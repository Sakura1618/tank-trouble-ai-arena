# Tank Trouble AI Arena 网页挑战版

网页与 Electron 竞技场共用物理、地图、武器和 AI 观察接口。每位访客在自己的浏览器运行整局游戏；网站只分发静态文件，不承担游戏计算，无需账号、数据库、实时游戏服务器、WebSocket 或大模型 API。

## 默认发布方式

网页正式入口为 [GitHub Pages](https://walkersifolia.github.io/tank-trouble-ai-arena/)。网页、选手和本地工具都在同一仓库维护，修改后提交并推送 `main`，通过 GitHub Pages 交付。

本地仓库根目录是 `D:\Documents\ChatGPT\坦克动荡AI斗蛐蛐\tank-trouble\web-challenge`，与 GitHub 的目录结构一致。根目录保存 `index.html`、`presets.json`、`bots/`、`src/`；内部的 `web-challenge/` 保存界面脚本、样式和本地构建工具。

`presets.json` 是公开选手的唯一清单，脚本直接存放在 `bots/`。合并 GitHub PR 后执行 `git pull` 即可取得最新代码；本地构建读取这份清单，不再维护 `public-roster.json` 或另一份发布目录。

不自动启动或保留 `npm run dev`、`npm run preview` 或其他 5173 预览服务；只有用户明确要求本地预览时才启动。具体发布目录、Release 下载链接与更新步骤见下方“GitHub Pages”一节。

## 本地启动（仅在明确要求预览时使用）

安装 Node.js 20 或更新版本，在 PowerShell 中进入**项目根目录**：

```powershell
cd 'D:\Documents\ChatGPT\坦克动荡AI斗蛐蛐\tank-trouble\web-challenge'
npm run dev
```

用 Chrome 或 Edge 打开 <http://localhost:5173>。开发命令构建网页并监听源文件变化；修改后刷新浏览器即可。全新克隆后，网页开发先运行 `npm install --omit=dev` 安装打包依赖；需要训练服务或完整 Windows 训练包时运行 `npm install`，同时安装 Electron。不要双击 HTML 以 `file://` 方式打开。

## 开始对战

1. 默认从新手对手“哨兵”开始，也可选择其他网站 AI，或者点“导入 AI”选择本机 `.js` / `.cjs` 文件。
2. 选择“真人 VS AI”，设置自己的名字、颜色和比赛规则，确认参赛席位后进入战场。
3. 选择“AI VS AI”可让多个 AI 自由混战；真人模式最多一名真人，也可同时启用多个 AI。网站选手从阵容的固定下拉列表添加，名称固定；仅本地导入的 JS 选手可以编辑名字。颜色、启用状态和控制者可以调整。
4. 结束后可再次挑战或更换对手。默认随机迷宫、60 秒时限；玩法可选“有道具对战”（默认）或“纯走位开火 · 无道具”，两种玩法均不破坏墙体。无道具玩法仅有普通反弹炮弹，不生成散射、激光、地雷或护盾道具。

结束弹窗现在提供“换图再来”“同种子重赛”“回放与诊断”“下载录像”。同种子重赛保留阵容、规则、地图、出生及独立随机流；每位 AI 的 `Math.random` 从同一席位种子重新开始。仍使用实际时钟和正式50ms决策预算，因此真人操作、按时间限额搜索和超时判负可能改变结果；道具落点也会受当局占位/拾取影响，不保证重赛全过程相同。

回放读取当局已记录的60Hz状态，不重新运行AI或物理。可播放、暂停、逐Tick前后、拖动时间轴、调倍速和选择坦克；诊断并列显示连续指令、真实位移/转角、实际速度、接触及最近1秒反向次数。接触与低位移同时发生并不能单独证明碰撞故障，回放也不记录屏幕刷新停顿。下载的JSON不含AI源码；刷新后可从大厅“打开录像”重新查看。详细状态沿用现有64MiB估算上限，达到上限会提示可回放截止时间，全局摘要仍记录整局。

电脑版使用以下操作，移动、转向与射击可以同时进行：

当前共享运动核心按原版前后速度比例设置：前进 153.12 px/s、倒车 122.88 px/s，原地转向 5 rad/s；没有驾驶惯性，松开移动键即可停止主动平移，也可边走边转。车身、履带外轮廓及炮管会与有厚度的墙面接触，贴墙与拐角会影响实际转向。画面在真实物理姿态之间插值，AI 观测仍取真实位置；显示平滑不会延迟输入或强制保持动作。

| 操作 | 按键 |
| --- | --- |
| 前进 / 倒车 | W / S，或 ↑ / ↓ |
| 左转 / 右转，包括原地转向 | A / D，或 ← / → |
| 持续开火 | 按住 Space |
| 特殊操作 / 布雷 | Shift |
| 暂停 | Esc，或画面上的暂停按钮 |

手机推荐横屏。左摇杆的**纵轴控制前进、倒车，横轴控制转向**，不会自动朝某个方向行驶；左右拖动可原地旋转，斜向拖动可倒车同时转向。右侧大按钮可持续按住开火，小按钮使用特殊操作。支持左手摇杆与右手开火同时触摸；松手、触控中断或切到后台会清除持续输入。发射频率由原有武器规则决定。

点击“全屏”可请求全屏与横屏。浏览器或系统不支持方向锁定时，需要手动旋转手机、关闭系统竖屏锁定。手机通常自动显示触控区，也可在设置中打开“显示触控”。

## 用手机访问同一局域网

电脑和手机连接同一个局域网，在项目根目录运行：

```powershell
npm run dev -- --host 0.0.0.0
ipconfig
```

找到电脑当前网卡的 IPv4 地址，例如 `192.168.1.23`，在手机浏览器打开 `http://192.168.1.23:5173`。手机不能使用电脑的 `localhost`。如 Windows 防火墙弹出提示，仅允许当前可信的专用网络；不需要开启路由器 DMZ。此命令用于本地开发，公网分享使用下方正式构建与 HTTPS 方法。

## 自定义 AI 与高级预设

首页“AI 开发包”和阵容区域“下载开发工具包 ZIP”均可下载 `AI_Starter_Kit.zip`。解压后包含完整 API、开发指南、可改造的 `bot.js`、两个控制示例、示例状态、现有接口检查器及重新编写的 `prompt.md`。可将提示词连同解压目录交给编程 AI；当前规则允许实际对战后迭代、修改并重新导入。

`npm run build` 会将 `training/starter-kit` 中的工具包打包到仓库根目录 `AI_Starter_Kit.zip`，再复制进 `dist`；单独更新压缩包可以运行 `npm run kit:package`。修改开发包资料后，将资料和根目录 ZIP 一并提交，GitHub Pages 直接使用根目录文件。

### 完整本地黑盒训练场下载

开发包旁边提供 `AI_Training_Arena_Windows_x64.zip`，约 102.6 MiB，解压约 231.1 MiB。它包含运行环境、训练服务、CLI、详细中文手册和独立训练提示词；朋友在 Windows x64 电脑解压后双击“启动训练场.cmd”，无需安装 Node.js，也不使用网站主机的训练服务。手机仍使用网页对战。

训练包仅内置 **Astra Gen1、ChatGPT Gen1**，不包含其他高级选手。支持 `trainer.cmd opponent-add` 登记自己的历史版本，然后与旧版对战、分析日志、修改并继续训练。配置和令牌由每份解压后的包自行生成；打包时不读取主机的私人配置、令牌、历史训练数据或排行榜。

生成或更新训练包：

```powershell
npm run training:package
npm run build
```

第一条命令输出 `training/dist/AI_Training_Arena_Windows_x64.zip`，用于上传 GitHub Release；第二条生成网页 `dist`，下载链接仍指向 Release。训练包打包源与说明位于 `training/portable`，打包脚本位于 `training/scripts`。网页构建不生成或复制大型训练 ZIP。修改训练代码、陪练或训练包资料后，执行 `training:package` 并上传新的 Release 资产。

打包只保留 Electron 的中文、英文语言资源，以及原训练服务、必要引擎模块、日志压缩依赖和两个授权陪练；不复制整个项目或整个 `node_modules`。两个 ZIP 的下载不影响浏览器本地对战方式。

导入文件沿用 `training/starter-kit` 开发包的同步 CommonJS 接口，例如：

```javascript
module.exports = {
  update(state) {
    return { move: 1, turn: 0, fire: true, special: false };
  },
};
```

`move`、`turn` 接受 `[-1, 1]`；`fire`、`special` 为布尔值。正向移动为前进，正向转动为右转。完整观察数据和玩法请参阅 [开发包](../training/starter-kit/README.md)及 [training/API.md](../training/API.md)。脚本应为自包含的同步 JavaScript，不依赖 Node.js、Electron、DOM、网络或外部模块；不能使用 `require()` 加载依赖或返回 Promise。

每个席位有独立脚本实例；同一局的模块变量及对象状态会保留，每局重新执行脚本初始化。文件选择器在电脑与手机均可用。导入内容只保存在当前页面内存，刷新后需要重新导入，不上传服务器，也不写入战绩存储。

预设选手的显示配置在根目录 `presets.json`。当前共 14 名公开选手：3 名新手练习对手、Astra Basic 与 Gen1/2/3、ChatGPT Gen1、DeepSeek Basic 与 Gen1/2/3/4、Opus Gen1「先机」。网站按新手练习、Astra、ChatGPT、DeepSeek、Opus 分组，每组一行；阵营组内 Basic 在前，再按 Gen1/2/3/4 排列，配置使用 `group` 与 `order` 表示分组和顺序。

新手练习由低到高为“哨兵”“莽夫”“巡游者”，默认选择哨兵。哨兵站桩、缓慢瞄准且低频开火；莽夫简单追人、低频射击，撞墙后短暂倒车转向；巡游者会沿迷宫通路寻找对手。新手行为由各自脚本决定，没有修改游戏物理。全部公开选手脚本位于根目录 `bots/`，保留原版算法。

今后新增选手也必须获得明确公开发布授权后，才可将脚本加入 `bots/` 并在 `presets.json` 添加对应条目，`script` 指向 `./bots/选手ID.js`。新增阵营时也要更新 `web-challenge/app.js` 中的 `GROUPS`。构建按清单取文件，不扫描或公开其他本地目录。

提交并推送这些文件后，GitHub Pages 更新，朋友即可选择并挑战上述网站选手，无需本地导入。其他脚本仍可由拥有相应文件的玩家自行在本地导入。任何公开仓库内的脚本都可能被访客查看或下载，不能把网页发布当成源码保密措施。

## 构建与静态托管

在项目根目录运行：

```powershell
npm run build
```

独立静态产物位于仓库根目录 **`dist/`**。使用以下命令在 Windows 本机托管正式产物：

```powershell
npm run preview -- --host 0.0.0.0 --port 5173
```

电脑访问 <http://localhost:5173>，同一局域网手机访问 `http://电脑IPv4地址:5173`。保持该终端运行即可提供文件；Node.js 在这里仅是静态文件服务器，不运行对局。也可用 Nginx、Caddy 或其他静态服务器把网站根目录指向 `dist/`。

自行托管时只上传或暴露 `dist` 的内容。GitHub Pages 沿用 `main` 分支根目录发布；仓库中的工具源码也属于公开内容。训练数据、日志、`node_modules`、本机令牌和配置由 `.gitignore` 排除。导入的用户脚本不属于构建输入。

### Cloudflare Pages：无需常开电脑

完整训练 ZIP 通过 GitHub Releases 下载，不包含在 `dist` 中。网页与小开发包可以作为静态目录部署。

1. 运行 `npm run build`。
2. 在 Cloudflare 控制台选择 Workers & Pages，创建 Pages 项目并选择 Direct Upload。
3. 上传 `dist` 文件夹或仅包含其内容的 ZIP，完成部署。
4. 将 Cloudflare 提供的 `https://…pages.dev` 地址发给朋友；也可在控制台绑定自己的域名。

参见 [Cloudflare Pages Direct Upload 官方说明](https://developers.cloudflare.com/pages/get-started/direct-upload/)。网页部署后不需要本地电脑在线，访客设备各自运行游戏。

### Windows 主机临时公网分享

先按上面的 `preview` 命令启动静态服务，再在安装了 `cloudflared` 的另一个终端运行：

```powershell
cloudflared tunnel --url http://localhost:5173
```

将命令输出的 HTTPS 地址分享给朋友。此临时 Tunnel 地址不是固定的长期网址；需保持电脑、静态服务与 Tunnel 运行。长期使用应配置 Cloudflare 的命名 Tunnel 和自己的域名，参见 [Cloudflare Tunnel 官方入门](https://developers.cloudflare.com/tunnel/get-started/)。这两种方式均不要求路由器开放 DMZ。

### GitHub Pages：同一仓库维护和发布

公开仓库是 [Walkersifolia/tank-trouble-ai-arena](https://github.com/Walkersifolia/tank-trouble-ai-arena)，从 `main` 分支根目录发布。根目录文件就是网站使用的文件，`npm run build` 另生成用于本地预览或其他静态托管的 `dist/`。

日常更新：在仓库内执行 `git pull`，修改页面、引擎、选手或说明，然后提交并推送 `main`。不再复制到另一份发布仓库。开发包资料修改后，先执行 `npm run kit:package`，将根目录 `AI_Starter_Kit.zip` 一起提交。

`dist/`、`node_modules/`、训练结果、令牌和本机配置不提交。新增公开选手直接修改 `bots/` 和 `presets.json`。GitHub 上的 PR 修改同一批文件，拉取后即可继续维护。

更新完整训练包时，在 Windows x64 上执行 `npm install` 和 `npm run training:package`，将 `training/dist/AI_Training_Arena_Windows_x64.zip` 上传到 GitHub Release。保留首页的 `releases/latest/download/AI_Training_Arena_Windows_x64.zip` 下载链接；大型 ZIP 不作为普通 Git 文件提交。

## 更新与战绩

修改网页或清单中已授权 AI 后，提交并推送即可更新 GitHub Pages。自行静态托管时运行 `npm run build` 并部署新的 `dist`；玩家刷新网页加载更新。朋友自行导入的 AI 需要在本地重新选择更新后的文件。

网页战绩只记录在当前站点、当前浏览器的 LocalStorage，包括挑战、胜负、最佳连胜及各对手记录，不写入 Electron 排行榜。首页可以重置。更换浏览器、清理站点数据、改变网站域名或端口后，不会自动迁移原战绩。隐私模式或禁用站点存储时，记录可能无法保留。

## 运行机制与限制

- 物理始终以固定 `1/60` 秒推进，渲染与物理分离；没有根据帧率改变移动速度、弹速或碰撞。较慢设备会显示模拟速度下降，比赛时间相应放慢，不跳过物理 Tick。
- AI 在不透明来源的 sandbox iframe 所创建的独立 Worker 中运行，借助 CSP 禁止网络连接，不能直接读取主页面 DOM、Cookie 或 LocalStorage。各席位通过独立消息通道收发数据。
- 单次同步决策预算为 50 ms；执行已开始但 250 ms 未返回的实例会被终止，脚本初始化与排队等待上限为 2 秒。预算测量和设备排队/无响应会显示不同提示；浏览器没有线程 CPU 时钟，操作系统抢占仍可能影响决策计时。
- 外部脚本异常或超时会使该选手本局判负，其余选手继续。此方案不是操作系统级硬内存隔离；浏览器仍共享整台设备资源，恶意大量分配内存可能导致标签页被浏览器终止。
- 所有资源与参赛脚本加载后，对局不依赖实时网络。首次打开网页及重新加载仍需获取静态文件；本版本不提供可安装 PWA 或保证离线刷新。
- 暂不支持真人远程联机、云端账号、跨设备战绩同步或全球排行榜。手机实机兼容性与具体浏览器实测结果以本次交付说明为准，本文不代替实机验证记录。

## 迁移前的运行记录（2026-11-06）

- `npm run build` 成功；内置浏览器通过静态 HTTP 目录加载完整网页并开始真人对战。
- `Astra-g3-imperator.js` 当时通过本地导入实测，成功初始化、移动、射击并完成比赛；后续经用户授权加入公开构建。
- 浏览器按住 A 可原地旋转；同时按住 S、D、Space 可倒车、转向并射击；Esc 可暂停。
- 浏览器视口模拟为 844×390，横屏战场、摇杆、射击按钮和本地文件导入可用。
- 对真实控制模块做内存事件模拟：摇杆、开火、特殊三指同时输入、独立释放、移出释放、pointercancel、lostpointercapture 与失焦清理均通过。这是动作接口模拟，不等同真机多点触控。
- 在浏览器导入主动抛异常及无限循环的脚本：两名故障选手被淘汰，其余两名继续，页面仍可暂停和返回。
- 关闭静态服务器后，在已加载的页面启动 Astra Gen3 与基础 AI 的纯 AI 对战并完成结算，验证运行时不需要服务器。
- 网页战绩在首页独立累计；网页模块没有调用 Electron 排行榜接口。

真实 Android/iOS 多点触控、系统文件选择器和全屏方向锁定仍需实机验证；内置浏览器尺寸模拟不代替这些操作。后续已完成 GitHub Pages 公网发布及训练包 Release 上传，GitHub 确认首个构建成功；没有追加线上对战测试或全项目测试。
