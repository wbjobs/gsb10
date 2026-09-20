const DB_NAME = 'audio-fingerprint-library';
const DB_VERSION = 1;

const STORES = {
  tracks: 'tracks',
  fingerprints: 'fingerprints',
  meta: 'meta',
  indexChunks: 'indexChunks',
};

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORES.tracks)) {
        db.createObjectStore(STORES.tracks, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.fingerprints)) {
        db.createObjectStore(STORES.fingerprints, { keyPath: 'trackId' });
      }
      if (!db.objectStoreNames.contains(STORES.meta)) {
        db.createObjectStore(STORES.meta, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORES.indexChunks)) {
        db.createObjectStore(STORES.indexChunks, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transaction(db, names, mode = 'readonly') {
  return db.transaction(names, mode);
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function doneToPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function putTrack(track) {
  const db = await openDatabase();
  try {
    const tx = transaction(db, [STORES.tracks], 'readwrite');
    tx.objectStore(STORES.tracks).put(track);
    await doneToPromise(tx);
  } finally {
    db.close();
  }
}

export async function getTrack(id) {
  const db = await openDatabase();
  try {
    const tx = transaction(db, [STORES.tracks]);
    return await requestToPromise(tx.objectStore(STORES.tracks).get(id));
  } finally {
    db.close();
  }
}

export async function setTrackDuplicate(id, duplicateOf) {
  const db = await openDatabase();
  try {
    const tx = transaction(db, [STORES.tracks], 'readwrite');
    const store = tx.objectStore(STORES.tracks);
    const track = await requestToPromise(store.get(id));
    if (track) {
      track.duplicateOf = duplicateOf;
      store.put(track);
    }
    await doneToPromise(tx);
  } finally {
    db.close();
  }
}

export async function getAllTracks() {
  const db = await openDatabase();
  try {
    const tx = transaction(db, [STORES.tracks]);
    return await requestToPromise(tx.objectStore(STORES.tracks).getAll());
  } finally {
    db.close();
  }
}

export async function getAllTrackMetadata() {
  const db = await openDatabase();
  try {
    const tx = transaction(db, [STORES.tracks]);
    const records = await requestToPromise(tx.objectStore(STORES.tracks).getAll());
    return records.map(({ audio, ...track }) => track);
  } finally {
    db.close();
  }
}

export async function deleteTrackAndFingerprint(id, numericId) {
  const db = await openDatabase();
  try {
    const tx = transaction(db, [STORES.tracks, STORES.fingerprints], 'readwrite');
    tx.objectStore(STORES.tracks).delete(id);
    tx.objectStore(STORES.fingerprints).delete(numericId);
    await doneToPromise(tx);
  } finally {
    db.close();
  }
}

export async function putFingerprint(record) {
  const db = await openDatabase();
  try {
    const tx = transaction(db, [STORES.fingerprints], 'readwrite');
    tx.objectStore(STORES.fingerprints).put({
      trackId: record.trackId,
      frameCount: record.frameCount,
      peakCount: record.peakCount,
      hashCount: record.hashCount,
      hashes: record.hashes.buffer,
      anchorTimes: record.anchorTimes.buffer,
    });
    await doneToPromise(tx);
  } finally {
    db.close();
  }
}

export async function getAllFingerprints() {
  const db = await openDatabase();
  try {
    const tx = transaction(db, [STORES.fingerprints]);
    const records = await requestToPromise(tx.objectStore(STORES.fingerprints).getAll());
    return records.map((record) => ({
      trackId: record.trackId,
      frameCount: record.frameCount,
      peakCount: record.peakCount,
      hashCount: record.hashCount,
      hashes: new Uint32Array(record.hashes),
      anchorTimes: new Uint32Array(record.anchorTimes),
    }));
  } finally {
    db.close();
  }
}

export async function getMeta(key, fallback) {
  const db = await openDatabase();
  try {
    const tx = transaction(db, [STORES.meta]);
    const value = await requestToPromise(tx.objectStore(STORES.meta).get(key));
    return value ? value.value : fallback;
  } finally {
    db.close();
  }
}

export async function putMeta(key, value) {
  const db = await openDatabase();
  try {
    const tx = transaction(db, [STORES.meta], 'readwrite');
    tx.objectStore(STORES.meta).put({ key, value });
    await doneToPromise(tx);
  } finally {
    db.close();
  }
}

const CHUNK_BYTES = 1_000_000;

function arrayChunks(buffer, part) {
  const view = new Uint8Array(buffer);
  const chunks = [];
  for (let start = 0; start < view.length; start += CHUNK_BYTES) {
    chunks.push(view.slice(start, start + CHUNK_BYTES).buffer);
  }
  return chunks.map((data, index) => ({ key: `${part}:${index}`, part, index, data }));
}

export async function saveIndex(index) {
  const db = await openDatabase();
  try {
    const tx = transaction(db, [STORES.indexChunks, STORES.meta], 'readwrite');
    const indexStore = tx.objectStore(STORES.indexChunks);
    const metaStore = tx.objectStore(STORES.meta);
    await requestToPromise(indexStore.clear());

    for (const part of ['keys', 'payloads', 'offsets']) {
      for (const chunk of arrayChunks(index[part], part)) {
        indexStore.put(chunk);
      }
    }
    metaStore.put({
      key: 'indexInfo',
      value: {
        version: index.version,
        trackCount: index.trackCount,
        totalHashes: index.totalHashes,
        lengths: {
          keys: index.keys.byteLength,
          payloads: index.payloads.byteLength,
          offsets: index.offsets.byteLength,
        },
      },
    });
    await doneToPromise(tx);
  } finally {
    db.close();
  }
}

export async function loadIndex() {
  const db = await openDatabase();
  try {
    const tx = transaction(db, [STORES.indexChunks, STORES.meta]);
    const meta = await requestToPromise(tx.objectStore(STORES.meta).get('indexInfo'));
    if (!meta) return null;

    const info = meta.value;
    const chunks = await requestToPromise(tx.objectStore(STORES.indexChunks).getAll());
    const parts = {};
    for (const part of ['keys', 'payloads', 'offsets']) {
      const partChunks = chunks
        .filter((chunk) => chunk.part === part)
        .sort((a, b) => a.index - b.index);
      const buffer = new ArrayBuffer(info.lengths[part]);
      const view = new Uint8Array(buffer);
      let offset = 0;
      for (const chunk of partChunks) {
        view.set(new Uint8Array(chunk.data), offset);
        offset += chunk.data.byteLength;
      }
      parts[part] = buffer;
    }

    return {
      version: info.version,
      trackCount: info.trackCount,
      totalHashes: info.totalHashes,
      ...parts,
    };
  } finally {
    db.close();
  }
}
