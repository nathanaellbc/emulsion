/** Generates a test image with content chosen at run time, so whether the
 *  assistant can truly "see" it can be checked against ground truth. */
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 480, height: 320 } });
await p.setContent(`<body style="margin:0">
  <div style="width:480px;height:320px;background:#202028;position:relative;font-family:monospace">
    <div style="position:absolute;top:16px;left:16px;color:#3fff6e;font-size:34px;font-weight:bold">MAGPIE-7</div>
    <div style="position:absolute;top:70px;left:16px;color:#dddddd;font-size:18px">triangles: 5 &nbsp; squares: 2</div>
    <svg width="480" height="320" style="position:absolute;top:0;left:0">
      <polygon points="60,220 100,150 140,220" fill="#ffcc00"/>
      <polygon points="180,220 220,150 260,220" fill="#3fa9ff"/>
      <polygon points="300,220 340,150 380,220" fill="#ff5577"/>
      <polygon points="60,290 100,240 140,290" fill="#ffffff"/>
      <polygon points="180,290 220,240 260,290" fill="#ffcc00"/>
      <rect x="330" y="240" width="44" height="44" fill="#9b59ff"/>
      <rect x="390" y="240" width="44" height="44" fill="#ff5577"/>
    </svg>
  </div>
</body>`);
await p.screenshot({ path: 'verify-shots/vision-test.png' });
await b.close();
console.log('written verify-shots/vision-test.png');
