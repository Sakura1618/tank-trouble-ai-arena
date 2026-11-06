import { ArenaWorld } from '../engine/world.js';
import { getRuleset } from '../rulesets/index.js';

export const classic = getRuleset('classic-v1');
export const party = getRuleset('party-v1');
export const DT = 1 / classic.tickRate;

export function wall(x1, y1, x2, y2, border = false) {
  return { x1, y1, x2, y2, border, hp: border ? undefined : 5 };
}

// 封闭矩形外框，便于构造可手算的物理场景。
export function box(width, height) {
  return [
    wall(0, 0, width, 0, true), wall(width, 0, width, height, true),
    wall(width, height, 0, height, true), wall(0, height, 0, 0, true),
  ];
}

export function entrants(count = 2) {
  return Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: `P${i}`, color: '#336699' }));
}

// 用真实世界对象跑手工场景：替换地图和坦克位置，其余结算与正式比赛一致。
export function arena({ walls, tanks, ruleset = classic }) {
  const world = new ArenaWorld(entrants(tanks.length), { ruleset, seed: 1 });
  world.maze.walls = walls;
  tanks.forEach((spec, i) => {
    const actor = world.byId.get(`p${i}`);
    Object.assign(actor.tank, spec);
  });
  return world;
}

export function idle(world) {
  return Object.fromEntries(world.actors.map(p => [p.id, { move: 0, turn: 0, fire: false, special: false }]));
}

export function stepWith(world, overrides) {
  return world.step({ ...idle(world), ...overrides });
}
