/** Captures desktop + mobile screenshots of the app for visual comparison. */
import { chromium } from 'playwright';
const url = process.argv[2] ?? 'http://localhost:5173';
const tag = process.argv[3] ?? 'before';
const b = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });

const d = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
await d.goto(url, { waitUntil: 'networkidle' });
await d.setInputFiles('input[type=file]', 'public/test-chart.png');
await d.waitForSelector('.rail', { timeout: 20000 });
await d.waitForTimeout(900);
await d.screenshot({ path: `verify-shots/ui-${tag}-desktop.png` });

const m = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await m.goto(url, { waitUntil: 'networkidle' });
await m.setInputFiles('input[type=file]', 'public/test-chart.png');
await m.waitForSelector('.rail', { timeout: 20000 });
await m.waitForTimeout(900);
await m.screenshot({ path: `verify-shots/ui-${tag}-mobile.png` });

await b.close();
console.log(`written ui-${tag}-desktop.png, ui-${tag}-mobile.png`);
