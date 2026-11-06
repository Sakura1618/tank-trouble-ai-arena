// 选手解析：预设 ID 或文件路径 → 单文件 JS。TS 在比赛前编译，比赛期间只执行 JS。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashHex } from '../engine/rng.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PALETTE = ['#1ba39c', '#e63946', '#e9a200', '#7c4dff', '#3f8f2e', '#b0338a', '#2a5a8a', '#d1495b'];

export function loadPresets() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'presets.json'), 'utf8'));
}

// 单文件 TS 用 Node 内置类型擦除；带 import 的多文件工程需要安装 esbuild 打包。
export async function compileBot(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (!/\.m?ts$/i.test(file)) return text;
  if (/^\s*import\s/m.test(text)) {
    let esbuild;
    try { esbuild = await import('esbuild'); } catch {
      throw new Error(`${file} 使用了 import，需要先安装 esbuild（npm i -D esbuild）才能打包成单文件`);
    }
    const built = await esbuild.build({ entryPoints: [file], bundle: true, write: false, format: 'cjs', platform: 'neutral', target: 'es2022' });
    return built.outputFiles[0].text;
  }
  const { stripTypeScriptTypes } = await import('node:module');
  return stripTypeScriptTypes(text, { mode: 'transform' });
}

export async function resolveBot(spec, presets = loadPresets()) {
  const preset = presets.find(p => p.id === spec);
  const file = preset ? path.join(ROOT, preset.script) : path.resolve(spec);
  if (!fs.existsSync(file)) throw new Error(`找不到选手：${spec}（可用预设：${presets.map(p => p.id).join('、')}）`);
  const source = await compileBot(file);
  const hash = hashHex(source);
  const id = preset?.id ?? path.basename(file).replace(/\.(c|m)?[jt]s$/i, '');
  return { id, name: preset?.name ?? id, color: preset?.color ?? null, file, source, hash };
}

export async function resolvePool(spec, presets = loadPresets()) {
  const groups = {
    all: presets,
    baseline: presets.filter(p => p.group === 'training'),
    reference: presets.filter(p => ['astra-basic', 'scout', 'rusher', 'sentry'].includes(p.id)),
  };
  const ids = groups[spec]?.map(p => p.id) ?? spec.split(',').map(s => s.trim()).filter(Boolean);
  return Promise.all(ids.map(id => resolveBot(id, presets)));
}

// 赛程和席位都以 id 区分选手。v1/bot.js 和 v2/bot.js 文件名相同，必须在这里分开，
// 否则两边会共用一份源码，等于自己打自己。
export function prepareBots(bots) {
  return bots.map((bot, i) => {
    const twins = bots.filter(other => other.id === bot.id);
    if (new Set(twins.map(other => other.hash)).size !== twins.length) {
      throw new Error(`${bot.id} 重复出现且源码相同；同一份脚本自我对战请用 mirror`);
    }
    const id = twins.length > 1 ? `${bot.id}@${bot.hash.slice(0, 8)}` : bot.id;
    return { ...bot, id, name: twins.length > 1 ? id : bot.name, color: bot.color ?? PALETTE[i % PALETTE.length] };
  });
}
