/**
 * Ground-truth comparison against a set of in-camera film simulations.
 *
 * `sample/` holds one base photograph (the AVIF) and the same scene rendered
 * by the camera through two print-stock simulations — Fujifilm Eterna-CP
 * 3513DI and Kodak Vision 2383 — each balanced for three illuminants
 * (D55, D60, D65). This loads the base into the running app, then for every
 * simulation sets EMULSION's matching print stock and white balance and
 * captures the render, so the physical chain can be eyeballed against the
 * camera's own simulation of the same stock under the same light.
 *
 * Grain and halation are set to zero: the comparison is the pointwise transfer
 * (curve, mask, crosstalk, print), which is what a print-stock simulation is.
 * Those stages are spatial/stochastic and would only add noise to a per-pixel
 * comparison.
 *
 *   node scripts/compare-samples.mjs [--url http://localhost:4173]
 *
 * Writes `sample-compare/` — the EMULSION renders and an `index.html` report
 * placing each beside its Fuji reference.
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const url = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://localhost:4173';

const SAMPLE = 'sample';
const OUT = 'sample-compare';
const BASE = join(SAMPLE, 'IMG_1906.AVIF');

// Print stock id in EMULSION, and the illuminant -> white balance (K).
const SIMS = [
  { fuji: 'Fujifilm Eterna-CP 3513DI D55.dng', printId: 'prt.3513', illum: 'D55', kelvin: 5500 },
  { fuji: 'Fujifilm Eterna-CP 3513DI D60.dng', printId: 'prt.3513', illum: 'D60', kelvin: 6000 },
  { fuji: 'Fujifilm Eterna-CP 3513DI D65.dng', printId: 'prt.3513', illum: 'D65', kelvin: 6500 },
  { fuji: 'Kodak Vision 2383 D55.dng', printId: 'prt.2383', illum: 'D55', kelvin: 5500 },
  { fuji: 'Kodak Vision 2383 D60.dng', printId: 'prt.2383', illum: 'D60', kelvin: 6000 },
  { fuji: 'Kodak Vision 2383 D65.dng', printId: 'prt.2383', illum: 'D65', kelvin: 6500 },
];

if (!existsSync(BASE)) {
  console.error(`base image not found: ${BASE}`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const problems = [];
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 });
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('.dropzone');
await page.setInputFiles('input[type=file]', BASE);
await page.waitForSelector('.rail', { timeout: 30000 });
await page.waitForTimeout(1200);

const shotPath = (name) => join(OUT, `${name}.png`);
const canvasShot = async (name) => {
  await page.locator('canvas').first().screenshot({ path: shotPath(name) });
};

// Set a slider by its label to an exact value (React-controlled <input type=range>).
async function setSlider(label, value) {
  const input = page.locator('.control', { has: page.locator(`label:text-is("${label}")`) }).locator('input');
  await input.evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

// Neutralise the spatial/stochastic stages once, for a clean pointwise comparison.
// The rail opens on the Camera bench; the grain/halation sliders live on Film.
await page.getByRole('tab', { name: 'Film', exact: true }).click();
await page.waitForTimeout(400);
await setSlider('Amount', 0);        // grain
await setSlider('Intensity', 0);     // halation
// Exposure compensation lives on the Camera bench now.
await page.getByRole('tab', { name: 'Camera', exact: true }).click();
await page.waitForTimeout(400);
await setSlider('Exposure', 0);

// Capture the un-filmed base render for reference.
await canvasShot('00-base');

for (const sim of SIMS) {
  // Print stock, then white balance for the illuminant.
  await page.getByRole('tab', { name: 'Film', exact: true }).click();
  await page.waitForTimeout(300);
  await page.getByLabel('Print stock').selectOption(sim.printId);
  await page.getByRole('tab', { name: 'Camera', exact: true }).click();
  await page.waitForTimeout(300);
  await setSlider('White balance', sim.kelvin);
  await page.waitForTimeout(900);

  const tag = `${sim.printId.replace('prt.', '')}-${sim.illum}`;
  await canvasShot(`emu-${tag}`);

  // Bring the Fuji reference alongside for the report.
  copyFileSync(join(SAMPLE, sim.fuji), join(OUT, `fuji-${tag}.dng`));
  console.log(`  ${sim.fuji}  ->  emu-${tag}.png (print ${sim.printId}, ${sim.kelvin} K)`);
}

await browser.close();

// The Fuji references are DNG; the report shows the EMULSION PNGs and links the
// DNGs (a browser cannot draw a DNG inline). Each row pairs them by stock+illuminant.
const rows = SIMS.map((sim) => {
  const tag = `${sim.printId.replace('prt.', '')}-${sim.illum}`;
  return `<tr>
  <th>${sim.printId.replace('prt.', '')} · ${sim.illum} <span class="k">(${sim.kelvin} K)</span></th>
  <td><img src="${basename(shotPath(`emu-${tag}`))}" alt="EMULSION ${tag}"></td>
  <td><a href="fuji-${tag}.dng">${sim.fuji}</a><br><span class="k">DNG — open in a RAW viewer</span></td>
</tr>`;
}).join('\n');

writeFileSync(join(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><title>EMULSION vs in-camera simulations</title>
<style>
 body{font:14px/1.5 system-ui;margin:24px;background:#111;color:#eee}
 table{border-collapse:collapse;width:100%}
 th,td{border:1px solid #333;padding:8px;vertical-align:middle;text-align:left}
 img{max-width:460px;display:block}
 .k{color:#999;font-weight:400}
 h1{font-size:18px} p{max-width:70ch;color:#bbb}
</style>
<h1>EMULSION (left) vs the camera's own simulation (right)</h1>
<p>Base: ${basename(BASE)}. Each row is one print stock balanced for one illuminant.
EMULSION renders the physical chain with grain and halation at zero (the pointwise
transfer a print-stock simulation is); the Fuji column is the camera's DNG of the
same scene, same stock, same light. The DNGs are not drawn inline — open them in a
RAW viewer beside the PNG.</p>
<img src="00-base.png" alt="base render" style="max-width:520px;margin:8px 0 20px">
<table><tr><th>stock · illuminant</th><th>EMULSION render</th><th>camera DNG</th></tr>
${rows}
</table>`);

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`\ndone. report: ${join(OUT, 'index.html')}`);
