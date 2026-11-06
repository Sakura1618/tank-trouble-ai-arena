# 录像

录像只存比赛的原因：规则指纹、种子、参赛者、每 Tick 动作。回放时重新跑引擎，不需要脚本。一局 60 秒的比赛通常只有几 KB。

```json
{
  "format": "tank-arena-replay",
  "version": 1,
  "ruleset": { "id": "classic-v1", "hash": "6e4762b268e43d07" },
  "seed": 12345,
  "seeds": null,
  "maxSeconds": 60,
  "mapStyle": null,
  "seatRotation": 0,
  "entrants": [{ "id": "a", "name": "A", "color": "#123456", "sourceHash": "…", "label": null }],
  "actions": { "a": [4, 120, 5, 30] },
  "forfeits": [{ "tick": 30, "id": "a", "code": "script_error", "message": "…" }],
  "checkpoints": [{ "tick": 300, "hash": "…" }],
  "result": { "winnerId": "b", "reason": "survivor", "ticks": 912, "players": [] },
  "finalHash": "…"
}
```

- `actions`：每位选手的行程编码 `[值, 次数, 值, 次数, …]`。值 = `(move+1) + 3*(turn+1) + 9*fire + 18*special`。存的是归一化后的请求动作，控制门在回放时重新计算。
- `checkpoints`：每 300 Tick 一个状态哈希。
- `sourceHash`：脚本指纹，内容改一个字节就是另一个版本。

## 校验

```bash
node tournament/cli.js replay-verify results/某次运行/replays/00000-123.json
```

通过表示引擎逐位复现了原比赛。失败时报告分叉的 Tick 和原因：规则变了会直接拒绝，引擎或数学漂移会在第一个检查点暴露。

## 回放页

打开网站的“录像回放”（`viewer/replay.html`），选择或拖入录像文件；比赛结束弹窗里的“回放与诊断”可以直接打开刚打完的一局。

- 时间轴拖动、逐 Tick 前进后退、0.25×～4× 播放。空格播放，方向键单步。
- 运动诊断：每位选手一条轨道。蓝线是请求方向，绿线是实际方向；底部色条标出反向门拦截、撞墙修正、坦克互推。
- 指标表：请求反向频率、实际倒退频率、门限、撞墙、互推占比。

诊断回答的问题是“这次抖动是谁造成的”：蓝线频繁翻转说明是脚本决策；蓝线平稳但实际位移抖动说明是碰撞，那是引擎问题，应该开 issue。
