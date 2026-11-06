import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageAIKit } from '../training/scripts/package-ai-kit.mjs';
export { kitFiles } from '../training/scripts/package-ai-kit.mjs';

export const webDir = dirname(fileURLToPath(import.meta.url));
export const projectDir = resolve(webDir, '..');
export const distDir = resolve(projectDir, 'dist');

// 固定发布清单：不递归复制源码、参赛目录或桌面版数据。
export const publicFiles = [
  'web-challenge/app.js', 'web-challenge/runtime.js', 'web-challenge/controls.js', 'web-challenge/style.css', 'web-challenge/arena.svg',
  'web-challenge/replay-panel.js', 'web-challenge/replay-panel.css',
  'src/arena/world.js', 'src/arena/observation.js', 'src/arena/sandbox.js', 'src/arena/render.js',
  'src/arena/recording.js', 'src/arena/replay.js', 'src/rng.js',
  'src/config.js', 'src/tank.js', 'src/bullet.js', 'src/mine.js', 'src/powerup.js',
  'src/tank-motion.js', 'src/tank-pose.js', 'src/vendor/planck.mjs', 'src/vendor/planck.LICENSE.txt',
  'src/laser.js', 'src/effects.js', 'src/collision.js', 'src/maze.js', 'src/upgrades.js', 'LICENSE',
];

export async function build() {
  const presets = JSON.parse(await readFile(resolve(projectDir, 'presets.json'), 'utf8'));
  const kitArchive = await packageAIKit();
  // 构建目录固定在仓库根目录下；清理旧产物使已移出清单的脚本不再残留。
  if (relative(projectDir, distDir) !== 'dist') throw new Error('构建输出目录必须是仓库根目录下的 dist。');
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });
  for (const file of ['index.html', 'presets.json', '.nojekyll']) {
    await copyFile(resolve(projectDir, file), resolve(distDir, file));
  }
  await copyFile(kitArchive, resolve(distDir, 'AI_Starter_Kit.zip'));
  for (const file of publicFiles) {
    const target = resolve(distDir, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(resolve(projectDir, file), target);
  }
  // presets.json 是公开选手的唯一清单，不扫描或发布训练目录中的其他脚本。
  for (const entry of presets) {
    const { id } = entry;
    if (entry.script) {
      if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`公开选手 ID 不合法：${id}`);
      const source = resolve(projectDir, entry.script);
      const sourceRelative = relative(projectDir, source);
      if (sourceRelative === '..' || sourceRelative.startsWith(`..${sep}`) || isAbsolute(sourceRelative)) {
        throw new Error(`公开选手脚本必须位于项目内：${id}`);
      }
      const target = resolve(distDir, sourceRelative);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
  }
  console.log(`网页构建完成：${distDir}\n已打包清单中的 ${presets.filter(p => p.script).length} 名公开 AI。`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build().catch(error => { console.error(`构建失败：${error.message}`); process.exitCode = 1; });
}
