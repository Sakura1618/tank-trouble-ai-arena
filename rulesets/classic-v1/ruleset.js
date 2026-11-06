// classic-v1：冻结的竞技规则。发布后不再修改；要调整数值就新建 classic-v2。
// 改动这里的任何值都会改变 rulesetHash，旧录像会在校验时明确报错。
export default {
  id: 'classic-v1',
  version: 1,
  label: '经典',
  description: '迷宫、反弹炮弹、一发致命；无道具，墙不可破坏。',
  tickRate: 60,
  maxSeconds: 60,
  map: {
    cols: 9,
    rows: 7,
    cellSize: 96,
    styles: ['sparse'],
    density: { sparse: 0.28, symmetric: 0.3 },
    rooms: { roomMin: 2, roomMax: 3, extraDoorChance: 0.5 },
    minDensity: 0.05,
    regenerateTries: 12,
    scaleWithPlayers: true,
  },
  tank: {
    radius: 16,
    moveSpeed: 120,
    turnSpeed: 3,
    muzzleOffset: 36,
  },
  bullet: {
    radius: 3,
    speed: 180,
    lifetime: 10,
    cooldown: 0.15,
    maxAlive: 5,
    selfHitGrace: 0.25,
  },
  // 操控保持键盘语义：恒速、原地转向、无加速度。
  // 反向门只限制“紧贴上次行驶方向的立刻反向”，详见 docs/MOTION.md。
  controls: {
    mode: 'digital',
    reverseDwellTicks: 8,
    turnDwellTicks: 4,
  },
  features: {
    powerups: [],
    wallBreak: false,
  },
  wall: { hp: 5 },
  powerup: {
    spawnInterval: [6, 10],
    maxOnField: 2,
    radius: 16,
    scatter: { shots: 3, pellets: 3, spreadAngle: 0.26 },
    shield: { duration: 5 },
    laser: { shots: 1, maxBounces: 4, maxLength: 960 },
    mine: {
      charges: 2, armDelay: 1, triggerRadius: 40, blastRadius: 60, discRadius: 9,
      visibleTime: 2, fadeTime: 1, holdTimeout: 10, wallBlastRadius: 60, deployCooldown: 0.25,
    },
  },
  // 墙钟无法确定性地测量，因此 decisionMs 只统计不判负；hardMs 只拦截卡死的脚本。
  budget: { decisionMs: 50, hardMs: 250, initMs: 2000 },
};
