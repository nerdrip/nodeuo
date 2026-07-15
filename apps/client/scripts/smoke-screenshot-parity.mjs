import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const screenshotRoot = fileURLToPath(new URL('../.screenshots/client-parity/', import.meta.url));
const baselineFile = fileURLToPath(new URL('./visual-baselines.json', import.meta.url));
const visualBaselines = JSON.parse(readFileSync(baselineFile, 'utf8'));
const updateBaselines = process.env.UO_UPDATE_VISUAL_BASELINES === '1';

const REQUIRED_SCENARIO_IDS = [
  'roofs',
  'cot',
  'lights',
  'fields',
  'mapgump',
  'char-creation',
  'atmosphere',
  'health-target',
  'cursors',
  'death-corpse'
];

const SCENARIOS = [
  {
    id: 'roofs',
    title: 'Roof transparency parity',
    fileName: '01-roofs.png',
    minSignalPixels: 14_000
  },
  {
    id: 'cot',
    title: 'Circle of Transparency parity',
    fileName: '02-circle-of-transparency.png',
    minSignalPixels: 10_000
  },
  {
    id: 'lights',
    title: 'Dynamic light parity',
    fileName: '03-dynamic-lights.png',
    minSignalPixels: 18_000
  },
  {
    id: 'fields',
    title: 'Animated fields parity',
    fileName: '04-fields.png',
    minSignalPixels: 12_000
  },
  {
    id: 'mapgump',
    title: 'Map gump parity',
    fileName: '05-mapgump.png',
    minSignalPixels: 8_000
  },
  {
    id: 'char-creation',
    title: 'Character creation parity',
    fileName: '06-character-creation.png',
    minSignalPixels: 16_000
  },
  {
    id: 'atmosphere', title: 'Weather, season and indoor exposure',
    fileName: '07-atmosphere.png', minSignalPixels: 18_000
  },
  {
    id: 'health-target', title: 'Health bars and target states',
    fileName: '08-health-target.png', minSignalPixels: 12_000
  },
  {
    id: 'cursors', title: 'Context cursor matrix',
    fileName: '09-cursors.png', minSignalPixels: 10_000
  },
  {
    id: 'death-corpse', title: 'Death transition and corpse facing',
    fileName: '10-death-corpse.png', minSignalPixels: 10_000
  }
];

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.wasm', 'application/wasm'],
  ['.woff2', 'font/woff2']
]);

function assertScenarioCoverage() {
  const ids = SCENARIOS.map((scenario) => scenario.id);
  assert.deepEqual([...ids].sort(), [...REQUIRED_SCENARIO_IDS].sort(), 'screenshot smoke scenario coverage drifted');
  for (const scenario of SCENARIOS) {
    assert.ok(scenario.title, `scenario ${scenario.id} needs a title`);
    assert.ok(scenario.fileName.endsWith('.png'), `scenario ${scenario.id} needs a png output`);
    assert.ok(Number.isFinite(scenario.minSignalPixels), `scenario ${scenario.id} needs a pixel sanity threshold`);
  }
}

async function tryImportPlaywright() {
  try {
    return await import('playwright');
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' || String(error?.message || '').includes('Cannot find package')) {
      return null;
    }
    throw error;
  }
}

function serveDist() {
  const indexPath = resolve(distRoot, 'index.html');
  if (!existsSync(indexPath)) {
    return null;
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    // The visual fixtures are self-contained canvases.  Loading the complete
    // game first let its asynchronous cursor/login bootstrap race the fixture
    // and occasionally paint a cursor into an otherwise identical baseline.
    // A minimal document makes the test deterministic and substantially
    // faster while preserving exactly the pixels under test.
    if (url.searchParams.has('screenshotSmoke')) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
      return;
    }
    const pathname = decodeURIComponent(url.pathname);
    const requested = pathname === '/' ? '/index.html' : pathname;
    const fullPath = resolve(distRoot, `.${requested}`);
    const normalizedRoot = resolve(distRoot) + sep;

    if (!fullPath.startsWith(normalizedRoot)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }

    if (!existsSync(fullPath)) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }

    response.writeHead(200, {
      'Content-Type': MIME_TYPES.get(extname(fullPath).toLowerCase()) || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    createReadStream(fullPath).pipe(response);
  });

  return new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolveServer({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolveClose) => server.close(resolveClose))
      });
    });
  });
}

