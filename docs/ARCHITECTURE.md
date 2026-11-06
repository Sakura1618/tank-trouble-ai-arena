# 架构

平台分成互不依赖内部实现的几层。升级物理不需要改 Bot，升级 Bot API 不需要改规则，增加竞技模式不会碰经典规则。

```text
rulesets/    冻结的规则数据（classic-v1、party-v1）
engine/      纯模拟内核：无 DOM、无时钟、无全局随机数，浏览器和 Node 共用
runtime/     Bot 执行：bot-host 是唯一的宿主实现，注入 Worker 或 Node vm
replay/      录像格式、回放会话、逐位校验
tournament/  无头赛事：赛程、并行池、评分、SQLite、晋级门、反馈
viewer/      网页：大厅、实时观战、回放与运动诊断
bot-api/     Starter Kit 源文件和类型定义
benchmarks/  固定种子集
bots/        内置选手
test/        回归测试
```

## 依赖方向

```text
viewer ─┐
        ├─> runtime ─> engine <─ rulesets
tournament ┘            ^
                        │
                     replay
```

`engine/` 不知道 Bot、录像和页面的存在。渲染只读帧快照（`viewer/render/frame.js`），无法反过来影响比赛。

## 一个 Tick

1. 所有存活选手读取同一时刻的观测，各自决策。
2. 全部返回后，故障选手统一判负。
3. `world.step(actions)`：动作归档 → 控制门 → 转向移动 → 撞墙解算 → 坦克互推 → 道具 → 地雷 → 开火 → 炮弹运动与反弹 → 命中结算。
4. 整个 Tick 结束后判胜负。

## 确定性从哪里来

| 不确定来源 | 处理 |
| --- | --- |
| `Math.random` | 引擎用 `engine/rng.js` 的独立种子流；脚本的 `Math.random` 被替换成由比赛种子决定的序列 |
| 墙钟 | 脚本的 `Date`、`performance.now` 返回模拟时间 |
| `Math.sin/cos/hypot` | 规范不保证跨引擎一致，引擎用 `engine/detmath.js`，只含 IEEE-754 严格定义的运算 |
| 选手顺序 | 席位由种子决定，与调用方传入的顺序无关 |
| 并行完成顺序 | 结果按比赛序号归位，评分用与顺序无关的拟合 |
| 超时判负 | 决策耗时只统计；只有 250 ms 无响应才判负，并写入录像 |
| 跨环境浮点传递 | 观测和动作都走 JSON，浏览器与 Node 完全同路 |

已实测：同一场比赛在 Node 和 Chrome 的 iframe + Worker 沙箱中终态哈希相同。Firefox、Safari 未实测，引擎内没有依赖实现定义行为的运算，但脚本自己调用的 `Math.sin` 等函数在不同浏览器上仍可能不同，所以录像回放（不重跑脚本）是跨引擎的，脚本重跑只保证同一 JS 引擎内一致。

唯一仍受墙钟影响的是 250 ms 卡死判负，它只在脚本真的卡死或机器严重过载时触发，一旦发生会写入录像，回放仍然逐位一致。

## 安全边界

- 浏览器：每个选手一个不透明来源 iframe 内的 Worker，CSP 禁止网络。这是面向不可信脚本的隔离。
- Node：vm 上下文 + worker_threads。vm 不是安全边界，只运行你信任的脚本。输入输出都是 JSON 字符串，不向上下文传递宿主对象。
