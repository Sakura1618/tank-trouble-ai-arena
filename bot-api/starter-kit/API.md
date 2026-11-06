# AI 控制接口 v2

本文定义竞技场实际使用的公开协议。无引擎依赖；`example_state.json` 展示完整字段。例图为方便阅读的 4×3 小地图，实际比赛会使用更大的地图，算法须读取尺寸。

v2 是 v1 的超集，v1 脚本无需修改即可运行。声明 `apiVersion: 2` 后可以使用 `init` 回调和运动诊断字段。`bot-api.d.ts` 是 TypeScript 类型定义。

## 确定性

比赛结果只由规则集、种子和脚本源码决定。为此运行环境做了三件事：

- `Math.random()` 可以调用，但序列由比赛种子决定，同一场比赛每次相同。
- `Date` 和 `performance.now()` 返回模拟时间，与 `state.time` 一致，一个 Tick 内不变。用它们测量自己的计算耗时只会得到 0。
- 不要依赖真实时间决定算多少。需要控制计算量时，用固定的迭代上限。

## 入口、生命周期与返回值

```js
let steps = 0; // 同一局保留；每一局重新初始化
module.exports = {
  update(state) {
    steps++;
    return { move: 1, turn: 0, fire: state.self.cooldown === 0, special: false };
  }
};
```

v2 脚本的完整形态：

```js
module.exports = {
  apiVersion: 2,
  init(context) {            // 每局一次，在第一个 Tick 之前；可以省略
    this.memory = { lastSeen: null };
  },
  update(state) {
    return { move: 1, turn: 0, fire: false, special: false };
  },
};
```

`context` 含 `apiVersion`、`selfId`、`playerCount`、`map`、`rules`、`physics`。`init` 和 `update` 的 `this` 都是导出对象，可以把局内记忆放在 `this` 上。

只能同步返回普通动作对象，不能返回 Promise、null、数组。使用 CommonJS 风格 `module.exports`；这只是导出约定，**没有 Node.js 的 require、process、fs 或包加载器**。不支持 ESM `export`、静态/动态 import、异步任务及多文件依赖。可以写辅助函数、类及顶层变量。函数内 `this` 绑定导出对象。

每局重新创建执行环境并求值整个文件；每个存活选手每个固定 Tick 调用一次。第一 Tick 为 0。结束时销毁，没有 `onEnd` 回调。暂停期间不推进物理；暂停前已发出的调用允许完成，但动作等继续后才应用。停止时不应用尚未完成的 Tick。

单次决策目标预算为 **50 ms**，超出只记入统计（`overBudget`），不影响比赛：墙钟受设备负载影响，用它判负会让同一场比赛在不同机器上结果不同。

单次调用超过 **250 ms** 仍未返回视为卡死，终止并判负，判负写入录像。排队/启动等待上限和脚本初始化执行上限各为 **2000 ms**。建议常规决策仅用数毫秒，以维持实际模拟速度。

超时、语法/入口错误、异常及非法动作均只淘汰该选手并销毁其 Worker，其余选手继续；下一局自动重建所有选手 Worker。1v1 的剩余有效选手获胜；同 Tick 多个选手故障，全部处理后才判断胜负；全员故障则全员计负。故障者在其余人打平时仍计负。不存在通过计算超时取消本局、规避败场的机制。

排行榜以全部参赛局为胜率分母。故障淘汰不增加任何人的击杀。

没有强制的每选手内存硬上限；32 MiB 是建议用量，不是硬配额。不要依赖 Node、DOM、网络、文件、计时器、子 Worker、共享消息频道等外部能力。

## 动作

| 字段 | 合法值 | 缺省值（或 null） | 效果 |
|---|---|---|---|
| `move` | [-1, 1] 内有限 number | 0 | 1 前进，-1 倒车，0 停车。按键盘语义归入三档，见下文 |
| `turn` | [-1, 1] 内有限 number | 0 | 1 顺时针，-1 逆时针，0 不转。归档规则相同 |
| `fire` | boolean | false | true 时每 Tick 尝试射击，受冷却及普通弹在场上限约束 |
| `special` | boolean | false | true 时尝试在车尾布雷，必须持雷且部署冷却结束 |

