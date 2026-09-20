/* app.js - 主线程：UI、音频解码/重采样、与 Worker 通信 */
(function () {
  'use strict';

  var SR = DSP.SAMPLE_RATE;
  var worker = new Worker('js/worker.js');
  var reqSeq = 0;
  var pending = {};
  var songsById = new Map();
  var lastQuery = null; // { name, duration, peaks, results }

  /* ---------------- Worker RPC ---------------- */
  worker.onmessage = function (e) {
    var msg = e.data;
    if (msg.requestId != null && pending[msg.requestId]) {
      pending[msg.requestId](msg);
      delete pending[msg.requestId];
      return;
    }
    switch (msg.type) {
      case 'ready':
        setStatus('import-status', '索引就绪：' + msg.entries + ' 条指纹，加载 ' + msg.loadMs + 'ms');
        updateStats(msg);
        break;
      case 'indexed':
        updateStats(msg);
        break;
      case 'scan-progress':
        setStatus('import-status', '扫描中 ' + msg.done + '/' + msg.total + ' ...');
        break;
      case 'scan-done':
        renderScanResults(msg);
        updateStats(msg);
        break;
    }
  };

  function callWorker(type, payload, transfer) {
    return new Promise(function (resolve) {
      var id = ++reqSeq;
      pending[id] = resolve;
      payload = payload || {};
      payload.type = type;
      payload.requestId = id;
      worker.postMessage(payload, transfer || []);
    });
  }

  /* ---------------- 音频解码 + 重采样 ---------------- */
  var audioCtx = null;

  function decodeToMonoPCM(blob) {
    return blob.arrayBuffer().then(function (buf) {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      return audioCtx.decodeAudioData(buf);
    }).then(function (audioBuf) {
      var mono = audioCtx.createBuffer(1, audioBuf.length, audioBuf.sampleRate);
      var out = mono.getChannelData(0);
      for (var ch = 0; ch < audioBuf.numberOfChannels; ch++) {
        var data = audioBuf.getChannelData(ch);
        for (var i = 0; i < data.length; i++) out[i] += data[i] / audioBuf.numberOfChannels;
      }
      var targetLen = Math.max(1, Math.ceil(audioBuf.duration * SR));
      var offline = new OfflineAudioContext(1, targetLen, SR);
      var src = offline.createBufferSource();
      src.buffer = mono;
      src.connect(offline.destination);
      src.start();
      return offline.startRendering();
    }).then(function (rendered) {
      return rendered.getChannelData(0);
    });
  }

  function computePeaks(pcm, buckets) {
    buckets = buckets || 1000;
    var peaks = new Float32Array(buckets);
    var per = pcm.length / buckets;
    for (var b = 0; b < buckets; b++) {
      var start = Math.floor(b * per);
      var end = Math.min(pcm.length, Math.floor((b + 1) * per));
      var max = 0;
      for (var i = start; i < end; i += 4) {
        var v = Math.abs(pcm[i]);
        if (v > max) max = v;
      }
      peaks[b] = max;
    }
    return peaks;
  }

  /* ---------------- 曲库 ---------------- */
  function refreshLibrary() {
    return FpDB.getAllSongs().then(function (songs) {
      songsById = new Map(songs.map(function (s) { return [s.id, s]; }));
      document.getElementById('stat-songs').textContent = '曲目 ' + songs.length;
      var tbody = document.querySelector('#song-table tbody');
      tbody.innerHTML = '';
      songs.forEach(function (s) {
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td>' + s.id + '</td><td>' + escapeHtml(s.name) + '</td>' +
          '<td>' + fmtTime(s.duration) + '</td><td>' + s.hashCount + '</td>' +
          '<td>' + new Date(s.createdAt).toLocaleString() + '</td>';
        var td = document.createElement('td');
        var btn = document.createElement('button');
        btn.textContent = '删除';
        btn.className = 'del';
        btn.onclick = function () { deleteSong(s.id); };
        td.appendChild(btn);
        tr.appendChild(td);
        tbody.appendChild(tr);
      });
    });
  }

  function importFiles(files) {
    var list = Array.from(files);
    var done = 0;
    document.getElementById('btn-import').disabled = true;
    (function next() {
      if (done >= list.length) {
        document.getElementById('btn-import').disabled = false;
        setStatus('import-status', '导入完成');
        refreshLibrary();
        return;
      }
      var file = list[done];
      setStatus('import-status', '处理中 (' + (done + 1) + '/' + list.length + ') ' + file.name);
      decodeToMonoPCM(file).then(function (pcm) {
        var peaks = computePeaks(pcm);
        var duration = pcm.length / SR;
        return callWorker('fingerprint', { pcm: pcm.buffer }, [pcm.buffer]).then(function (fp) {
          var meta = {
            name: file.name, duration: duration,
            hashCount: fp.hashes.length, createdAt: Date.now(), peaks: peaks,
          };
          return FpDB.addSong(meta).then(function (songId) {
            return FpDB.putFp(songId, fp.hashes, fp.times).then(function () {
              worker.postMessage({
                type: 'index-add', songId: songId,
                hashes: fp.hashes.buffer, times: fp.times.buffer,
              }, [fp.hashes.buffer, fp.times.buffer]);
            });
          });
        });
      }).then(function () {
        done++;
        next();
      }).catch(function (err) {
        console.error(err);
        setStatus('import-status', '导入失败: ' + file.name + ' - ' + err.message);
        done++;
        next();
      });
    })();
  }

  function deleteSong(id) {
    FpDB.deleteSong(id).then(function () {
      worker.postMessage({ type: 'remove', songId: id });
      refreshLibrary();
    });
  }

  /* ---------------- 查询 ---------------- */
  function runQuery(blob, name) {
    setStatus('query-status', '解码中: ' + name);
    return decodeToMonoPCM(blob).then(function (pcm) {
      var peaks = computePeaks(pcm);
      var duration = pcm.length / SR;
      setStatus('query-status', '比对中...');
      var t0 = performance.now();
      return callWorker('query', { pcm: pcm.buffer }, [pcm.buffer]).then(function (res) {
        var totalMs = performance.now() - t0;
        lastQuery = { name: name, duration: duration, peaks: peaks, results: res.results };
        updateStats(res);
        document.getElementById('stat-query').textContent =
          '上次比对 ' + res.matchMs.toFixed(1) + 'ms (含指纹 ' + totalMs.toFixed(0) + 'ms)';
        setStatus('query-status',
          name + ' (' + fmtTime(duration) + ') - ' +
          (res.results.length ? '发现 ' + res.results.length + ' 首重复' : '未发现重复'));
        renderResults(res.results);
      });
    }).catch(function (err) {
      console.error(err);
      setStatus('query-status', '查询失败: ' + err.message);
    });
  }

  function renderResults(results) {
    var box = document.getElementById('results');
    box.innerHTML = '';
    document.getElementById('compare-view').style.display = 'none';
    results.forEach(function (r) {
      var song = songsById.get(r.songId);
      var card = document.createElement('div');
      card.className = 'match-card';
      var segs = r.segments.map(function (s) {
        return '<span>查询 <b class="seg-hl">' + fmtTime(s.qStart) + ' - ' + fmtTime(s.qEnd) +
          '</b> ↔ 库内 <b class="seg-hl">' + fmtTime(s.sStart) + ' - ' + fmtTime(s.sEnd) +
          '</b> (' + s.hits + ' 命中)</span>';
      }).join('');
      card.innerHTML =
        '<div class="title"><b>' + escapeHtml(song ? song.name : ('#' + r.songId)) + '</b>' +
        '<span class="badge">重复 · 得分 ' + r.score + ' · 密度 ' + r.density.toFixed(1) + '/s</span></div>' +
        '<div class="segs">' + segs + '</div>';
      card.onclick = function () { showCompare(r); };
      box.appendChild(card);
    });
  }

  /* ---------------- 波形对比高亮 ---------------- */
  function showCompare(match) {
    if (!lastQuery) return;
    var song = songsById.get(match.songId);
    if (!song) return;
    document.getElementById('compare-view').style.display = 'block';
    drawWave(document.getElementById('wave-query'), lastQuery.peaks, lastQuery.duration,
      match.segments.map(function (s) { return [s.qStart, s.qEnd]; }),
      '查询: ' + lastQuery.name);
    drawWave(document.getElementById('wave-song'), song.peaks, song.duration,
      match.segments.map(function (s) { return [s.sStart, s.sEnd]; }),
      '库内: ' + song.name);
  }

  function drawWave(canvas, peaks, duration, highlights, label) {
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#101728';
    ctx.fillRect(0, 0, W, H);
    highlights.forEach(function (hl) {
      var x0 = (hl[0] / duration) * W;
      var x1 = (hl[1] / duration) * W;
      ctx.fillStyle = 'rgba(255, 90, 90, 0.25)';
      ctx.fillRect(x0, 0, x1 - x0, H);
    });
    ctx.fillStyle = '#4d7cff';
    var mid = H / 2;
    for (var i = 0; i < peaks.length; i++) {
      var x = (i / peaks.length) * W;
      var h = Math.max(1, peaks[i] * (H - 18));
      ctx.fillRect(x, mid - h / 2, Math.max(1, W / peaks.length - 0.5), h);
    }
    ctx.fillStyle = '#8b96b0';
    ctx.font = '11px sans-serif';
    ctx.fillText(label + '  [' + fmtTime(duration) + ']', 8, 14);
    ctx.fillStyle = '#ff5a5a';
    highlights.forEach(function (hl) {
      var x0 = (hl[0] / duration) * W;
      ctx.fillText(fmtTime(hl[0]), Math.min(x0, W - 40), H - 6);
    });
  }

  /* ---------------- 录音 ---------------- */
  var recorder = null;
  var recChunks = [];
  var recMode = null;

  function toggleRecord(mode, btn) {
    if (recorder) {
      recorder.stop();
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      recChunks = [];
      recMode = mode;
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = function (e) { recChunks.push(e.data); };
      recorder.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        btn.classList.remove('recording');
        btn.textContent = mode === 'query' ? '录音查询' : '录音入库';
        var blob = new Blob(recChunks, { type: recorder.mimeType });
        recorder = null;
        var name = '录音 ' + new Date().toLocaleTimeString();
        if (recMode === 'query') {
          runQuery(blob, name);
        } else {
          var file = new File([blob], name + '.webm', { type: blob.type });
          importFiles([file]);
        }
      };
      recorder.start();
      btn.classList.add('recording');
      btn.textContent = '停止录音';
    }).catch(function (err) {
      setStatus('query-status', '无法访问麦克风: ' + err.message);
    });
  }

  /* ---------------- 扫描 ---------------- */
  function scanLibrary() {
    document.getElementById('btn-scan').disabled = true;
    setStatus('import-status', '扫描中...');
    worker.postMessage({ type: 'scan' });
  }

  function renderScanResults(msg) {
    document.getElementById('btn-scan').disabled = false;
    setStatus('import-status', '扫描完成，耗时 ' + msg.scanMs + 'ms，发现 ' + msg.pairs.length + ' 对重复');
    var box = document.getElementById('scan-results');
    box.innerHTML = '';
    msg.pairs.forEach(function (p) {
      var a = songsById.get(p.a);
      var b = songsById.get(p.b);
      var card = document.createElement('div');
      card.className = 'match-card';
      var segs = p.segments.map(function (s) {
        return '<span><b class="seg-hl">' + fmtTime(s.qStart) + ' - ' + fmtTime(s.qEnd) +
          '</b> ↔ <b class="seg-hl">' + fmtTime(s.sStart) + ' - ' + fmtTime(s.sEnd) + '</b></span>';
      }).join('');
      card.innerHTML =
        '<div class="title"><b>' + escapeHtml(a ? a.name : '#' + p.a) + ' ↔ ' +
        escapeHtml(b ? b.name : '#' + p.b) + '</b>' +
        '<span class="badge">得分 ' + p.score + '</span></div>' +
        '<div class="segs">' + segs + '</div>';
      box.appendChild(card);
    });
  }

  /* ---------------- 工具 ---------------- */
  function setStatus(id, text) {
    document.getElementById(id).textContent = text;
  }
  function fmtTime(sec) {
    var m = Math.floor(sec / 60);
    var s = sec - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function updateStats(msg) {
    if (msg.entries != null) {
      document.getElementById('stat-entries').textContent = '指纹 ' + msg.entries;
    }
    if (msg.indexBytes != null) {
      document.getElementById('stat-index').textContent =
        '索引 ' + (msg.indexBytes / 1048576).toFixed(1) + ' MB';
    }
  }
  setInterval(function () {
    if (performance.memory) {
      document.getElementById('stat-heap').textContent =
        '堆内存 ' + (performance.memory.usedJSHeapSize / 1048576).toFixed(0) + ' MB';
    }
  }, 2000);

  /* ---------------- 事件绑定 ---------------- */
  document.getElementById('btn-import').onclick = function () {
    document.getElementById('file-import').click();
  };
  document.getElementById('file-import').onchange = function (e) {
    if (e.target.files.length) importFiles(e.target.files);
    e.target.value = '';
  };
  document.getElementById('btn-query-file').onclick = function () {
    document.getElementById('file-query').click();
  };
  document.getElementById('file-query').onchange = function (e) {
    if (e.target.files.length) runQuery(e.target.files[0], e.target.files[0].name);
    e.target.value = '';
  };
  document.getElementById('btn-record-query').onclick = function () {
    toggleRecord('query', this);
  };
  document.getElementById('btn-record-add').onclick = function () {
    toggleRecord('add', this);
  };
  document.getElementById('btn-scan').onclick = scanLibrary;
  document.getElementById('btn-clear').onclick = function () {
    if (!confirm('确定清空整个曲库？')) return;
    FpDB.clearAll().then(function () {
      worker.postMessage({ type: 'reset' });
      refreshLibrary();
      document.getElementById('scan-results').innerHTML = '';
      document.getElementById('results').innerHTML = '';
      updateStats({ entries: 0, indexBytes: 0 });
    });
  };

  /* ---------------- 启动 ---------------- */
  refreshLibrary();
  worker.postMessage({ type: 'load' });
})();
