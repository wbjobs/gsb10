/* integration-test.js - 全链路集成测试（Node）
 * 用内存 mock 替代 indexedDB / Worker 全局对象，
 * 驱动真实的 db.js + worker.js + dsp.js 走完整个业务流程。
 */
'use strict';
const path = require('path');

/* ---------- 内存版 IndexedDB mock ---------- */
function fakeReq(result) {
  const req = {};
  queueMicrotask(() => { req.result = result; if (req.onsuccess) req.onsuccess(); });
  return req;
}
class FakeStore {
  constructor(keyPath, autoIncrement) {
    this.keyPath = keyPath; this.autoIncrement = autoIncrement;
    this.data = new Map(); this.seq = 0;
  }
  add(obj) {
    const key = this.autoIncrement ? ++this.seq : obj[this.keyPath];
    this.data.set(key, Object.assign({}, obj, { [this.keyPath]: key }));
    return fakeReq(key);
  }
  put(obj) { this.data.set(obj[this.keyPath], obj); return fakeReq(obj[this.keyPath]); }
  get(key) { return fakeReq(this.data.get(key)); }
  getAll() { return fakeReq(Array.from(this.data.values())); }
  delete(key) { this.data.delete(key); return fakeReq(undefined); }
  clear() { this.data.clear(); return fakeReq(undefined); }
}
class FakeTx {
  constructor(db) {
    this.db = db;
    setTimeout(() => { if (this.oncomplete) this.oncomplete(); }, 0);
  }
  objectStore(name) { return this.db._stores[name]; }
}
function makeDb() {
  const db = {
    _stores: {},
    objectStoreNames: { contains(n) { return n in db._stores; } },
    createObjectStore(name, opts) {
      db._stores[name] = new FakeStore(opts.keyPath, opts.autoIncrement);
    },
    transaction() { return new FakeTx(db); },
  };
  return db;
}
const idbRegistry = new Map();
global.indexedDB = {
  open(name) {
    const req = {};
    queueMicrotask(() => {
      let db = idbRegistry.get(name);
      if (!db) {
        db = makeDb();
        idbRegistry.set(name, db);
        if (req.onupgradeneeded) req.onupgradeneeded({ target: { result: db } });
      }
      req.result = db;
      if (req.onsuccess) req.onsuccess();
    });
    return req;
  },
};

/* ---------- Worker 环境 mock ---------- */
const DSP = require('../js/dsp.js');
global.self = global;
let messageHandler = null;
const outbox = [];
global.postMessage = function (msg) { outbox.push(msg); };
global.importScripts = function () {
  Array.from(arguments).forEach((f) => require(path.resolve(__dirname, '../js', f)));
};
require('../js/worker.js');
messageHandler = global.onmessage;

function send(data) { messageHandler({ data }); }
function waitFor(type, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 5000);
  return new Promise((resolve, reject) => {
    (function poll() {
      const i = outbox.findIndex((m) => m.type === type);
      if (i >= 0) return resolve(outbox.splice(i, 1)[0]);
      if (Date.now() > deadline) return reject(new Error('timeout waiting ' + type));
      setTimeout(poll, 5);
    })();
  });
}
const FpDB = require('../js/db.js');

/* ---------- 信号工具（与 run-tests.js 相同） ---------- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeSong(seed, seconds, sr) {
  const rand = mulberry32(seed);
  const n = Math.floor(seconds * sr);
  const out = new Float32Array(n);
  const segments = Math.max(3, Math.floor(seconds / 2));
  for (let s = 0; s < segments; s++) {
    const start = Math.floor((s * n) / segments), end = Math.floor(((s + 1) * n) / segments);
    const f0 = 300 + rand() * 1500, f1 = f0 + (rand() - 0.5) * 1200;
    const harmonics = 2 + Math.floor(rand() * 4);
    const amps = []; for (let h = 0; h < harmonics; h++) amps.push(rand() * (1 / (h + 1)));
    const vibDepth = rand() * 8, vibRate = 2 + rand() * 5;
    for (let i = start; i < end; i++) {
      const t = i / sr, frac = (i - start) / (end - start), f = f0 + (f1 - f0) * frac;
      let sample = 0;
      for (let h = 0; h < harmonics; h++) {
        const fh = f * (h + 1); if (fh > 5000) break;
        sample += amps[h] * Math.sin(2 * Math.PI * fh * t + vibDepth * Math.sin(2 * Math.PI * vibRate * t));
      }
      out[i] += sample * Math.sin(Math.PI * frac) * 0.2;
    }
  }
  return out;
}
function simulateReencode(pcm, sr, cutoff, noiseLevel, gain) {
  const rc = 1 / (2 * Math.PI * cutoff), dt = 1 / sr, alpha = dt / (rc + dt);
  const out = new Float32Array(pcm.length);
  let y = 0, seed = 12345;
  for (let i = 0; i < pcm.length; i++) {
    y += alpha * (pcm[i] - y);
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = y * gain + (seed / 0x7fffffff - 0.5) * 2 * noiseLevel;
  }
  return out;
}

/* ---------- 测试流程 ---------- */
let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!cond) failures++;
}
const sr = DSP.SAMPLE_RATE;