四个动作可以同时执行。先旋转，再沿**旋转后的朝向**移动，随后处理射击/布雷。移动不带惯性；令 `move=0` 即停止主动平移，车辆接触仍可能将它推开。

**数字控制。** 操控是键盘语义，只有全速和停止。`|值| ≥ 0.5` 取 ±1，否则取 0。转速每 Tick 约 0.05 弧度，所以朝向精度就是半步：比例控制器 `clamp(误差 / (turnSpeed*dt))` 在目标附近会自然落入 0 档。

**反向门。** 沿某方向行驶后，必须静止满 `physics.reverseDwellTicks` 个 Tick 才能朝相反方向行驶；转向同理，用 `physics.turnDwellTicks`。被拦下的 Tick 坦克静止或不转，不会继续朝旧方向走。停车、同向行驶、静止够久后的起步永远立即生效。所以每 Tick 翻转 `move` 的结果是原地不动，不是抖动闪避。`fire=true` 持续输出可自动连续开火，失败的射击尝试不会消耗弹药。未知输出字段忽略，不能通过返回 `x`、`alive` 等修改实体。非法类型、NaN/Infinity、超范围数值会导致该选手本局判负并报错，不自动裁剪数值；其他选手继续比赛。

## 输入根对象

| 字段 | 类型 | 含义 |
|---|---|---|
| `apiVersion` | number | 恒为 1 |
| `tick` | integer | 当前局已完成的物理 Tick 数，从 0 开始 |
| `time` | number | `tick / 60`，已过去的模拟秒数 |
| `dt` | number | 恒为 `1 / 60` 秒，与渲染或加速无关 |
| `self` | TankView | 自己的坦克 |
| `enemies` | TankView[] | 其他所有选手，包括已死亡者；按 `alive` 过滤目标 |
| `map` | MapView | 完整公开迷宫 |
| `bullets` | BulletView[] | 当前所有在场炮弹，含自己的 |
| `powerups` | PowerupView[] | 当前未拾取的道具 |
| `mines` | MineView[] | 当前仍可见的地雷；完全隐形的雷不再提供 |
| `rules` | object | 当前局规则集、开关与时限 |
| `physics` | object | 当前公开物理常量，见后文 |
| `mapRevision` | integer | 地图版本，破墙后递增 |

所有选手使用相同权限：本版本是**全地图公开视野，无墙后战争迷雾**；坦克、子弹、墙与地面道具对所有人可见；已经隐形的雷对包括主人在内的所有人不可见，可以根据自己的历史观测记忆。对手的武器弹数/冷却也属于本竞技场的公开规则。输入不含源码、控制器状态、未来弹道、随机种子、下一局地图、最终胜者或调度器对象。

修改收到的对象只影响自己的本地副本，不会修改引擎或其他选手。动态字段每 Tick 是新副本，不要用对象引用判断实体身份。`map`、`rules`、`physics` 在局内共用同一份对象，地图变化时才更新，不要修改它们。

## 坐标和 TankView

左上角为 (0,0)，x 向右，y 向下；位置及距离为逻辑像素，速度为像素/秒，时间为秒。`angle` 为 [0,2π) 弧度，0 向右，π/2 向下，正方向顺时针。场地缩放不改变任何输入数值。

| 字段 | 类型 | 含义 |
|---|---|---|
| `id`, `name`, `color` | string | 选手唯一 ID、自定义名称、`#RRGGBB` 色值 |
| `alive` | boolean | 是否存活 |
| `x`, `y`, `angle` | number | 车体中心与朝向 |
| `vx`, `vy` | number | 上一 Tick 实际位移 / dt，含碰撞修正；出生为 0。不是指令速度，贴墙或被推时数值会跳变，不要直接当速度反馈使用 |
| `cooldown` | number | 射击冷却剩余秒数，下限 0 |
| `deployCooldown` | number | 布雷冷却剩余秒数，下限 0 |
| `bulletsActive` | integer | 本车尚在场的弹体数量，含散射弹 |
| `scatterShots`, `laserShots`, `mineCharges` | integer | 剩余散射次数、激光次数、可部署地雷数 |
| `mineHoldTime` | number | 持雷剩余时间；无存货时忽略 |
| `shield` | boolean | 是否持有护盾 |
| `shieldTime` | number | 护盾剩余时间；shield=false 时忽略 |

