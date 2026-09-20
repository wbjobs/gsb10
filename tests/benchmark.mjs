import { fingerprintAudio } from '../js/fingerprint.js';
import { buildInvertedIndex, hydrateIndex, queryIndex } from '../js/index.js';

const sr = 8000;
const duration = Number(process.argv[2] || 20);
const tracks = Number(process.argv[3] || 100);
const length = sr * duration;

function pseudo(seed, index) {
  const x = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function noteFrequency(seed, time) {
  const stepIndex = Math.floor(time * 2);
  const scale = [0, 2, 3, 5, 7, 8, 10];
  const note = scale[Math.floor(pseudo(seed, stepIndex) * scale.length)] + Math.floor(pseudo(seed, stepIndex + 97) * 3) * 12;
  return 110 * Math.pow(2, note / 12);
}

function music(seed, degraded = false) {
  return Float32Array.from({ length }, (_, i) => {
    const t = i / sr;
    const f1 = noteFrequency(seed, t);
    const f2 = f1 * (1.498 + pseudo(seed, 11) * 0.012);
    const f3 = f1 * (2.003 + pseudo(seed, 23) * 0.018);
    const envelope = 0.75 + 0.25 * Math.sin(2 * Math.PI * (0.5 + pseudo(seed, 5) * 2) * t);
    let value = (
      Math.sin(2 * Math.PI * (f1 + 4 * Math.sin(t * (0.7 + pseudo(seed, 7)))) * t)
      + 0.45 * Math.sin(2 * Math.PI * f2 * t)
      + 0.25 * Math.sin(2 * Math.PI * f3 * t)
    ) * envelope;
    if (degraded) value = Math.tanh(value * 1.12) + (Math.random() - 0.5) * 0.02;
    return value;
  });
}

const fingerprints = [];
let fingerprintMs = 0;
for (let id = 1; id <= tracks; id++) {
  const started = performance.now();
  fingerprints.push({ trackId: id, ...fingerprintAudio(music(id)) });
  fingerprintMs += performance.now() - started;
}
const query = fingerprintAudio(music(1, true));

const buildStarted = performance.now();
const stored = buildInvertedIndex(fingerprints);
const buildMs = performance.now() - buildStarted;
const index = hydrateIndex(stored);

const queryStarted = performance.now();
const matches = queryIndex(index, query, { excludeTrackId: 101 });
const queryMs = performance.now() - queryStarted;
const heap = process.memoryUsage().heapUsed;
const totalHashes = fingerprints.reduce((sum, item) => sum + item.hashCount, 0);
console.log(JSON.stringify({
  tracks,
  durationSeconds: duration,
  totalHashes,
  fingerprintMs,
  buildMs,
  queryMs,
  heapMB: Math.round(heap / 1024 / 1024),
  estimatedIndexMB: Math.round((totalHashes * 8 + stored.offsets.byteLength) / 1024 / 1024),
  best: matches[0] && { trackId: matches[0].trackId, score: matches[0].score, votes: matches[0].votes, segments: matches[0].segments.length },
}, null, 2));
