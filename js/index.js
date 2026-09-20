import { HASH_BITS, MAX_TRACKS, MAX_DELTA, MIN_MATCHES, TARGET_DELTA_MAX, TIME_SCALE } from './config.js';

const BUCKET_COUNT = 1 << HASH_BITS;
const BUCKET_MASK = BUCKET_COUNT - 1;
const TIME_MASK = 0xfffff;
const MAX_EVENTS = 6_000_000;
const DELTA_SLOTS = MAX_DELTA * 2 + 1;

function encodePayload(trackId, frame) {
  return (trackId << 20) | (frame & TIME_MASK);
}

export function decodePayload(payload) {
  return { trackId: payload >>> 20, frame: payload & TIME_MASK };
}

export function buildInvertedIndex(fingerprints, onProgress = () => {}) {
  let totalHashes = 0;
  for (const fingerprint of fingerprints) totalHashes += fingerprint.hashes.length;
  if (totalHashes > MAX_EVENTS) throw new Error('指纹数量超过当前库容量上限');

  const records = new BigUint64Array(totalHashes);
  let cursor = 0;
  for (let i = 0; i < fingerprints.length; i++) {
    const { trackId, hashes, anchorTimes } = fingerprints[i];
    for (let j = 0; j < hashes.length; j++) {
      const key = BigInt(hashes[j] >>> 0);
      const payload = BigInt(encodePayload(trackId, anchorTimes[j]) >>> 0);
      records[cursor++] = (key << 32n) | payload;
    }
    onProgress({ phase: 'collect', done: i + 1, total: fingerprints.length });
  }

  records.sort();
  const keys = new Uint32Array(totalHashes);
  const payloads = new Uint32Array(totalHashes);
  const offsets = new Uint32Array(BUCKET_COUNT + 1);

  for (let i = 0; i < totalHashes; i++) {
    const record = records[i];
    keys[i] = Number(record >> 32n);
    payloads[i] = Number(record & 0xffffffffn);
  }

  for (let i = 0; i < totalHashes; i++) offsets[(keys[i] & BUCKET_MASK) + 1]++;
  for (let bucket = 0; bucket < BUCKET_COUNT; bucket++) {
    offsets[bucket + 1] += offsets[bucket];
  }

  return {
    version: 1,
    trackCount: fingerprints.length,
    totalHashes,
    keys: keys.buffer,
    payloads: payloads.buffer,
    offsets: offsets.buffer,
  };
}

export function hydrateIndex(stored) {
  return {
    version: stored.version,
    trackCount: stored.trackCount,
    totalHashes: stored.totalHashes,
    keys: new Uint32Array(stored.keys),
    payloads: new Uint32Array(stored.payloads),
    offsets: new Uint32Array(stored.offsets),
  };
}

function hashVariants(hash) {
  const first = (hash >>> 13) & 127;
  const second = (hash >>> 6) & 127;
  const delta = hash & 63;
  const variants = new Set();
  for (const firstOffset of [-1, 0, 1]) {
    for (const secondOffset of [-1, 0, 1]) {
      const nextFirst = first + firstOffset;
      const nextSecond = second + secondOffset;
      if (nextFirst < 0 || nextFirst > 127 || nextSecond < 0 || nextSecond > 127) continue;
      variants.add(((nextFirst << 13) | (nextSecond << 6) | delta) >>> 0);
    }
  }
  return variants;
}

function eachHit(index, query, visitor) {
  const { keys, payloads, offsets } = index;
  for (let queryIndex = 0; queryIndex < query.hashes.length; queryIndex++) {
    const queryFrame = query.anchorTimes[queryIndex];
    const variants = hashVariants(query.hashes[queryIndex]);
    for (const hash of variants) {
      const start = offsets[hash];
      const end = offsets[hash + 1];
      for (let i = start; i < end; i++) {
        if (keys[i] !== hash) continue;
        visitor(payloads[i], queryFrame, queryIndex);
      }
    }
  }
}

function eachCandidateHit(index, query, candidates, visitor) {
  const { keys, payloads, offsets } = index;
  const candidateByTrack = new Map(candidates.map((candidate) => [candidate.trackId, candidate]));
  for (let queryIndex = 0; queryIndex < query.hashes.length; queryIndex++) {
    const queryFrame = query.anchorTimes[queryIndex];
    const variants = hashVariants(query.hashes[queryIndex]);
    for (const hash of variants) {
      const start = offsets[hash];
      const end = offsets[hash + 1];
      for (let i = start; i < end; i++) {
        if (keys[i] !== hash) continue;
        const { trackId, frame } = decodePayload(payloads[i]);
        const candidate = candidateByTrack.get(trackId);
        if (candidate && queryFrame - frame === candidate.bestDelta) {
          visitor(trackId, queryFrame);
        }
      }
    }
  }
}