声明 `apiVersion: 2` 后，`self`（只有自己）多出运动诊断字段，用来区分“我想动”和“我实际动了”：

| 字段 | 含义 |
|---|---|
| `requestedMove`, `requestedTurn` | 上一 Tick 请求的方向（归档后） |
| `appliedMove`, `appliedTurn` | 上一 Tick 实际执行的方向；与请求不同说明被反向门拦下 |
| `actionFlipCount` | 最近一秒内 `move` 请求翻转的次数 |
| `actualDelta` | 上一 Tick 实际位移 `{x, y}` |
| `wallCorrection` | 上一 Tick 被墙修正的位移 `{x, y}` |
| `tankCorrection` | 上一 Tick 被其他坦克推开的位移 `{x, y}` |

死亡坦克不移动、不再调用 AI、无车体碰撞；其已发射子弹/地雷继续生效。已经死亡的射手仍可获后续击杀。无生命条：无盾时一次有效命中即死亡。

## MapView

- `cols`, `rows`：格子列数与行数；`cellSize`：96；`width=cols*cellSize`，`height=rows*cellSize`；`style`：地图风格。
- 参赛人数无固定上限。令开局人数为 N，`classic-v1` 下 `cols=ceil(9*sqrt(N/2))`、`rows=ceil(7*sqrt(N/2))`，`party-v1` 的基准是 7×5。布局由种子决定，局中尺寸固定。请读取输入尺寸，勿写死地图大小或 `enemies` 长度。
- `cells[r][c]`：`{top,right,bottom,left}`，四个布尔值表示该格四条边是否有墙，true 有墙；相邻格共享边状态。可据此自行实现图搜索。
- `walls`：线段数组，每条 `{x1,y1,x2,y2,border,hp}`。墙是横平竖直的零厚度碰撞线段；显示厚度不加入物理。`border` 是外边界，外墙不可破坏且 `hp=null`；内墙当前剩余耐久为数值。
- 坦克按半径 16 的圆与墙解算，会被推离墙面，允许沿墙滑动；坦克之间按两个圆分离。过拐角要考虑车体半径，不能只看格子连通。
- 开启破坏时，每次炮弹撞内墙减 1 耐久（初始 5），同 Tick 弹体更新后移除归零内墙，同时更新 `cells`。地雷可炸掉范围内内墙。`wallBreak=false` 时墙永不破坏。

## 弹体、道具、地雷、规则

`BulletView = { id, ownerId, x, y, vx, vy, age, bounces, kind }`：id 是局内递增整数；ownerId 是射手选手 ID；age 是已存活秒数；bounces 是累计反弹次数；kind 为 `bullet` 或 `scatter`。速度长度为 180。反弹按镜面反射：垂直墙翻转 vx，水平墙翻转 vy；角落可能同时反射。无反弹次数上限，10 秒后消失。碰撞按半径 3 的弹体圆与半径 16 的车体圆判定，不区分敌我。一枚弹体命中任意坦克或护盾后消失。

普通弹发射后，**只有未反弹且 age < 0.25 秒时**不会伤及发射者；只要反弹就立即解除该豁免。贴墙乱开炮会自杀。出膛位置沿朝向距车心通常为 36 像素；若车心到炮口之间有墙，则压回墙前 `bulletRadius+1` 像素，防止隔墙发射。

`classic-v1` 没有道具和地雷，墙不可破坏，下面三节只适用于 `party-v1`。

`PowerupView = { x, y, type }`，type 为 `scatter | laser | mine | shield`。道具每隔 6～10 秒尝试刷新，场上最多 2 个；位置和下次刷新计时不公开。坦克圆与半径 16 道具圆接触即拾取。武器槽（散射/激光/地雷）互斥，拾取另一武器会清空旧武器存货，同类拾取叠加。盾独立并存。

