// Bot API v2 类型定义。TS 脚本在比赛前编译成单文件 JS，比赛期间只执行 JS。

export type Axis = -1 | 0 | 1;

export interface Action {
  /** 1 前进，-1 倒车，0 停车。旧脚本的小数按四舍五入归入三档。 */
  move?: Axis | number;
  /** 1 顺时针，-1 逆时针，0 不转。 */
  turn?: Axis | number;
  fire?: boolean;
  special?: boolean;
}

export interface Vector { x: number; y: number }

export interface TankView {
  id: string;
  name: string;
  color: string;
  alive: boolean;
  x: number;
  y: number;
  /** [0, 2π)，0 向右，正方向顺时针。 */
  angle: number;
  /** 上一 Tick 的实际位移 / dt，含碰撞修正，不是指令速度。 */
  vx: number;
  vy: number;
  cooldown: number;
  deployCooldown: number;
  bulletsActive: number;
  scatterShots: number;
  laserShots: number;
  mineCharges: number;
  mineHoldTime: number;
  shield: boolean;
  shieldTime: number;
}

/** 只有自己的 TankView 带这些诊断字段，需要声明 apiVersion: 2。 */
export interface SelfView extends TankView {
  requestedMove: Axis;
  requestedTurn: Axis;
  appliedMove: Axis;
  appliedTurn: Axis;
  /** 最近一秒内请求方向翻转的次数。 */
  actionFlipCount: number;
  actualDelta: Vector;
  wallCorrection: Vector;
  tankCorrection: Vector;
}

export interface Wall { x1: number; y1: number; x2: number; y2: number; border: boolean; hp: number | null }
export interface Cell { top: boolean; right: boolean; bottom: boolean; left: boolean }

export interface MapView {
  cols: number;
  rows: number;
  cellSize: number;
  style: string;
  width: number;
  height: number;
  cells: Cell[][];
  walls: Wall[];
}

export interface BulletView { id: number; ownerId: string; x: number; y: number; vx: number; vy: number; age: number; bounces: number; kind: string }
export interface PowerupView { x: number; y: number; type: 'scatter' | 'shield' | 'laser' | 'mine' }
export interface MineView { id: number; ownerId: string; x: number; y: number; age: number; armed: boolean; visibility: number }

export interface Rules {
  ruleset: string;
  timeout: number;
  wallBreak: boolean;
  powerups: boolean;
  controls: 'digital';
}

export interface Physics {
  tankRadius: number;
  moveSpeed: number;
  turnSpeed: number;
  bulletRadius: number;
  bulletSpeed: number;
  bulletLifetime: number;
  fireCooldown: number;
  maxBullets: number;
  selfHitGrace: number;
  wallHp: number;
  muzzleOffset: number;
  powerupRadius: number;
  reverseDwellTicks: number;
  turnDwellTicks: number;
  [key: string]: unknown;
}

export interface State {
  apiVersion: number;
  tick: number;
  time: number;
  dt: number;
  self: SelfView;
  enemies: TankView[];
  bullets: BulletView[];
  powerups: PowerupView[];
  mines: MineView[];
  /** 局内共享，不要修改。 */
  map: MapView;
  rules: Rules;
  physics: Physics;
  mapRevision: number;
}

export interface InitContext {
  apiVersion: number;
  selfId: string;
  playerCount: number;
  map: MapView;
  rules: Rules;
  physics: Physics;
}

export interface Bot {
  /** 声明 2 才会收到诊断字段。 */
  apiVersion?: 2;
  init?(context: InitContext): void;
  update(state: State): Action;
}
