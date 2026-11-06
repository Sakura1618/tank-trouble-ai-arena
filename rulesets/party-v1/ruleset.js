// party-v1：娱乐规则。与 classic-v1 共用物理，打开道具、破墙和全部地图风格。
// 它不参与经典排名，是另一种独立的竞技模式。
import classic from '../classic-v1/ruleset.js';

export default {
  ...classic,
  id: 'party-v1',
  label: '派对',
  description: '在经典物理上加入道具、可破坏内墙与更多地图风格。',
  map: { ...classic.map, cols: 7, rows: 5, styles: ['sparse', 'symmetric', 'rooms'] },
  features: { powerups: ['scatter', 'shield', 'laser', 'mine'], wallBreak: true },
};