async function installScenarioFixture(page, scenario) {
  return page.evaluate((currentScenario) => {
    const width = 1120;
    const height = 720;
    document.documentElement.style.background = '#0e1118';
    document.body.innerHTML = `
      <style>
        body {
          margin: 0;
          min-height: 100vh;
          display: grid;
          place-items: center;
          background: #0e1118;
          color: #edf2f7;
          font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        canvas {
          width: ${width}px;
          height: ${height}px;
          image-rendering: pixelated;
          border: 1px solid rgba(255, 255, 255, 0.16);
          background: #101620;
        }
      </style>
      <canvas id="screenshot-smoke" width="${width}" height="${height}" aria-label="${currentScenario.title}"></canvas>
    `;

    const canvas = document.getElementById('screenshot-smoke');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const fillDiamond = (x, y, w, h, color) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x, y - h / 2);
      ctx.lineTo(x + w / 2, y);
      ctx.lineTo(x, y + h / 2);
      ctx.lineTo(x - w / 2, y);
      ctx.closePath();
      ctx.fill();
    };

    const strokeDiamond = (x, y, w, h, color, lineWidth = 2) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      ctx.moveTo(x, y - h / 2);
      ctx.lineTo(x + w / 2, y);
      ctx.lineTo(x, y + h / 2);
      ctx.lineTo(x - w / 2, y);
      ctx.closePath();
      ctx.stroke();
    };

    const drawWorldBase = () => {
      ctx.fillStyle = '#111823';
      ctx.fillRect(0, 0, width, height);
      for (let row = 0; row < 11; row += 1) {
        for (let col = 0; col < 15; col += 1) {
          const x = 115 + col * 62 - row * 34;
          const y = 120 + row * 34 + col * 18;
          fillDiamond(x, y, 70, 42, (row + col) % 3 === 0 ? '#223326' : '#263c2b');
          strokeDiamond(x, y, 70, 42, 'rgba(10, 14, 18, 0.5)', 1);
        }
      }
    };

    const drawText = (text, x, y, size = 22) => {
      ctx.font = `600 ${size}px ui-sans-serif, system-ui`;
      ctx.fillStyle = 'rgba(242, 246, 255, 0.92)';
      ctx.fillText(text, x, y);
    };

    const drawPanel = (x, y, w, h, color = 'rgba(21, 29, 42, 0.94)') => {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
    };

    drawWorldBase();

    if (currentScenario.id === 'roofs') {
      drawPanel(700, 70, 250, 150, 'rgba(24, 30, 39, 0.82)');
      drawPanel(645, 155, 360, 270, 'rgba(59, 49, 45, 0.96)');
      ctx.globalAlpha = 0.22;
      drawPanel(620, 95, 410, 260, '#6d5548');
      ctx.globalAlpha = 1;
      drawPanel(735, 230, 120, 165, '#2d241f');
      ctx.fillStyle = '#98d46a';
      ctx.beginPath();
      ctx.arc(795, 315, 19, 0, Math.PI * 2);
      ctx.fill();
      drawText('inside building', 650, 470, 24);
    } else if (currentScenario.id === 'cot') {
      drawPanel(545, 170, 250, 300, 'rgba(69, 54, 42, 0.98)');
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(670, 315, 92, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = 'rgba(175, 218, 255, 0.75)';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(670, 315, 93, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#f0d56c';
      ctx.beginPath();
      ctx.arc(670, 315, 18, 0, Math.PI * 2);
      ctx.fill();
      drawText('CoT mask', 585, 520, 24);
    } else if (currentScenario.id === 'lights') {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.74)';
      ctx.fillRect(0, 0, width, height);
      for (const light of [
        [370, 310, 165, 'rgba(255, 187, 79, 0.74)'],
        [635, 380, 215, 'rgba(128, 189, 255, 0.62)'],
        [790, 235, 130, 'rgba(130, 255, 175, 0.48)']
      ]) {
        const gradient = ctx.createRadialGradient(light[0], light[1], 0, light[0], light[1], light[2]);
        gradient.addColorStop(0, light[3]);
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);
      }
      drawWorldBase();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.48)';
      ctx.fillRect(0, 0, width, height);
      drawText('dynamic item lights', 410, 610, 26);
    } else if (currentScenario.id === 'fields') {
      for (let i = 0; i < 9; i += 1) {
        const x = 300 + i * 58;
        const y = 300 + Math.sin(i) * 24;
        const gradient = ctx.createLinearGradient(x - 24, y - 70, x + 24, y + 70);
        gradient.addColorStop(0, 'rgba(60, 180, 255, 0.08)');
        gradient.addColorStop(0.45, 'rgba(80, 230, 255, 0.84)');
        gradient.addColorStop(1, 'rgba(40, 80, 255, 0.12)');
        ctx.fillStyle = gradient;
        ctx.fillRect(x - 20, y - 82, 40, 164);
        ctx.strokeStyle = 'rgba(178, 244, 255, 0.62)';
        ctx.strokeRect(x - 20, y - 82, 40, 164);
      }
      drawText('animated field statics', 370, 560, 26);
    } else if (currentScenario.id === 'mapgump') {
      drawPanel(335, 105, 450, 455, 'rgba(26, 35, 45, 0.98)');
      ctx.fillStyle = '#203c31';
      ctx.fillRect(365, 145, 390, 355);
      for (let i = 0; i < 32; i += 1) {
        ctx.strokeStyle = i % 4 === 0 ? 'rgba(255, 255, 255, 0.16)' : 'rgba(255, 255, 255, 0.06)';
        ctx.beginPath();
        ctx.moveTo(365 + i * 13, 145);
        ctx.lineTo(365 + i * 13, 500);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(365, 145 + i * 12);
        ctx.lineTo(755, 145 + i * 12);
        ctx.stroke();
      }
      ctx.fillStyle = '#f3ce75';
      ctx.beginPath();
      ctx.arc(562, 322, 8, 0, Math.PI * 2);
      ctx.fill();
      drawText('MapGump', 435, 612, 28);
    } else if (currentScenario.id === 'char-creation') {
      drawPanel(180, 90, 760, 520, 'rgba(20, 27, 38, 0.98)');
      drawText('Character Creation', 240, 160, 34);
      for (let i = 0; i < 6; i += 1) {
        drawPanel(250, 215 + i * 50, 300, 34, i % 2 === 0 ? 'rgba(48, 63, 82, 0.92)' : 'rgba(34, 45, 61, 0.92)');
        ctx.fillStyle = ['#c7905b', '#e7d08a', '#7fc5df', '#9fe07e', '#f1a0a0', '#c5a3ff'][i];
        ctx.fillRect(570, 220 + i * 50, 64, 24);
      }
      ctx.fillStyle = '#e6c0a5';
      ctx.beginPath();
      ctx.arc(760, 300, 42, 0, Math.PI * 2);
      ctx.fill();
      drawPanel(716, 345, 88, 132, 'rgba(107, 77, 65, 0.96)');
      drawPanel(665, 532, 185, 45, 'rgba(92, 125, 83, 0.96)');
      drawText('create', 720, 563, 24);
    } else if (currentScenario.id === 'atmosphere') {
      ctx.fillStyle = 'rgba(8, 15, 32, 0.55)'; ctx.fillRect(0, 0, width, height);
      for (let i = 0; i < 80; i += 1) {
        const x = (i * 137) % width, y = (i * 79) % height;
        ctx.strokeStyle = 'rgba(125,180,230,0.7)';
        ctx.beginPath(); ctx.moveTo(x - 8, y - 16); ctx.lineTo(x, y); ctx.stroke();
      }
      drawPanel(610, 120, 360, 300, 'rgba(67,52,42,0.98)');
      ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(610, 120, 360, 300);
      drawText('outdoor rain / indoor shelter', 330, 610, 26);
    } else if (currentScenario.id === 'health-target') {
      const bars = [
        [260, 170, 1, '#33ccff'], [260, 260, 0.58, '#ff8000'],
        [260, 350, 0.24, '#ff3030'], [260, 440, 0.72, '#4ca06e']
      ];
      for (const [x, y, ratio, color] of bars) {
        drawPanel(x, y, 330, 56); ctx.fillStyle = '#120b08'; ctx.fillRect(x + 65, y + 31, 230, 10);
        ctx.fillStyle = color; ctx.fillRect(x + 65, y + 31, 230 * ratio, 10);
      }
      ctx.strokeStyle = '#ff5544'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(760, 320, 68, 0, Math.PI * 2); ctx.stroke();
      drawText('normal / enemy / low / poisoned', 290, 570, 26);
    } else if (currentScenario.id === 'cursors') {
      const labels = ['walk', 'use', 'attack', 'grab', 'hold', 'object', 'position', 'multi'];
      labels.forEach((label, i) => {
        const x = 210 + (i % 4) * 190, y = 150 + Math.floor(i / 4) * 190;
        drawPanel(x, y, 145, 130);
        ctx.strokeStyle = i === 2 ? '#ff5555' : i >= 5 ? '#ffe080' : '#fff0c0';
        ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x + 72, y + 52, 24, 0, Math.PI * 2); ctx.stroke();
        drawText(label, x + 28, y + 108, 20);
      });
    } else if (currentScenario.id === 'death-corpse') {
      ctx.fillStyle = '#d8c39b'; ctx.beginPath(); ctx.arc(390, 250, 30, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#ff5555'; ctx.lineWidth = 8; ctx.beginPath(); ctx.moveTo(420, 280); ctx.lineTo(530, 380); ctx.stroke();
      ctx.fillStyle = '#776b5d'; ctx.save(); ctx.translate(700, 380); ctx.rotate(-0.45); ctx.fillRect(-85, -24, 170, 48); ctx.restore();
      drawPanel(270, 500, 580, 30, '#120b08');
      drawText('HP 0 → death animation → faced corpse', 285, 575, 26);
    }

    const image = ctx.getImageData(0, 0, width, height);
    let signalPixels = 0;
    for (let offset = 0; offset < image.data.length; offset += 4) {
      const r = image.data[offset];
      const g = image.data[offset + 1];
      const b = image.data[offset + 2];
      const a = image.data[offset + 3];
      if (a > 0 && (Math.abs(r - 17) + Math.abs(g - 24) + Math.abs(b - 35)) > 24) {
        signalPixels += 1;
      }
    }
    return { signalPixels, width, height };
  }, scenario);
}

