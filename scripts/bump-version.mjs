// @ts-check
/**
 * 版本號遞增：x.y.z，z 每次 +1；z 超過 30 歸零、y +1；y 超過 20 歸零、x +1。
 * 同步更新根目錄、server、client 的 package.json 與 package-lock.json。
 * 用法：npm run version:bump
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {string} v
 * @returns {string}
 */
export function nextVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`版本格式錯誤：${v}`);
  let x = Number(m[1]);
  let y = Number(m[2]);
  let z = Number(m[3]) + 1;
  if (z > 30) { z = 0; y += 1; }
  if (y > 20) { y = 0; x += 1; }
  return `${x}.${y}.${z}`;
}

/** @type {string} */
const current = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const next = nextVersion(current);

for (const dir of ['', 'server', 'client']) {
  for (const file of ['package.json', 'package-lock.json']) {
    const p = resolve(root, dir, file);
    if (!existsSync(p)) continue;
    /** @type {{ version?: string, packages?: Record<string, { version?: string }> }} */
    const json = JSON.parse(readFileSync(p, 'utf8'));
    json.version = next;
    if (json.packages && json.packages['']) json.packages[''].version = next;
    writeFileSync(p, JSON.stringify(json, null, 2) + '\n', 'utf8');
  }
}
console.log(`版本：${current} → ${next}`);
