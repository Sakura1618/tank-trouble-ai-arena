import { hashHex } from '../engine/rng.js';
import classicV1 from './classic-v1/ruleset.js';
import partyV1 from './party-v1/ruleset.js';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function rulesetHash(ruleset) { return hashHex(canonical(ruleset)); }

export const RULESETS = deepFreeze({ 'classic-v1': classicV1, 'party-v1': partyV1 });
export const DEFAULT_RULESET = 'classic-v1';

export function getRuleset(id = DEFAULT_RULESET) {
  const ruleset = RULESETS[id];
  if (!ruleset) throw new Error(`未知规则集：${id}（可用：${Object.keys(RULESETS).join('、')}）`);
  return ruleset;
}
