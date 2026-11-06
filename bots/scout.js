// 网页版原创公开示例，采用 AI_Starter_Kit 的同步 CommonJS 接口。
// 只演示迷宫寻路与方向控制，不代表高级选手的策略或难度。
let waypoint = null;
const angleDifference = angle => Math.atan2(Math.sin(angle), Math.cos(angle));

function nextWaypoint(state, target) {
  const { cols, rows, cellSize, cells } = state.map;
  const startX = Math.floor(state.self.x / cellSize), startY = Math.floor(state.self.y / cellSize);
  const endX = Math.floor(target.x / cellSize), endY = Math.floor(target.y / cellSize);
  const start = startY * cols + startX, end = endY * cols + endX;
  if (start === end) return { x: target.x, y: target.y };
  const previous = new Int32Array(cols * rows).fill(-1);
  const queue = [start];
  previous[start] = start;
  for (let head = 0; head < queue.length && previous[end] === -1; head++) {
    const cell = queue[head], x = cell % cols, y = Math.floor(cell / cols);
    for (const [dx, dy, wall] of [[0, -1, 'top'], [1, 0, 'right'], [0, 1, 'bottom'], [-1, 0, 'left']]) {
      const nx = x + dx, ny = y + dy, next = ny * cols + nx;
      if (nx >= 0 && nx < cols && ny >= 0 && ny < rows && !cells[y][x][wall] && previous[next] === -1) {
        previous[next] = cell;
        queue.push(next);
      }
    }
  }
  if (previous[end] === -1) return { x: target.x, y: target.y };
  let next = end;
  while (previous[next] !== start) next = previous[next];
  return { x: (next % cols + 0.5) * cellSize, y: (Math.floor(next / cols) + 0.5) * cellSize };
}

module.exports = {
  update(state) {
    const self = state.self;
    const enemies = state.enemies.filter(enemy => enemy.alive);
    if (!enemies.length) return { move: 0, turn: 0, fire: false, special: false };
    enemies.sort((a, b) => Math.hypot(a.x - self.x, a.y - self.y) - Math.hypot(b.x - self.x, b.y - self.y));
    const target = enemies[0];
    if (!waypoint || Math.hypot(waypoint.x - self.x, waypoint.y - self.y) < 14 || state.tick % 180 === 0) {
      waypoint = nextWaypoint(state, target);
    }
    const steer = angleDifference(Math.atan2(waypoint.y - self.y, waypoint.x - self.x) - self.angle);
    const aim = angleDifference(Math.atan2(target.y - self.y, target.x - self.x) - self.angle);
    return {
      move: Math.abs(steer) < 0.5 ? 1 : 0,
      turn: Math.max(-1, Math.min(1, steer / (state.physics.turnSpeed * state.dt))),
      fire: Math.abs(aim) < 0.14,
      special: false,
    };
  },
};
