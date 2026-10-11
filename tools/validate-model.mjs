import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const data = JSON.parse(await readFile(new URL('../public/data/palace.json', import.meta.url), 'utf8'));
const finitePair = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const ids = new Set();
assert.equal(data.metadata.boundaryId, 9511883, '必须采用故宫宫界');
assert(data.boundary.length >= 4 && data.boundary.every(finitePair), '宫界有效');
for (const b of data.buildings) {
  assert(!ids.has(b.id), `重复ID ${b.id}`); ids.add(b.id);
  assert(b.footprint.length >= 3 && b.footprint.every(finitePair), `轮廓无效 ${b.id}`);
  const area = Math.abs(b.footprint.reduce((sum, p, i, points) => { const next = points[(i + 1) % points.length]; return sum + p[0] * next[1] - next[0] * p[1]; }, 0)) / 2;
  assert(area > 0.1, `轮廓面积无效 ${b.id}`);
  assert(finitePair(b.center), `中心无效 ${b.id}`);
  assert([b.width, b.depth, b.height, b.roofHeight, b.angle].every(Number.isFinite), `数值无效 ${b.id}`);
  assert(b.width > 0 && b.width < 1100 && b.depth > 0 && b.depth < 1100, `尺寸异常 ${b.id}`);
  assert(b.height > 0 && b.height < 80 && b.roofHeight >= 0 && b.roofHeight < b.height, `高度异常 ${b.id}`);
  assert(['hipped', 'gabled', 'half-hipped', 'pyramidal', 'round', 'flat', 'luding'].includes(b.roofKind), `屋顶形制无效 ${b.id}`);
  assert(['documented', 'mapped', 'estimated'].includes(b.confidence), `可信度缺失 ${b.id}`);
  assert(/^https:\/\//.test(b.source), `来源缺失 ${b.id}`);
}
for (const name of ['taihe', 'zhonghe', 'baohe', 'wumen', 'shenwumen', 'qianqing', 'jiaotai', 'kunning', 'yuhuayuan', 'ningshou', 'cining']) assert(data.buildings.some((b) => b.landmark === name), `缺少地标 ${name}`);
assert.equal(data.buildings.filter((b) => b.landmark === 'corner').length, 4, '四角楼覆盖');
for (const zone of ['外朝', '内廷', '东六宫', '西六宫', '宁寿宫', '慈宁宫', '御花园', '城垣']) assert(data.buildings.some((b) => b.zone === zone), `缺少分区 ${zone}`);
for (const [zone, names] of [
  ['东六宫', ['景仁宫', '承乾宫', '钟粹宫', '延禧宫', '永和宫', '景阳宫']],
  ['西六宫', ['永寿宫', '翊坤宫', '储秀宫', '太极殿', '长春宫', '咸福宫']],
]) for (const name of names) assert(data.buildings.some((b) => b.name === name && b.zone === zone), `六宫对应建筑或分区缺失 ${name}`);
for (const name of ['午门', '神武门', '东华门', '西华门']) assert(data.buildings.some((b) => b.name === name && b.kind === 'gate'), `四门覆盖缺失 ${name}`);
assert(data.buildings.some((b) => b.name === '钦安殿' && b.roofKind === 'luding'), '钦安殿应标识为盝顶');
for (const b of data.buildings.filter((b) => /院墙/.test(b.name))) assert(b.kind === 'wall', `院墙应按足迹渲染 ${b.id}`);
for (const polygon of data.water) assert(polygon.length >= 3 && polygon.every(finitePair), '水面必须是有效多边形');
for (const line of [...(data.waterLines || []), ...data.paths]) assert(line.length >= 2 && line.every(finitePair), '通道或水线无效');
for (const area of data.waterAreas || []) assert(area.outer.length >= 3 && area.outer.every(finitePair) && area.holes.every((p) => p.length >= 3 && p.every(finitePair)), '水面复合多边形无效');
const counts = Object.fromEntries([...new Set(data.buildings.map((b) => b.kind))].map((kind) => [kind, data.buildings.filter((b) => b.kind === kind).length]));
console.log(JSON.stringify({ valid: true, records: ids.size, types: counts, boundaryVersion: data.metadata.boundaryVersion, fetchedAt: data.metadata.fetchedAt }));
const geometryCheck = spawnSync(process.execPath, ['tools/validate-geometry.ts'], { stdio: 'inherit', cwd: process.cwd() });
if (geometryCheck.status !== 0) process.exit(geometryCheck.status || 1);
