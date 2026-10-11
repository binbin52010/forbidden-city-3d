import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const base = process.env.PALACE_URL || 'https://binbin52010.github.io/forbidden-city-3d/';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors = [], failedResources = [], resources = [], checks = [];
const report = { base, checkedAt: new Date().toISOString(), checks, errors, failedResources, resources };
const check = (name, condition) => { checks.push({ name, passed: !!condition }); assert(condition, name); };
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
page.on('requestfailed', (request) => failedResources.push({ url: request.url(), error: request.failure()?.errorText }));
page.on('response', (response) => {
  if (response.url().startsWith(base)) resources.push({ url: response.url(), status: response.status() });
  if (response.status() >= 400) failedResources.push({ url: response.url(), status: response.status() });
});
try {
  const response = await page.goto(base, { waitUntil: 'networkidle', timeout: 90000 });
  check('在线页面HTTP成功', response?.ok());
  await page.waitForFunction(() => window.__palace?.ready, { timeout: 90000 });
  await page.waitForTimeout(1600);
  report.records = await page.evaluate(() => window.__palace.renderedIds.length);
  check('在线模型清单完整载入', report.records === 1235);
  check('生产脚本、样式及本地模型数据成功载入', ['.js', '.css', 'data/palace.json'].every((suffix) => resources.some((r) => r.status === 200 && r.url.endsWith(suffix))));
  await mkdir(resolve('docs/screenshots'), { recursive: true });
  await page.screenshot({ path: resolve('docs/screenshots/live-overview.png') });
  const taihe = await page.evaluate(() => window.__palace.data.buildings.find((b) => b.landmark === 'taihe').id);
  const position = await page.evaluate((id) => window.__palace.screenPoint(id), taihe);
  await page.mouse.click(...position);
  await page.waitForTimeout(1800);
  check('在线模型点击定位和中文详情', await page.evaluate((id) => window.__palace.selected === id, taihe) && await page.locator('#building-detail').isVisible());
  await page.screenshot({ path: resolve('docs/screenshots/live-taihe.png') });
  const courtyard = await page.evaluate(() => window.__palace.data.buildings.find((b) => b.zone === '西六宫' && /储秀宫/.test(b.name) && b.kind === 'building')?.id);
  check('六宫院落模型覆盖', courtyard);
  await page.evaluate((id) => window.__palace.select(id), courtyard);
  await page.waitForTimeout(1800);
  await page.screenshot({ path: resolve('docs/screenshots/six-palaces.png') });
  await page.locator('#view-overview').click();
  await page.waitForTimeout(1500);
  check('上线资源无失败及浏览器无错误', errors.length === 0 && failedResources.length === 0);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error.message;
  throw error;
} finally {
  await writeFile(resolve('docs/deployment-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