function makeSegments(frames, count, delta, queryDuration, trackVotes, totalQueryHashes) {
  const active = count ? frames.subarray(0, count) : frames.subarray(0, 0);
  active.sort();
  const segments = [];
  let startIndex = 0;

  for (let i = 1; i <= count; i++) {
    const gap = i === count ? Infinity : active[i] - active[i - 1];
    if (gap <= 60) continue;

    const clusterLength = i - startIndex;
    const queryStartFrame = active[startIndex];
    const queryEndFrame = active[i - 1] + TARGET_DELTA_MAX;
    startIndex = i;
    if (clusterLength < 8 || queryEndFrame - queryStartFrame < 16) continue;

    const queryStart = queryStartFrame * TIME_SCALE;
    const queryEnd = Math.min(queryDuration, queryEndFrame * TIME_SCALE);
    const referenceStart = Math.max(0, queryStart - delta * TIME_SCALE);
    const referenceEnd = Math.max(0, queryEnd - delta * TIME_SCALE);
    segments.push({ queryStart, queryEnd, referenceStart, referenceEnd, votes: clusterLength });
  }

  segments.sort((a, b) => b.votes - a.votes);
  const duplicateDuration = segments.reduce((sum, segment) => sum + Math.max(0, segment.queryEnd - segment.queryStart), 0);
  const coverage = Math.min(1, duplicateDuration / Math.max(0.1, queryDuration));
  const voteStrength = Math.min(1, trackVotes / Math.max(60, totalQueryHashes * 0.005));

  return {
    score: Math.min(1, voteStrength * 0.65 + coverage * 0.35),
    segments,
  };
}

export function queryIndex(index, query, options = {}) {
  const excludeTrackId = options.excludeTrackId ?? -1;
  const stride = DELTA_SLOTS;
  const voteArray = new Uint16Array((MAX_TRACKS + 1) * stride);
  const totals = new Uint32Array(MAX_TRACKS + 1);
  const candidateFlags = new Uint8Array(MAX_TRACKS + 1);

  eachHit(index, query, (payload, queryFrame) => {
    const { trackId, frame } = decodePayload(payload);
    if (trackId === excludeTrackId || trackId > MAX_TRACKS) return;
    const delta = queryFrame - frame;
    if (delta < -MAX_DELTA || delta > MAX_DELTA) return;
    const cell = trackId * stride + delta + MAX_DELTA;
    if (voteArray[cell] < 0xffff) voteArray[cell]++;
    totals[trackId]++;
  });

  const candidates = [];
  for (let trackId = 1; trackId <= MAX_TRACKS; trackId++) {
    if (!totals[trackId]) continue;
    let bestOffset = 0;
    let bestVotes = 0;
    const base = trackId * stride;
    for (let offset = 0; offset < stride; offset++) {
      if (voteArray[base + offset] > bestVotes) {
        bestVotes = voteArray[base + offset];
        bestOffset = offset;
      }
    }
    if (bestVotes >= MIN_MATCHES) {
      candidateFlags[trackId] = 1;
      candidates.push({ trackId, totalVotes: totals[trackId], bestDelta: bestOffset - MAX_DELTA, bestVotes });
    }
  }

  const alignedFrames = new Uint32Array(Math.min(1_000_000, query.hashes.length * candidates.length));
  const frameCounts = new Uint32Array(MAX_TRACKS + 1);
  const frameOffsets = new Uint32Array(MAX_TRACKS + 1);
  let frameCursor = 0;
  for (const candidate of candidates) {
    frameOffsets[candidate.trackId] = frameCursor;
    frameCursor += Math.min(query.hashes.length, alignedFrames.length - frameCursor);
    if (frameCursor >= alignedFrames.length) break;
  }
  eachCandidateHit(index, query, candidates, (trackId, queryFrame) => {
    const localIndex = frameCounts[trackId];
    const globalIndex = frameOffsets[trackId] + localIndex;
    if (globalIndex < alignedFrames.length) {
      alignedFrames[globalIndex] = queryFrame;
      frameCounts[trackId]++;
    }
  });

  const queryDuration = (query.frameCount || 0) * TIME_SCALE;
  const matches = [];
  for (const candidate of candidates) {
    const available = alignedFrames.length - frameOffsets[candidate.trackId];
    const result = makeSegments(
      alignedFrames.subarray(frameOffsets[candidate.trackId]),
      Math.min(frameCounts[candidate.trackId], available),
      candidate.bestDelta,
      queryDuration,
      candidate.bestVotes,
      query.hashes.length,
    );
    if (!result.segments.length) continue;
    matches.push({
      trackId: candidate.trackId,
      score: result.score,
      votes: candidate.bestVotes,
      totalVotes: candidate.totalVotes,
      segments: result.segments,
    });
  }

  return matches.sort((a, b) => b.score - a.score || b.votes - a.votes);
}
