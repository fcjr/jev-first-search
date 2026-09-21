#!/usr/bin/env node
// Screenshots each figure of media/charts.html to media/chart-<id>.png at 1200x676 (2x).
//   node scripts/snap.mjs [media/charts.html]
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const page = process.argv[2] ?? 'media/charts.html';
const W = 1200, H = 676, SCALE = 2;
const profile = await mkdtemp(join(tmpdir(), 'jfs-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${W},${H}`, '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((res, rej) => { let b = ''; chrome.stderr.on('data', (d) => { b += d; const m = b.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); }); chrome.on('exit', () => rej(new Error('chrome exited'))); });
const port = new URL(wsUrl).port;
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((res) => (ws.onopen = res));
let nextId = 0; const pending = new Map(); const listeners = new Set();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } else if (m.method) for (const l of listeners) l(m); };
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++nextId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const once = (method) => new Promise((res) => { const l = (m) => { if (m.method === method) { listeners.delete(l); res(m.params); } }; listeners.add(l); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });
const loaded = once('Page.loadEventFired');
await send('Page.navigate', { url: `file://${resolve(page)}?frame=1` });
await loaded;
await evaluate('document.fonts.ready.then(() => true)');
const figs = await evaluate('window.__FIGS__');
for (const id of figs) {
  await evaluate(`window.__showFig(${JSON.stringify(id)}); true`);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const out = `media/chart-${id}.png`;
  await writeFile(out, Buffer.from(data, 'base64'));
  console.log(`wrote ${out}`);
}
ws.close(); chrome.kill();
await rm(profile, { recursive: true, force: true });
