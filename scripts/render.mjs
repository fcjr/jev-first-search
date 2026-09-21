#!/usr/bin/env node
// Renders an animation page to MP4: headless Chrome via the DevTools protocol, then ffmpeg.
//
//   node scripts/render.mjs media/race.html media/race.mp4 [fps]
//
// The page must expose window.__LOOP__ (ms) and window.__render(t).
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [page, out, fpsArg] = process.argv.slice(2);
if (!page || !out) {
  console.error('usage: node scripts/render.mjs <page.html> <out.mp4> [fps]');
  process.exit(2);
}
const FPS = Number(fpsArg ?? 30);
const W = 1200, H = 676;

const profile = await mkdtemp(join(tmpdir(), 'jfs-chrome-'));
const frames = await mkdtemp(join(tmpdir(), 'jfs-frames-'));
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${W},${H}`, '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
const wsUrl = await new Promise((res, rej) => {
  let buf = '';
  chrome.stderr.on('data', (d) => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) res(m[1]);
  });
  chrome.on('exit', () => rej(new Error('chrome exited before it started listening')));
});
const port = new URL(wsUrl).port;
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((res) => (ws.onopen = res));

let nextId = 0;
const pending = new Map();
const listeners = new Set();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  } else if (m.method) {
    for (const l of listeners) l(m);
  }
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++nextId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
const once = (method) =>
  new Promise((res) => {
    const l = (m) => { if (m.method === method) { listeners.delete(l); res(m.params); } };
    listeners.add(l);
  });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
const loaded = once('Page.loadEventFired');
await send('Page.navigate', { url: `file://${resolve(page)}?frame=1&t=0` });
await loaded;
await evaluate('document.fonts.ready.then(() => true)');

const LOOP = await evaluate('window.__LOOP__');
if (typeof LOOP !== 'number') throw new Error('page did not set window.__LOOP__');
const N = Math.ceil((LOOP * FPS) / 1000);
console.log(`${page}: ${LOOP} ms loop, ${N} frames at ${FPS} fps`);

for (let i = 0; i < N; i++) {
  const t = Math.round((i * 1000) / FPS);
  await evaluate(`window.__render(${t}); true`);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(frames, `${String(i).padStart(5, '0')}.png`), Buffer.from(data, 'base64'));
  if (i % FPS === 0) process.stdout.write(`\r  ${i}/${N}`);
}
process.stdout.write(`\r  ${N}/${N}\n`);

ws.close();
chrome.kill();
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(frames, '%05d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', resolve(out)]);
await rm(frames, { recursive: true, force: true });
await rm(profile, { recursive: true, force: true });
console.log(`wrote ${out}`);
