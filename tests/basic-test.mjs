import assert from 'node:assert/strict';
import { fingerprintAudio } from '../js/fingerprint.js';
import { buildInvertedIndex, hydrateIndex, queryIndex } from '../js/index.js';

const sr = 8000;
function tone(i) {
  const t = i / sr;
  return Math.sin(2 * Math.PI * 220 * t)
    + 0.7 * Math.sin(2 * Math.PI * 440 * t)
    + 0.35 * Math.sin(2 * Math.PI * (880 + 8 * Math.sin(t * 0.4)) * t)
    + 0.0002 * Math.sin(2 * Math.PI * 90 * t);
}

const clean = Float32Array.from({ length: sr * 8 }, (_, i) => tone(i));
const degraded = Float32Array.from(clean, (value, i) => {
  const distorted = Math.tanh(value * 1.15);
  const hiss = (Math.random() - 0.5) * 0.025;
  const toneShift = 1 + 0.15 * Math.sin(2 * Math.PI * 2 * i / sr);
  return distorted * toneShift + hiss;
});

const reference = fingerprintAudio(clean);
const query = fingerprintAudio(degraded);
const stored = buildInvertedIndex([{ trackId: 1, ...reference }]);
const index = hydrateIndex(stored);
const matches = queryIndex(index, query, { excludeTrackId: 2 });

assert.ok(reference.hashCount > 160, 'reference should contain fingerprints');
assert.ok(matches.length > 0, 'degraded copy should match');
assert.equal(matches[0].trackId, 1);
assert.ok(matches[0].votes >= 12, 'matching votes should pass threshold');
assert.ok(matches[0].segments.length > 0, 'duplicate segment should be returned');
console.log(JSON.stringify({
  referenceHashes: reference.hashCount,
  queryHashes: query.hashCount,
  matches: matches.map(({ trackId, score, votes, segments }) => ({ trackId, score, votes, segments: segments.length })),
}, null, 2));
