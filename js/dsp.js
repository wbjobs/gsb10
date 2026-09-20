/*
 * dsp.js - 音频指纹核心算法（浏览器 / Web Worker / Node 通用）
 *
 * 流程：单声道 PCM (11025Hz) -> 分帧加窗 -> radix-2 FFT -> 功率谱
 *      -> 每帧自适应门限谱峰提取（星座图）-> 锚点-目标点配对生成 landmark 哈希
 *
 * 哈希格式（26 bit，存入 Uint32）：[ f1:10bit ][ f2:10bit ][ dt:6bit ]
 * 索引值（32 bit）：[ songId:12bit ][ frame:20bit ]
 * 倒排索引条目（BigUint64 排序数组，8 字节/条）：(hash << 32) | value
 */
(function (global) {
  'use strict';

  var SAMPLE_RATE = 11025;
  var FFT_SIZE = 2048;
  var HOP_SIZE = 512;
  var MIN_FREQ = 250;
  var MAX_FREQ = 5000;
  var MIN_BIN = Math.max(1, Math.floor((MIN_FREQ * FFT_SIZE) / SAMPLE_RATE));
  var MAX_BIN = Math.min(FFT_SIZE / 2 - 1, Math.ceil((MAX_FREQ * FFT_SIZE) / SAMPLE_RATE));
  var PEAKS_PER_FRAME = 4;
  var PEAK_NEIGHBORHOOD = 3;
  var PEAK_REL_THRESHOLD = 1e-3;
  var FAN_OUT = 3;
  var MIN_DT = 1;
  var MAX_DT = 32;
  var MAX_POSTINGS = 20000;
  var OFFSET_TOL = 3;
  var SEGMENT_GAP = 30;
  var MAX_HASH_OCCURRENCES = 15;
  var MIN_SCORE = 12;
  var MIN_DENSITY = 4;
  var MIN_SEGMENT_SEC = 3;
  var FRAME_SEC = HOP_SIZE / SAMPLE_RATE;
  var fftTableCache = new Map();

  function getFftTables(n) {
    var tables = fftTableCache.get(n);
    if (tables) return tables;
    var levels = Math.log2(n);
    if (!Number.isInteger(levels)) throw new Error('FFT size must be power of 2');
    var bitRev = new Uint32Array(n);
    for (var i = 0; i < n; i++) {
      var rev = 0;
      for (var j = 0; j < levels; j++) rev = (rev << 1) | ((i >>> j) & 1);
      bitRev[i] = rev;
    }
    var cosTable = new Float64Array(n / 2);
    var sinTable = new Float64Array(n / 2);
    for (var k = 0; k < n / 2; k++) {
      cosTable[k] = Math.cos((2 * Math.PI * k) / n);
      sinTable[k] = Math.sin((2 * Math.PI * k) / n);
    }
    tables = { bitRev: bitRev, cosTable: cosTable, sinTable: sinTable };
    fftTableCache.set(n, tables);
    return tables;
  }
  function fftInPlace(re, im) {
    var n = re.length;
    var tables = getFftTables(n);
    var bitRev = tables.bitRev, cosTable = tables.cosTable, sinTable = tables.sinTable;
    var i, j, tmp;
    for (i = 0; i < n; i++) {
      j = bitRev[i];
      if (j > i) {
        tmp = re[i]; re[i] = re[j]; re[j] = tmp;
        tmp = im[i]; im[i] = im[j]; im[j] = tmp;
      }
    }
    for (var size = 2; size <= n; size *= 2) {
      var half = size / 2;
      var tableStep = n / size;
      var k;
      for (i = 0; i < n; i += size) {
        for (j = i, k = 0; j < i + half; j++, k += tableStep) {
          var tRe = cosTable[k] * re[j + half] + sinTable[k] * im[j + half];
          var tIm = -sinTable[k] * re[j + half] + cosTable[k] * im[j + half];
          re[j + half] = re[j] - tRe;
          im[j + half] = im[j] - tIm;
          re[j] += tRe;
          im[j] += tIm;
        }
      }
    }
  }
  var hannWindow = null;
  function getHannWindow() {
    if (!hannWindow) {
      hannWindow = new Float32Array(FFT_SIZE);
      for (var i = 0; i < FFT_SIZE; i++) {
        hannWindow[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
      }
    }
    return hannWindow;
  }

  var frameRe = new Float32Array(FFT_SIZE);
  var frameIm = new Float32Array(FFT_SIZE);
  var framePow = new Float32Array(FFT_SIZE / 2);

  function pickPeaks() {
    var frameMax = 0;
    for (var k = MIN_BIN; k <= MAX_BIN; k++) {
      if (framePow[k] > frameMax) frameMax = framePow[k];
    }
    if (frameMax <= 0) return null;
    var absThresh = frameMax * PEAK_REL_THRESHOLD;
    var candidates = [];
    for (k = MIN_BIN; k <= MAX_BIN; k++) {
      var v = framePow[k];
      if (v < absThresh) continue;
      var isMax = true;
      for (var d = 1; d <= PEAK_NEIGHBORHOOD; d++) {
        if (framePow[k - d] > v || framePow[k + d] > v) { isMax = false; break; }
      }
      if (isMax) candidates.push(k);
    }
    if (candidates.length === 0) return null;
    candidates.sort(function (a, b) { return framePow[b] - framePow[a]; });
    var top = candidates.slice(0, PEAKS_PER_FRAME);
    top.sort(function (a, b) { return a - b; });
    return top;
  }
  function packHash(f1, f2, dt) {
    return ((f1 << 16) | (f2 << 6) | dt) >>> 0;
  }

  function fingerprint(pcm) {
    var win = getHannWindow();
    var numFrames = Math.max(0, Math.floor((pcm.length - FFT_SIZE) / HOP_SIZE) + 1);
    var allPeaks = new Array(numFrames);
    for (var f = 0; f < numFrames; f++) {
      var offset = f * HOP_SIZE;
      for (var i = 0; i < FFT_SIZE; i++) {
        frameRe[i] = pcm[offset + i] * win[i];
        frameIm[i] = 0;
      }
      fftInPlace(frameRe, frameIm);
      var half = FFT_SIZE / 2;
      for (var k = 0; k < half; k++) {
        framePow[k] = frameRe[k] * frameRe[k] + frameIm[k] * frameIm[k];
      }
      allPeaks[f] = pickPeaks();
    }
    var hashes = [];
    var times = [];
    var hashCounts = new Map();
    for (var t = 0; t < numFrames; t++) {
      var anchors = allPeaks[t];
      if (!anchors) continue;
      for (var a = 0; a < anchors.length; a++) {
        var f1 = anchors[a];
        var paired = 0;
        for (var dt = MIN_DT; dt <= MAX_DT && paired < FAN_OUT; dt++) {
          var targetFrame = allPeaks[t + dt];
          if (!targetFrame) continue;
          for (var b = 0; b < targetFrame.length && paired < FAN_OUT; b++) {
            var h = packHash(f1, targetFrame[b], dt);
            var seen = hashCounts.get(h) || 0;
            if (seen < MAX_HASH_OCCURRENCES) {
              hashCounts.set(h, seen + 1);
              hashes.push(h);
              times.push(t);
            }
            paired++;
          }
        }
      }
    }
    return {
      hashes: Uint32Array.from(hashes),
      times: Uint32Array.from(times),
      frames: numFrames,
    };
  }
  function FingerprintIndex() {
    this.sorted = new BigUint64Array(0);
    this.pending = [];
    this.entryCount = 0;
  }

  FingerprintIndex.prototype.addSong = function (songId, hashes, times) {
    songEntries(songId, hashes, times, this.pending);
    this.entryCount += hashes.length;
  };

  FingerprintIndex.prototype.ensureSorted = function () {
    if (this.pending.length === 0) return;
    var pendingArr = BigUint64Array.from(this.pending, function (x) { return x; });
    pendingArr.sort();
    this.sorted = mergeSorted(this.sorted, pendingArr);
    this.pending = [];
  };

  FingerprintIndex.prototype.query = function (hashes, times, opts) {
    this.ensureSorted();
    return matchHashes(hashes, times, this.sorted, opts);
  };

  FingerprintIndex.prototype.memoryBytes = function () {
    return this.sorted.length * 8 + this.pending.length * 8;
  };
  function packValue(songId, frame) {
    return ((songId << 20) | frame) >>> 0;
  }
  function unpackSongId(value) { return value >>> 20; }
  function unpackFrame(value) { return value & 0xfffff; }

  function packEntry(hash, value) {
    return (BigInt(hash) << 32n) | BigInt(value);
  }

  function songEntries(songId, hashes, times, out) {
    for (var i = 0; i < hashes.length; i++) {
      out.push(packEntry(hashes[i], packValue(songId, times[i])));
    }
  }

  function mergeSorted(a, b) {
    var out = new BigUint64Array(a.length + b.length);
    var i = 0, j = 0, k = 0;
    while (i < a.length && j < b.length) {
      out[k++] = a[i] <= b[j] ? a[i++] : b[j++];
    }
    while (i < a.length) out[k++] = a[i++];
    while (j < b.length) out[k++] = b[j++];
    return out;
  }

  function lowerBound(index, key) {
    var lo = 0, hi = index.length;
    while (lo < hi) {
      var mid = (lo + hi) >>> 1;
      if (index[mid] < key) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  function matchHashes(qHashes, qTimes, index, opts) {
    opts = opts || {};
    var excludeSongId = opts.excludeSongId == null ? -1 : opts.excludeSongId;
    var deletedIds = opts.deletedIds || null;
    var perSong = new Map();
    for (var i = 0; i < qHashes.length; i++) {
      var hash = qHashes[i];
      var qt = qTimes[i];
      var pos = lowerBound(index, BigInt(hash) << 32n);
      var scanned = 0;
      while (pos < index.length && scanned < MAX_POSTINGS) {
        var entry = index[pos];
        if (Number(entry >> 32n) !== hash) break;
        var value = Number(entry & 0xffffffffn);
        var songId = unpackSongId(value);
        pos++; scanned++;
        if (songId === excludeSongId) continue;
        if (deletedIds && deletedIds.has(songId)) continue;
        var st = unpackFrame(value);
        var rec = perSong.get(songId);
        if (!rec) {
          rec = { qts: [], sts: [] };
          perSong.set(songId, rec);
        }
        rec.qts.push(qt);
        rec.sts.push(st);
      }
    }
    var results = [];
    for (var entry2 of perSong) {
      var songId2 = entry2[0];
      var rec2 = entry2[1];
      var best = analyzeMatches(rec2.qts, rec2.sts);
      if (best) {
        best.songId = songId2;
        results.push(best);
      }
    }
    results.sort(function (a, b) { return b.score - a.score; });
    return results;
  }
  function analyzeMatches(qts, sts) {
    var hist = new Map();
    for (var i = 0; i < qts.length; i++) {
      var off = sts[i] - qts[i];
      hist.set(off, (hist.get(off) || 0) + 1);
    }
    var bestOffset = 0, bestCount = 0;
    for (var entry of hist) {
      if (entry[1] > bestCount) { bestCount = entry[1]; bestOffset = entry[0]; }
    }
    if (bestCount < MIN_SCORE) return null;
    var hitQ = [];
    for (i = 0; i < qts.length; i++) {
      if (Math.abs(sts[i] - qts[i] - bestOffset) <= OFFSET_TOL) hitQ.push(qts[i]);
    }
    var spanSec = (hitQ[hitQ.length - 1] - hitQ[0]) * FRAME_SEC + FFT_SIZE / SAMPLE_RATE;
    var density = bestCount / spanSec;
    if (density < MIN_DENSITY) return null;
    var segments = [];
    var segStart = 0;
    var winFrames = FFT_SIZE / HOP_SIZE;
    for (i = 1; i <= hitQ.length; i++) {
      if (i === hitQ.length || hitQ[i] - hitQ[i - 1] > SEGMENT_GAP) {
        var qStart = hitQ[segStart];
        var qEnd = hitQ[i - 1];
        segments.push({
          qStart: qStart * FRAME_SEC,
          qEnd: (qEnd + winFrames) * FRAME_SEC,
          sStart: (qStart + bestOffset) * FRAME_SEC,
          sEnd: (qEnd + bestOffset + winFrames) * FRAME_SEC,
          hits: i - segStart,
        });
        segStart = i;
      }
    }
    var kept = [];
    var keptHits = 0;
    for (i = 0; i < segments.length; i++) {
      if (segments[i].qEnd - segments[i].qStart >= MIN_SEGMENT_SEC) {
        kept.push(segments[i]);
        keptHits += segments[i].hits;
      }
    }
    if (kept.length === 0) return null;
    return { score: keptHits, offset: bestOffset, density: density, segments: kept };
  }

  var api = {
    SAMPLE_RATE: SAMPLE_RATE,
    FFT_SIZE: FFT_SIZE,
    HOP_SIZE: HOP_SIZE,
    FRAME_SEC: FRAME_SEC,
    fftInPlace: fftInPlace,
    fingerprint: fingerprint,
    matchHashes: matchHashes,
    FingerprintIndex: FingerprintIndex,
    songEntries: songEntries,
    mergeSorted: mergeSorted,
    packEntry: packEntry,
    packValue: packValue,
    unpackSongId: unpackSongId,
    unpackFrame: unpackFrame,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.DSP = api;
})(typeof self !== 'undefined' ? self : globalThis);
