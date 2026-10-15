'use strict';
/* 关卡调试：逐关生成地图并打印行宽问题（Lead 使用） */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const PHYSICS = require(path.join(root, 'js', 'physics.js'));
const { LEVELS_1_6 } = require(path.join(root, 'js', 'levels.js'));
let L7 = [];
try { L7 = require(path.join(root, 'js', 'levels7-12.js')).LEVELS_7_12 || []; } catch (e) { /* 还没交 */ }
const ALL = LEVELS_1_6.concat(L7).sort((a, b) => a.id - b.id);

for (const lv of ALL) {
  let problems = [];
  lv.map.forEach((row, i) => { if (row.length !== 32) problems.push(`r${i}:${row.length}`); });
  console.log(`\n===== 关 ${lv.id} ${lv.name}  行数=${lv.map.length} =====`);
  if (problems.length) console.log('!! 行宽异常: ' + problems.join(' '));
  lv.map.forEach((row, i) => { console.log(String(i).padStart(2) + ' |' + row + '|'); });
  try {
    const L = PHYSICS.compileLevel(lv);
    console.log(`  -> 星 ${L.stars.length} 刺 ${L.spikes.length} 锯 ${L.saws.length} 出生(${L.spawn.col},${L.spawn.row}) 出口(${L.exit.col},${L.exit.row})`);
  } catch (e) {
    console.log('  -> 编译失败: ' + e.message);
  }
}