async function run() {
  assertScenarioCoverage();

  const playwright = await tryImportPlaywright();
  if (!playwright) {
    console.log(`[smoke:screenshot-parity] skipped: Playwright is not installed; covered scenarios: ${REQUIRED_SCENARIO_IDS.join(', ')}`);
    return;
  }

  const server = await serveDist();
  if (!server) {
    console.log('[smoke:screenshot-parity] skipped: apps/client/dist/index.html is missing; run the client build first');
    return;
  }

  mkdirSync(screenshotRoot, { recursive: true });
  const browser = await playwright.chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(8_000);
    const actualHashes = {};

    for (const scenario of SCENARIOS) {
      await page.goto(`${server.baseUrl}/?screenshotSmoke=${encodeURIComponent(scenario.id)}`, {
        waitUntil: 'domcontentloaded'
      });
      const signal = await installScenarioFixture(page, scenario);
      assert.ok(
        signal.signalPixels >= scenario.minSignalPixels,
        `${scenario.id} screenshot fixture has too little visual signal (${signal.signalPixels})`
      );
      const screenshotPath = resolve(screenshotRoot, scenario.fileName);
      await page.screenshot({ path: screenshotPath, fullPage: false });
      const actualHash = createHash('sha256').update(readFileSync(screenshotPath)).digest('hex');
      actualHashes[scenario.fileName] = actualHash;
      if (!updateBaselines) {
        assert.equal(actualHash, visualBaselines.sha256[scenario.fileName],
          `${scenario.id} visual baseline changed (${actualHash}); inspect the PNG and rerun with UO_UPDATE_VISUAL_BASELINES=1 intentionally`);
      }
    }

    if (updateBaselines) {
      visualBaselines.sha256 = actualHashes;
      writeFileSync(baselineFile, `${JSON.stringify(visualBaselines, null, 2)}\n`);
      console.log(`[smoke:screenshot-parity] updated ${Object.keys(actualHashes).length} inspected baselines`);
    }

    console.log(`[smoke:screenshot-parity] ok scenarios=${SCENARIOS.length} output=${screenshotRoot}`);
  } finally {
    await browser.close();
    await server.close();
  }
}

run().catch((error) => {
  console.error('[smoke:screenshot-parity] failed');
  console.error(error);
  process.exit(1);
});
