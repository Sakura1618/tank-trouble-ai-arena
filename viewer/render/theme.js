// 渲染常量。这里的数值只影响画面，不影响比赛；比赛数值在 rulesets/。

export const TANK = {
  radius: 16,
  bodyLength: 26,
  bodyWidth: 20,
  treadLength: 34,
  treadWidth: 7,
  treadInset: 1,
  turretRadius: 8,
  barrelLength: 18,
  barrelWidth: 5,
};

export const WALL = { color: '#2b2b33', thickness: 5, borderThickness: 8, hp: 5 };
export const POWERUP = { mine: { blastRadius: 60 } };
export const POWERUP_BLINK_UNDER = 1.5;
export const LASER_BEAM_SECONDS = 0.25;

export const EXPLOSION = {
  duration: 0.9,
  shardCount: [6, 9],
  shardSpeed: [60, 200],
  shardSize: [5, 11],
  shardDrag: 3.0,
  shardSpin: 6,
  smokeCount: 3,
  smokeRadius: [12, 22],
  smokeGrow: 30,
  fadeStart: 0.45,
};

export const WALL_BREAK = {
  duration: 0.5,
  shardPerSeg: [5, 8],
  shardSpeed: [40, 140],
  shardSize: [3, 7],
  shardDrag: 4.0,
  shardSpin: 8,
  fadeStart: 0.4,
};

export const THEME = {
  pageBg: "#e8e8ec",
  arenaBg: "#dcdce2",
  arenaBorder: "#2b2b33",
  bullet: "#1a1a1a",
  textMain: "#2b2b33",
  textDim: "#9a9aa5",
  accent: "#2a5a8a",
  accentLight: "#4a7ab0",
  title: "#2b2b33",
  btnFill: "#ffffff",
  btnFillHover: "#2a5a8a",
  btnTextHover: "#ffffff",
  btnBorder: "#2b2b33",
  btnDisabledFill: "#ededf0",
  btnDisabledText: "#b8b8c0",
  btnDisabledBorder: "#d0d0d6",
  overlay: "rgba(232,232,236,0.82)",
  powScatterBg: "#e9a200",
  powShieldBg: "#2bb3c4",
  powLaserBg: "#d0353f",
  powIcon: "#ffffff",
  powRing: "#2b2b33",
  shieldRing: "#3ad4e8",
  laserBeam: "#e63946",
  laserPreview: "rgba(230,57,70,0.45)",
  powMineBg: "#5d6d7e",
  mineBody: "#3a3a4a",
  mineBlink: "#e63946",
  holdRing: "#2a5a8a",
  holdFill: "#1ba39c",
};
