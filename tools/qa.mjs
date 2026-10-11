import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const base = process.env.PALACE_URL || 'http://127.0.0.1:4186/';
const output = resolve('docs/screenshots');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
const checks = [];
const check = (name, value) => { checks.push({ name, passed: !!value }); if (!value) throw new Error(name); };
try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__palace?.ready, { timeout: 90000 });
  await page.waitForTimeout(2200);
  const initial = await page.evaluate(() => ({ stats: window.__palace.stats, records: window.__palace.data.buildings.length, rendered: window.__palace.renderedIds.length, ids: window.__palace.renderedIds, landmarks: window.__palace.data.buildings.filter((b) => b.landmark).map((b) => [b.landmark, b.id]), camera: window.__palace.camera }));
  check('全部清单模型生成', initial.records === initial.rendered && new Set(initial.ids).size === initial.records);
  await page.screenshot({ path: resolve(output, 'overview.png') });
  const ids = new Map(initial.landmarks);
  const pickPoint = await page.evaluate((id) => window.__palace.screenPoint(id), ids.get('taihe'));
  await page.mouse.click(...pickPoint); await page.waitForTimeout(1700);
  check('点击三维建筑', await page.evaluate((id) => window.__palace.selected === id, ids.get('taihe')));
  for (const [landmark, filename] of [['taihe', 'taihe.png'], ['wumen', 'wumen.png'], ['corner', 'corner.png'], ['yuhuayuan', 'garden.png']]) {
    let id = ids.get(landmark);
    if (!id && landmark === 'corner') id = await page.evaluate(() => window.__palace.data.buildings.find((b) => b.kind === 'tower')?.id);
    check(`包含${landmark}模型`, id);
    await page.evaluate((value) => window.__palace.select(value), id);
    await page.waitForTimeout(2200);
    check(`${landmark}定位与详情`, await page.evaluate((value) => window.__palace.selected === value, id));
    await page.screenshot({ path: resolve(output, filename) });
  }
  await page.locator('#view-top').click();
  await page.waitForTimeout(1900);
  await page.screenshot({ path: resolve(output, 'top.png') });
  await page.locator('#view-overview').click();
  await page.waitForTimeout(1900);
  const before = await page.evaluate(() => window.__palace.camera);
  await page.mouse.move(490, 355); await page.mouse.down(); await page.mouse.move(625, 377, { steps: 14 }); await page.mouse.up();
  await page.waitForTimeout(400);
  check('鼠标旋转', JSON.stringify(before) !== JSON.stringify(await page.evaluate(() => window.__palace.camera)));
  await page.mouse.wheel(0, -280); await page.waitForTimeout(500);
  await page.locator('#view-quality').selectOption('low');
  await page.locator('#view-quality').selectOption('high');
  await page.locator('#view-labels').click();
  check('标签隐藏', await page.locator('.scene-label-layer').isHidden());
  await page.locator('#view-labels').click();
  await page.evaluate(() => window.__palace.overview()); await page.waitForTimeout(1600);
  await page.locator('#building-search').fill('太和殿');
  check('中文建筑搜索', await page.locator('[data-pick]').filter({ hasText: '太和殿' }).count() > 0);
  await page.locator('#building-search').fill('');
  await page.locator('#view-walk').click();
  await page.waitForTimeout(700);
  check('进入地面漫游', await page.evaluate(() => window.__palace.walking));
  const walkBefore = await page.evaluate(() => window.__palace.camera);
  await page.keyboard.down('KeyW'); await page.waitForTimeout(450); await page.keyboard.up('KeyW');
  check('WASD行走', JSON.stringify(walkBefore) !== JSON.stringify(await page.evaluate(() => window.__palace.camera)));
  const collision = await page.evaluate(() => {
    const p = window.__palace;
    const hall = p.data.buildings.find((b) => b.landmark === 'taihe');
    const gates = p.data.buildings.filter((b) => ['taihemen', 'qianqingmen'].includes(b.landmark));
    return { hallBlocked: p.isBlocked(...hall.center), outsideBlocked: p.isBlocked(3000, 3000), currentFree: !p.isBlocked(p.camera[0], p.camera[2]), gatesPassable: gates.every((b) => !p.isBlocked(...b.center)) };
  });
  check('建筑及边界碰撞', collision.hallBlocked && collision.outsideBlocked && collision.currentFree);
  check('中轴门洞可通行', collision.gatesPassable);
  const wumenCollision = await page.evaluate(() => {
    const p = window.__palace;
    const b = p.data.buildings.find((record) => record.landmark === 'wumen');
    const c = Math.cos(b.angle), s = Math.sin(b.angle);
    const world = (localX, localZ) => [b.center[0] + localX * c + localZ * s, b.center[1] - localX * s + localZ * c];
    return {
      portalFree: !p.isBlocked(...world(0, -b.depth * 0.29)),
      courtFree: [10, 30].every((localZ) => !p.isBlocked(...world(20, localZ))),
      mainPierBlocked: p.isBlocked(...world(b.width * 0.085, -b.depth * 0.29)),
      wingBlocked: p.isBlocked(...world(b.width * 0.328, b.depth * 0.07)),
      beyondCourtBlocked: p.isBlocked(...world(0, b.depth * 0.51)),
    };
  });
  check('午门门洞与U形庭院可通行', wumenCollision.portalFree && wumenCollision.courtFree);
  check('午门门墩、翼楼与庭院边界碰撞', wumenCollision.mainPierBlocked && wumenCollision.wingBlocked && wumenCollision.beyondCourtBlocked);
  const irregularCollision = await page.evaluate(() => {
    const p = window.__palace;
    const b = p.data.buildings.find((record) => record.id === 'osm-way-1341826223');
    const c = Math.cos(b.angle), s = Math.sin(b.angle);
    const world = (localX, localZ) => [b.center[0] + localX * c + localZ * s, b.center[1] - localX * s + localZ * c];
    const inFootprint = ([x, z]) => {
      let inside = false;
      for (let i = 0, j = b.footprint.length - 1; i < b.footprint.length; j = i++) {
        const a = b.footprint[i], previous = b.footprint[j];
        if ((a[1] > z) !== (previous[1] > z) && x < (previous[0] - a[0]) * (z - a[1]) / (previous[1] - a[1]) + a[0]) inside = !inside;
      }
      return inside;
    };
    const court = world(0, 0), wall = world(-6, 0);
    return { sourceCourtEmpty: !inFootprint(court), sourceWallSolid: inFootprint(wall), courtFree: !p.isBlocked(...court), wallBlocked: p.isBlocked(...wall) };
  });
  check('异形建筑按来源轮廓保留院落', irregularCollision.sourceCourtEmpty && irregularCollision.sourceWallSolid && irregularCollision.courtFree && irregularCollision.wallBlocked);
  const stair = await page.evaluate(() => {
    const p = window.__palace;
    const b = p.data.buildings.find((b) => b.name === '三台南段');
    const c = Math.cos(b.angle), s = Math.sin(b.angle);
    const local = b.footprint.map(([x, z]) => [(x - b.center[0]) * c - (z - b.center[1]) * s, (x - b.center[0]) * s + (z - b.center[1]) * c]);
    const intersections = local.flatMap((a, i) => {
      const next = local[(i + 1) % local.length], t = -a[0] / (next[0] - a[0]);
      return Number.isFinite(t) && t >= 0 && t <= 1 ? [a[1] + (next[1] - a[1]) * t] : [];
    });
    const edge = Math.max(...intersections), length = Math.max(1.8, b.height * 1.8);
    const sample = (offset) => {
      const z = edge + offset, x = b.center[0] + z * s, worldZ = b.center[1] + z * c;
      return { height: p.terrainHeight(x, worldZ), free: !p.isBlocked(x, worldZ) };
    };
    return { expected: b.height, top: sample(-0.1), middle: sample(length / 2), bottom: sample(length + 0.1) };
  });
  check('台阶沿真实轮廓连续登台', Math.abs(stair.top.height - stair.expected) < 0.01 && Math.abs(stair.middle.height - stair.expected / 2) < 0.01 && stair.bottom.height < 0.01 && stair.middle.free && stair.bottom.free);
  await page.keyboard.press('Escape');
  check('Esc退出漫游', await page.evaluate(() => !window.__palace.walking));
  await page.evaluate(() => window.__palace.overview()); await page.waitForTimeout(1900);
  await page.locator('#view-quality').selectOption('auto');
  const interactionFPS = await page.evaluate(async () => {
    const start = performance.now(); let frames = 0;
    while (performance.now() - start < 3500) { await new Promise(requestAnimationFrame); window.__palace.rotate(0.002); frames++; }
    return Math.round(frames * 1000 / (performance.now() - start));
  });
  check('1280×720持续交互至少30FPS', interactionFPS >= 30);
  await page.evaluate(() => window.__palace.overview()); await page.waitForTimeout(1600);
  const desktopStats = await page.evaluate(() => window.__palace.stats);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  check('手机无横向溢出', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: resolve(output, 'mobile.png') });
  await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(700);
  await page.screenshot({ path: resolve(output, 'desktop.png') });
  console.log(JSON.stringify({ desktopStats, errors }));
  check('浏览器无运行错误', errors.length === 0);
  const report = { base, checkedAt: new Date().toISOString(), checks, interactionFPS, desktopStats, initialStats: initial.stats, collision, wumenCollision, irregularCollision, stair, errors, records: initial.records };
  await writeFile(resolve('docs/qa-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(resolve('docs/qa-report.json'), JSON.stringify({ base, checkedAt: new Date().toISOString(), checks, errors, failure: error.message }, null, 2));
  throw error;
} finally { await browser.close(); }
