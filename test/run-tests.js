/*
 * run-tests.js - 指纹算法正确性与性能验证（Node 环境，不依赖浏览器）
 * 1. FFT 与朴素 DFT 结果一致
 */
'use strict';

const DSP = require('../js/dsp.js');
let failures = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) failures++;
}
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
    const start = Math.floor((s * n) / segments);
    const end = Math.floor(((s + 1) * n) / segments);
    const f0 = 300 + rand() * 1500;
    const f1 = f0 + (rand() - 0.5) * 1200;
    const harmonics = 2 + Math.floor(rand() * 4);
    const amps = [];
    for (let h = 0; h < harmonics; h++) amps.push(rand() * (1 / (h + 1)));
    const vibDepth = rand() * 8;
    const vibRate = 2 + rand() * 5;
    for (let i = start; i < end; i++) {
      const t = i / sr;
      const frac = (i - start) / (end - start);
      const f = f0 + (f1 - f0) * frac;
      let sample = 0;
      for (let h = 0; h < harmonics; h++) {
        const fh = f * (h + 1);
        if (fh > 5000) break;
        const phase = 2 * Math.PI * fh * t + vibDepth * Math.sin(2 * Math.PI * vibRate * t);
        sample += amps[h] * Math.sin(phase);
      }
      const env = Math.sin(Math.PI * frac);
      out[i] += sample * env * 0.2;
    }
  }
  return out;
}
function simulateReencode(pcm, sr, cutoff, noiseLevel, gain) {
  const rc = 1 / (2 * Math.PI * cutoff);
  const dt = 1 / sr;
  const alpha = dt / (rc + dt);
  const out = new Float32Array(pcm.length);
  let y = 0;
  let seed = 12345;
  for (let i = 0; i < pcm.length; i++) {
    y += alpha * (pcm[i] - y);
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const noise = (seed / 0x7fffffff - 0.5) * 2 * noiseLevel;
    out[i] = y * gain + noise;
  }
  return out;
}

function embedInNoise(song, sr, offsetSec, totalSec) {
  const n = Math.floor(totalSec * sr);
  const out = new Float32Array(n);
  let seed = 999;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (seed / 0x7fffffff - 0.5) * 0.02;
  }
  const off = Math.floor(offsetSec * sr);
  for (let i = 0; i < song.length && off + i < n; i++) out[off + i] += song[i];
  return out;
}
function testFft() {
  const N = 64;
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const rand = mulberry32(7);
  for (let i = 0; i < N; i++) { re[i] = rand() * 2 - 1; im[i] = rand() * 2 - 1; }
  const reRef = Float32Array.from(re), imRef = Float32Array.from(im);
  DSP.fftInPlace(re, im);
  let maxErr = 0;
  for (let k = 0; k < N; k++) {
    let er = 0, ei = 0;
    for (let t = 0; t < N; t++) {
      const ang = (-2 * Math.PI * k * t) / N;
      er += reRef[t] * Math.cos(ang) - imRef[t] * Math.sin(ang);
      ei += reRef[t] * Math.sin(ang) + imRef[t] * Math.cos(ang);
    }
    maxErr = Math.max(maxErr, Math.abs(er - re[k]), Math.abs(ei - im[k]));
  }
  check('FFT vs DFT', maxErr < 1e-3, 'maxErr=' + maxErr.toExponential(2));
}

function buildIndex(songs) {
  const index = new DSP.FingerprintIndex();
  const fps = songs.map((pcm, i) => {
    const fp = DSP.fingerprint(pcm);
    index.addSong(i + 1, fp.hashes, fp.times);
    return fp;
  });
  index.ensureSorted();
  return { index, fps };
}
function testMatch() {
  const sr = DSP.SAMPLE_RATE;
  const song = makeSong(42, 20, sr);
  const others = [makeSong(1, 20, sr), makeSong(2, 20, sr), makeSong(3, 20, sr)];
  const lib = buildIndex([song, ...others]);
  const index = lib.index;

  let fp = DSP.fingerprint(song);
  let res = index.query(fp.hashes, fp.times);
  check('exact match -> song1', res.length > 0 && res[0].songId === 1,
    res[0] ? 'songId=' + res[0].songId + ' score=' + res[0].score : 'no result');

  const degraded = simulateReencode(song, sr, 4000, 0.01, 0.8);
  const query = embedInNoise(degraded, sr, 7.3, 30);
  fp = DSP.fingerprint(query);
  res = index.query(fp.hashes, fp.times);
  const top = res[0];
  check('reencoded match -> song1', top && top.songId === 1,
    top ? 'songId=' + top.songId + ' score=' + top.score : 'no result');
  if (top && top.songId === 1) {
    const seg = top.segments[0];
    const okOffset = Math.abs(seg.sStart - 0) < 1.0 && Math.abs(seg.qStart - 7.3) < 1.0;
    check('segment located', okOffset,
      'q=[' + seg.qStart.toFixed(1) + ',' + seg.qEnd.toFixed(1) + ']s s=[' +
      seg.sStart.toFixed(1) + ',' + seg.sEnd.toFixed(1) + ']s');
  }
  const stranger = makeSong(777, 15, sr);
  fp = DSP.fingerprint(stranger);
  res = index.query(fp.hashes, fp.times);
  check('stranger rejected', res.length === 0 || res[0].score < 30,
    res[0] ? 'topScore=' + res[0].score : 'no match');
}
function testPerf() {
  const sr = DSP.SAMPLE_RATE;
  const N_SONGS = 100;
  const SECONDS = 30;
  console.log('building ' + N_SONGS + ' x ' + SECONDS + 's library...');
  const songs = [];
  for (let i = 0; i < N_SONGS; i++) songs.push(makeSong(1000 + i, SECONDS, sr));
  const t0 = Date.now();
  const lib = buildIndex(songs);
  const index = lib.index;
  const fps = lib.fps;
  const buildMs = Date.now() - t0;
  const indexMB = index.memoryBytes() / 1048576;
  console.log('  fingerprint+index: ' + buildMs + 'ms, entries=' + index.entryCount +
    ', index=' + indexMB.toFixed(1) + 'MB');

  const degraded = simulateReencode(songs[49], sr, 4000, 0.01, 0.85);
  const qfp = DSP.fingerprint(degraded);
  const t1 = process.hrtime.bigint();
  const res = index.query(qfp.hashes, qfp.times);
  const queryMs = Number(process.hrtime.bigint() - t1) / 1e6;
  check('100-song query < 3000ms', queryMs < 3000, queryMs.toFixed(1) + 'ms');
  check('100-song query hits song50', res[0] && res[0].songId === 50,
    res[0] ? 'songId=' + res[0].songId + ' score=' + res[0].score : 'no result');
  check('index memory < 500MB', indexMB < 500, indexMB.toFixed(1) + 'MB');

  let crossFp = 0;
  for (let i = 0; i < 5; i++) {
    const r = index.query(fps[i].hashes, fps[i].times, { excludeSongId: i + 1 });
    if (r.length && r[0].score >= 30) crossFp++;
  }
  check('no cross false-positives', crossFp === 0, crossFp + '/5');
}

testFft();
testMatch();
testPerf();
console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' TEST(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