async function importSong(pcm, name) {
  send({ type: 'fingerprint', pcm: pcm.buffer, requestId: 1 });
  const fp = await waitFor('fingerprinted');
  const id = await FpDB.addSong({
    name, duration: pcm.length / sr, hashCount: fp.hashes.length,
    createdAt: Date.now(), peaks: new Float32Array(8),
  });
  await FpDB.putFp(id, fp.hashes, fp.times);
  send({ type: 'index-add', songId: id, hashes: fp.hashes.buffer, times: fp.times.buffer });
  await waitFor('indexed');
  return id;
}

async function main() {
  send({ type: 'load' });
  const ready = await waitFor('ready');
  check('worker ready', ready.entries === 0, 'entries=' + ready.entries);

  const songs = [];
  for (let i = 0; i < 5; i++) songs.push(makeSong(500 + i, 20, sr));
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await importSong(songs[i], 'song-' + i));
  check('5 songs imported with ids', new Set(ids).size === 5, ids.join(','));

  // 持久化验证：指纹确实写入了 IndexedDB
  const storedFps = await FpDB.getAllFps();
  const storedSongs = await FpDB.getAllSongs();
  check('fingerprints persisted', storedFps.length === 5 && storedSongs.length === 5,
    'fps=' + storedFps.length + ' songs=' + storedSongs.length);

  // 模拟重启：清空 outbox，重新 load（索引从 IndexedDB 重建）
  send({ type: 'reset' });
  send({ type: 'load' });
  const ready2 = await waitFor('ready');
  check('index rebuilt from IndexedDB', ready2.entries > 1000, 'entries=' + ready2.entries);

  // 降质查询（模拟不同码率）
  const degraded = simulateReencode(songs[2], sr, 4000, 0.01, 0.8);
  send({ type: 'query', pcm: degraded.buffer, requestId: 2 });
  const res = await waitFor('result');
  const top = res.results[0];
  check('reencoded query hits song-2', top && top.songId === ids[2],
    top ? 'songId=' + top.songId + ' score=' + top.score + ' matchMs=' + res.matchMs.toFixed(1) : 'none');
  check('segments present', top && top.segments.length > 0 &&
    top.segments[0].qEnd - top.segments[0].qStart >= 15,
    top ? JSON.stringify(top.segments[0]) : 'none');

  // 删除后不再命中
  await FpDB.deleteSong(ids[2]);
  send({ type: 'remove', songId: ids[2] });
  send({ type: 'query', pcm: degraded.buffer, requestId: 3 });
  const res2 = await waitFor('result');
  const stillThere = res2.results.some((r) => r.songId === ids[2]);
  check('deleted song no longer matches', !stillThere);

  // 曲库自查：互不相同的歌不应有重复对
  send({ type: 'scan' });
  const scan = await waitFor('scan-done', 30000);
  check('library scan finds no false pairs', scan.pairs.length === 0,
    'pairs=' + scan.pairs.length + ' scanMs=' + scan.scanMs);

  // 导入重复歌曲后扫描应发现
  const dupId = await importSong(simulateReencode(songs[0], sr, 3500, 0.02, 0.9), 'song-0-copy');
  send({ type: 'scan' });
  const scan2 = await waitFor('scan-done', 30000);
  const found = scan2.pairs.some((p) =>
    (p.a === ids[0] && p.b === dupId) || (p.a === dupId && p.b === ids[0]));
  check('scan detects imported duplicate', found,
    'pairs=' + JSON.stringify(scan2.pairs.map((p) => [p.a, p.b, p.score])));

  console.log(failures === 0 ? '\nINTEGRATION: ALL PASSED' : '\nINTEGRATION: ' + failures + ' FAILED');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