- **散射**：一次拾取增加 3 次射击；每次 3 弹，角度为车头方向 -0.26、0、+0.26 弧度。散射射击不受普通弹 5 发在场上限约束。每次射击消耗一次存货。
- **激光**：一次拾取增加 1 发；瞬时射线，最长 960 像素、最多反弹 4 次；沿路径遇到的第一个活坦克吸收整束，包括护盾。第一段忽略射手，反弹段可自伤。激光不在 `bullets` 中，可根据对手的 `laserShots`、位置/朝向和墙自行预测。没有单独“瞄准线”私有对象。
- **地雷**：一次拾取增加 2 枚；`special=true` 在车尾距车心 29 像素处放置（贴墙时推回合法位置），部署冷却 0.25 秒。持雷超过 10 秒不部署则失效，每次部署重新起算持雷时间。不影响普通开火。地雷落地 1 秒后布防，任意活坦克中心距雷小于 40 像素触发，中心距雷小于 60 像素的所有活坦克受伤，包括主人；护盾抵挡一次。爆炸无视墙遮挡，可破坏时炸掉半径 60 内内墙。
- **护盾**：持续 5 秒，挡一次伤害后消失，拾取刷新而不叠加层数。

`MineView = { id, ownerId, x, y, age, armed, visibility }`：visibility 为 [0,1] 显示强度。布防前 0.45，布防后 2 秒为 0.95，再用 1 秒渐隐，到 0 后从公开数组移除；消失不等于已爆炸。地雷仍可被历史观测记忆。

`rules = { ruleset, timeout, wallBreak, powerups, controls }`：ruleset 是规则集 ID，timeout 是本局最大模拟秒数，controls 恒为 `digital`。完全无未来状态。

## physics 常量表

| 字段 | 当前数值 | 单位/含义 |
|---|---|---|
| tankRadius / moveSpeed / turnSpeed | 16 / 120 / 3 | 像素 / 像素每秒 / 弧度每秒 |
| bulletRadius / bulletSpeed / bulletLifetime | 3 / 180 / 10 | 像素 / 像素每秒 / 秒 |
| fireCooldown / maxBullets / selfHitGrace | 0.15 / 5 / 0.25 | 秒 / 普通弹在场上限 / 秒 |
| wallHp / muzzleOffset / powerupRadius | 5 / 36 / 16 | 内墙初始耐久 / 常规出膛偏移 / 拾取半径 |
| scatter | `{pellets:3,spreadAngle:0.26,shots:3}` | 每次弹数 / 相邻弹角度 / 拾取存货 |
| laser | `{shots:1,maxBounces:4,maxLength:960}` | 拾取存货 / 反弹上限 / 总长 |
| mine | `{charges:2,armDelay:1,triggerRadius:40,blastRadius:60,wallBlastRadius:60,visibleTime:2,fadeTime:1,holdTimeout:10,discRadius:9,deployCooldown:0.25}` | 上节描述的公开地雷参数 |
| shieldDuration | 5 | 秒 |
| reverseDwellTicks / turnDwellTicks | 8 / 4 | Tick，反向门的静止要求 |

普通弹上限按自己所有在场弹体计数（包含此前散射留下的弹体），仅限制普通单发；激光和散射绕过此上限，但仍受 0.15 秒射击冷却。冷却在 Tick 的移动阶段扣减，因此输入为一个很小的正数也可能在当前 Tick 射击成功。

## 每 Tick 顺序与公平性

1. 向全部存活选手发送同一时刻观测并等待全部动作或独立执行保护返回。统一淘汰本批次故障选手；若仅剩一人或无人存活，直接结算，否则继续本 Tick。
2. 所有车冷却递减、转向、移动，随后进行车车分离。
3. 道具刷新和拾取，地雷更新和爆炸。
4. 依本局席位顺序（由种子决定）处理射击（包括瞬时激光）和布雷。
5. 全部炮弹运动及反弹、移除破损墙、处理弹体命中。
6. 完整 Tick 结束后判断胜负/超时，并结算一次。

瞬时激光等同 Tick 冲突沿用此顺序，因此不承诺绝对同时击中；席位由种子决定，避免某个固定 ID 永远优先。所有参赛脚本享有同样的公开状态、动作和时间预算。运行时不接受截图/模拟按键控制，也不提供对手源码或游戏未来状态。
