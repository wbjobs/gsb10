import { fingerprintAudio } from '../js/fingerprint.js';
import { buildInvertedIndex, hydrateIndex, queryIndex } from '../js/index.js';
import { getAllFingerprints, loadIndex, saveIndex } from '../js/db.js';

let index = null;

function post(type, payload = {}, transfer = []) {
  self.postMessage({ type, ...payload }, transfer);
}

function fingerprint(message) {
  const started = performance.now();
  const result = fingerprintAudio(new Float32Array(message.samples));
  const elapsed = performance.now() - started;
  post('fingerprint:done', {
    requestId: message.requestId,
    fingerprint: {
      frameCount: result.frameCount,
      peakCount: result.peakCount,
      hashCount: result.hashCount,
      hashes: result.hashes,
      anchorTimes: result.anchorTimes,
    },
    elapsed,
  }, [result.hashes.buffer, result.anchorTimes.buffer]);
}

async function reindex(message) {
  const started = performance.now();
  post('index:progress', { phase: 'load', done: 0, total: 0 });
  const fingerprints = await getAllFingerprints();
  const built = buildInvertedIndex(fingerprints, (progress) => post('index:progress', progress));
  post('index:progress', { phase: 'persist', done: fingerprints.length, total: fingerprints.length });
  await saveIndex(built);
  index = hydrateIndex(built);
  post('index:done', {
    requestId: message.requestId,
    trackCount: fingerprints.length,
    totalHashes: built.totalHashes,
    elapsed: performance.now() - started,
  });
}

async function ensureIndex() {
  if (!index) {
    const stored = await loadIndex();
    if (!stored) return false;
    index = hydrateIndex(stored);
  }
  return true;
}

async function query(message) {
  const started = performance.now();
  if (!(await ensureIndex())) throw new Error('指纹索引尚未构建');
  const queryFingerprint = {
    frameCount: message.fingerprint.frameCount,
    hashes: new Uint32Array(message.fingerprint.hashes),
    anchorTimes: new Uint32Array(message.fingerprint.anchorTimes),
  };
  const matches = queryIndex(index, queryFingerprint, { excludeTrackId: message.excludeTrackId ?? -1 });
  post('query:done', {
    requestId: message.requestId,
    matches,
    elapsed: performance.now() - started,
    totalHashes: index.totalHashes,
  });
}

async function scanAll(message) {
  const started = performance.now();
  post('scan:progress', { done: 0, total: 0 });
  const fingerprints = await getAllFingerprints();
  if (!(await ensureIndex()) && fingerprints.length) {
    const built = buildInvertedIndex(fingerprints);
    await saveIndex(built);
    index = hydrateIndex(built);
  }

  const results = [];
  for (let i = 0; i < fingerprints.length; i++) {
    const matches = queryIndex(index, fingerprints[i], { excludeTrackId: fingerprints[i].trackId });
    const duplicate = matches.find((match) => match.score >= 0.15 && match.votes >= 20);
    if (duplicate) {
      results.push({
        trackId: fingerprints[i].trackId,
        otherTrackId: duplicate.trackId,
        score: duplicate.score,
        votes: duplicate.votes,
        segments: duplicate.segments,
      });
    }
    post('scan:progress', { done: i + 1, total: fingerprints.length });
  }

  post('scan:done', {
    requestId: message.requestId,
    results,
    elapsed: performance.now() - started,
    totalHashes: index?.totalHashes ?? 0,
  });
}

self.onmessage = async (event) => {
  const message = event.data;
  try {
    if (message.type === 'fingerprint') fingerprint(message);
    if (message.type === 'reindex') await reindex(message);
    if (message.type === 'query') await query(message);
    if (message.type === 'scanAll') await scanAll(message);
    if (message.type === 'unloadIndex') index = null;
  } catch (error) {
    post('error', {
      requestId: message.requestId,
      action: message.type,
      message: error.message,
      stack: error.stack,
    });
  }
};
