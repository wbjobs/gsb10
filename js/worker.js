/* worker.js - 后台线程：指纹计算、倒排索引维护、比对、曲库自查
 * 索引常驻内存（排序 BigUint64 数组，8B/条），指纹持久化在 IndexedDB，
 * 启动时从 IndexedDB 重建索引。
 */
importScripts('dsp.js', 'db.js');

var index = new DSP.FingerprintIndex();
var deletedIds = new Set();
var fpCache = new Map(); // songId -> {hashes, times}（供曲库自查使用）
var ready = false;

function post(msg, transfer) {
  if (transfer) self.postMessage(msg, transfer);
  else self.postMessage(msg);
}

function loadIndex() {
  return FpDB.getAllFps().then(function (all) {
    var t0 = Date.now();
    all.forEach(function (rec) {
      index.addSong(rec.songId, rec.hashes, rec.times);
      fpCache.set(rec.songId, { hashes: rec.hashes, times: rec.times });
    });
    index.ensureSorted();
    ready = true;
    return Date.now() - t0;
  });
}

function doFingerprint(pcm) {
  return DSP.fingerprint(pcm);
}

function doQuery(pcm, excludeSongId) {
  var t0 = Date.now();
  var fp = doFingerprint(pcm);
  var t1 = Date.now();
  var results = index.query(fp.hashes, fp.times, {
    excludeSongId: excludeSongId == null ? -1 : excludeSongId,
    deletedIds: deletedIds,
  });
  var t2 = Date.now();
  return {
    results: results,
    frames: fp.frames,
    fpMs: t1 - t0,
    matchMs: t2 - t1,
  };
}

self.onmessage = function (e) {
  var msg = e.data;
  switch (msg.type) {
    case 'load':
      loadIndex().then(function (ms) {
        post({
          type: 'ready',
          loadMs: ms,
          entries: index.entryCount,
          indexBytes: index.memoryBytes(),
        });
      });
      break;

    case 'fingerprint': {
      var pcm = new Float32Array(msg.pcm);
      var fp = doFingerprint(pcm);
      post({
        type: 'fingerprinted',
        requestId: msg.requestId,
        hashes: fp.hashes,
        times: fp.times,
        frames: fp.frames,
      }, [fp.hashes.buffer, fp.times.buffer]);
      break;
    }

    case 'index-add': {
      var hashes = new Uint32Array(msg.hashes);
      var times = new Uint32Array(msg.times);
      deletedIds.delete(msg.songId);
      index.addSong(msg.songId, hashes, times);
      fpCache.set(msg.songId, { hashes: hashes, times: times });
      index.ensureSorted();
      post({
        type: 'indexed',
        songId: msg.songId,
        entries: index.entryCount,
        indexBytes: index.memoryBytes(),
      });
      break;
    }

    case 'query': {
      var q = doQuery(new Float32Array(msg.pcm), msg.excludeSongId);
      post({
        type: 'result',
        requestId: msg.requestId,
        results: q.results,
        frames: q.frames,
        fpMs: q.fpMs,
        matchMs: q.matchMs,
        entries: index.entryCount,
        indexBytes: index.memoryBytes(),
      });
      break;
    }

    case 'remove':
      deletedIds.add(msg.songId);
      fpCache.delete(msg.songId);
      break;

    case 'reset':
      deletedIds.clear();
      fpCache.clear();
      index = new DSP.FingerprintIndex();
      break;

    case 'scan': {
      // 曲库自查：每首歌对全库比对（排除自身），找出跨歌曲重复片段
      var ids = Array.from(fpCache.keys()).filter(function (id) {
        return !deletedIds.has(id);
      });
      var pairs = [];
      var t0 = Date.now();
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        var rec = fpCache.get(id);
        var res = index.query(rec.hashes, rec.times, {
          excludeSongId: id,
          deletedIds: deletedIds,
        });
        res.forEach(function (r) {
          if (r.songId > id) {
            pairs.push({ a: id, b: r.songId, score: r.score, segments: r.segments });
          }
        });
        if (i % 5 === 0) {
          post({ type: 'scan-progress', done: i + 1, total: ids.length });
        }
      }
      post({
        type: 'scan-done',
        pairs: pairs,
        scanMs: Date.now() - t0,
        entries: index.entryCount,
        indexBytes: index.memoryBytes(),
      });
      break;
    }

    case 'stats':
      post({
        type: 'stats',
        entries: index.entryCount,
        indexBytes: index.memoryBytes(),
        cachedSongs: fpCache.size,
      });
      break;
  }
};
