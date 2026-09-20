import { decodeFileToMono8k, buildWaveform, encodeWav, sha256, formatBytes, formatDuration } from './audio.js';
import {
  deleteTrackAndFingerprint,
  getAllTrackMetadata,
  getTrack,
  getMeta,
  putFingerprint,
  putMeta,
  putTrack,
  setTrackDuplicate,
} from './db.js';
import { FingerprintWorker } from './worker-client.js';
import { drawWaveform, timeFromCanvasEvent } from './waveform.js';
import { MAX_TRACKS } from './config.js';

const $ = (id) => document.getElementById(id);
const worker = new FingerprintWorker();
const state = {
  tracks: [],
  query: null,
  currentMatch: null,
  recorder: null,
  recording: false,
  recordContext: null,
  recordNode: null,
  recordPort: null,
  recordChunks: [],
};

function fingerprintObject(result) {
  return result.fingerprint;
}

function cloneFingerprintForWorker(fingerprint) {
  return {
    frameCount: fingerprint.frameCount,
    hashes: new Uint32Array(fingerprint.hashes),
    anchorTimes: new Uint32Array(fingerprint.anchorTimes),
  };
}

async function nextNumericId() {
  const next = await getMeta('nextTrackId', null);
  const resolved = next ?? Math.max(0, ...state.tracks.map((track) => track.numericId)) + 1;
  if (resolved > MAX_TRACKS) throw new Error('当前单机库最多支持 4095 首，可增大 ID 编码扩容');
  await putMeta('nextTrackId', resolved + 1);
  return resolved;
}

function trackById(numericId) {
  return state.tracks.find((track) => track.numericId === numericId);
}

function trackUrl(track) {
  if (!track.objectUrl) track.objectUrl = URL.createObjectURL(track.audio);
  return track.objectUrl;
}

function estimateIndexBytes(totalHashes) {
  return totalHashes * 8 + ((1 << 20) + 1) * 4;
}

function updateStats() {
  const totalHashes = state.tracks.reduce((sum, track) => sum + (track.hashCount || 0), 0);
  $('trackCount').textContent = `${state.tracks.length} 首`;
  $('fingerprintCount').textContent = `${totalHashes.toLocaleString('zh-CN')} 指纹`;
  $('memoryEstimate').textContent = `索引峰值约 ${formatBytes(estimateIndexBytes(totalHashes) + 6_700_000)}`;
}

async function renderLibrary(scanMap = new Map()) {
  const rows = $('libraryRows');
  rows.replaceChildren();
  state.tracks.sort((a, b) => a.createdAt - b.createdAt);

  for (const track of state.tracks) {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    const duration = document.createElement('td');
    const hashes = document.createElement('td');
    const duplicate = document.createElement('td');
    const actions = document.createElement('td');

    name.textContent = track.name;
    duration.textContent = formatDuration(track.duration);
    hashes.textContent = (track.hashCount || 0).toLocaleString('zh-CN');
    const scan = scanMap.get(track.numericId) || track.duplicateOf;
    if (scan) {
      const other = trackById(scan.otherTrackId);
      const badge = document.createElement('span');
      badge.className = 'dup-badge';
      badge.textContent = `疑似：${other?.name ?? `#${scan.otherTrackId}`} · ${Math.round(scan.score * 100)}%`;
      duplicate.append(badge);
    } else {
      const badge = document.createElement('span');
      badge.className = 'none-badge';
      badge.textContent = '未发现';
      duplicate.append(badge);
    }

    const remove = document.createElement('button');
    remove.className = 'delete';
    remove.type = 'button';
    remove.textContent = '删除';
    remove.onclick = async () => {
      if (!confirm(`删除《${track.name}》及其指纹？`)) return;
      await deleteTrackAndFingerprint(track.id, track.numericId);
      state.tracks = state.tracks.filter((item) => item.id !== track.id);
      updateStats();
      await renderLibrary();
      await worker.unloadIndex();
      await worker.reindex();
    };
    actions.append(remove);

    tr.append(name, duration, hashes, duplicate, actions);
    rows.append(tr);
  }
  updateStats();
}

async function createFingerprint(samples) {
  const copy = new Float32Array(samples);
  const result = await worker.fingerprint(copy);
  return fingerprintObject(result);
}

async function processAudioBuffer({ samples, duration, name, blob, saveToLibrary }) {
  const fingerprint = await createFingerprint(samples);
  const waveform = buildWaveform(samples);

  if (!saveToLibrary) {
    return setQuery({
      name,
      duration,
      blob,
      samples,
      waveform,
      fingerprint,
    });
  }

  const data = new Uint8Array(await blob.arrayBuffer());
  const contentHash = await sha256(data.slice(0, Math.min(data.length, 4_000_000)));
  const duplicateBinary = state.tracks.find((track) => track.contentHash === contentHash);
  if (duplicateBinary && !confirm(`《${name}》与《${duplicateBinary.name}》二进制内容相同，仍要入库吗？`)) {
    return null;
  }

  const numericId = await nextNumericId();
  const track = {
    id: crypto.randomUUID(),
    numericId,
    name,
    duration,
    size: blob.size,
    mimeType: blob.type,
    contentHash,
    createdAt: Date.now(),
    frameCount: fingerprint.frameCount,
    peakCount: fingerprint.peakCount,
    hashCount: fingerprint.hashCount,
    waveform: waveform.buffer,
    audio: blob,
  };

  await putTrack(track);
  await putFingerprint({
    trackId: numericId,
    frameCount: fingerprint.frameCount,
    peakCount: fingerprint.peakCount,
    hashCount: fingerprint.hashCount,
    hashes: fingerprint.hashes,
    anchorTimes: fingerprint.anchorTimes,
  });

  state.tracks.push(track);
  await renderLibrary();
  return track;
}

async function importFiles(files, saveToLibrary) {
  let done = 0;
  for (const file of files) {
    $('libraryMessage').textContent = `处理中 ${done + 1}/${files.length}：${file.name}`;
    $('importProgress').style.width = `${(done / files.length) * 100}%`;
    try {
      const decoded = await decodeFileToMono8k(file);
      await processAudioBuffer({
        samples: decoded.samples,
        duration: decoded.duration,
        name: file.name.replace(/\.[^.]+$/, ''),
        blob: file,
        saveToLibrary,
      });
    } catch (error) {
      alert(`《${file.name}》处理失败：${error.message}`);
    }
    done++;
    $('importProgress').style.width = `${(done / files.length) * 100}%`;
  }
  $('libraryMessage').textContent = saveToLibrary ? '导入完成，正在重建索引并扫描库内重复。' : '查询音频处理完成。';
  if (saveToLibrary && state.tracks.length) {
    await worker.reindex();
    await scanLibrary();
  }
}

function objectUrlForBlob(blob) {
  return URL.createObjectURL(blob);
}

function waveformFromBuffer(buffer) {
  return buffer ? new Float32Array(buffer) : null;
}

function setQuery(query) {
  if (state.query?.url) URL.revokeObjectURL(state.query.url);
  state.query = {
    ...query,
    url: objectUrlForBlob(query.blob),
  };
  $('queryName').textContent = query.name;
  $('queryStatus').textContent = `指纹 ${query.fingerprint.hashCount.toLocaleString('zh-CN')} 个，正在比对…`;
  $('matches').replaceChildren();
  $('matchSummary').textContent = '';
  const audio = $('queryAudio');
  audio.src = state.query.url;
  drawCurrentQuery();
  return runQuery();
}

function drawCurrentQuery() {
  if (!state.query) return;
  const audio = $('queryAudio');
  const segments = state.currentMatch?.segments.map((segment) => ({
    start: segment.queryStart / state.query.duration,
    end: segment.queryEnd / state.query.duration,
  })) ?? [];
  drawWaveform($('queryWaveform'), state.query.waveform, {
    duration: state.query.duration,
    currentTime: audio.currentTime,
    segments,
  });
  $('queryTime').textContent = `${formatDuration(audio.currentTime)} / ${formatDuration(state.query.duration)}`;
}

async function runQuery() {
  if (!state.query) return;
  const started = performance.now();
  const result = await worker.query(cloneFingerprintForWorker(state.query.fingerprint));
  renderMatches(result.matches, result.elapsed, performance.now() - started);
}

function renderMatches(matches, workerElapsed, totalElapsed) {
  state.currentMatch = matches[0] ?? null;
  $('queryStatus').textContent = `比对完成：Worker ${workerElapsed.toFixed(0)} ms，端到端 ${totalElapsed.toFixed(0)} ms，索引 ${$('fingerprintCount').textContent}`;
  $('matchSummary').textContent = matches.length
    ? `找到 ${matches.length} 个候选，最佳相似度 ${Math.round(matches[0].score * 100)}%。橙色区间为重复片段。`
    : '未找到达到阈值的重复片段。';
  drawCurrentQuery();

  const container = $('matches');
  container.replaceChildren();
  for (const match of matches.slice(0, 10)) {
    const track = trackById(match.trackId);
    if (!track) continue;
    const card = document.createElement('article');
    card.className = 'match';
    const head = document.createElement('div');
    head.className = 'match-head';
    const title = document.createElement('strong');
    title.textContent = track.name;
    const score = document.createElement('span');
    score.className = 'score';
    score.textContent = `${Math.round(match.score * 100)}% · ${match.votes} 票`;
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    let ready = Promise.resolve();
    if (track.audio) audio.src = trackUrl(track);
    else ready = getTrack(track.id).then((fullTrack) => {
      track.audio = fullTrack.audio;
      audio.src = trackUrl(track);
    });

    const playSegment = document.createElement('button');
    playSegment.type = 'button';
    playSegment.className = 'secondary';
    playSegment.textContent = '定位重复段';
    playSegment.onclick = () => {
      const segment = match.segments[0];
      ready.then(() => {
        $('queryAudio').currentTime = segment.queryStart;
        audio.currentTime = segment.referenceStart;
        $('queryAudio').play();
        audio.play();
      });
    };
    head.append(title, score, playSegment);

    const canvas = document.createElement('canvas');
    const waveform = waveformFromBuffer(track.waveform);
    const drawTrack = () => drawWaveform(canvas, waveform, {
      duration: track.duration,
      currentTime: audio.currentTime,
      segments: match.segments.map((segment) => ({
        start: segment.referenceStart / track.duration,
        end: segment.referenceEnd / track.duration,
        color: 'rgba(34,197,94,.28)',
      })),
    });
    audio.addEventListener('loadedmetadata', drawTrack);
    audio.addEventListener('timeupdate', drawTrack);

    const segments = document.createElement('div');
    segments.className = 'segments';
    segments.textContent = match.segments.slice(0, 5).map((segment) =>
      `查询 ${formatDuration(segment.queryStart)}-${formatDuration(segment.queryEnd)} / 曲库 ${formatDuration(segment.referenceStart)}-${formatDuration(segment.referenceEnd)}`
    ).join('；');

    canvas.addEventListener('click', (event) => {
      audio.currentTime = timeFromCanvasEvent(event, canvas, track.duration);
    });

    card.append(head, audio, canvas, segments);
    container.append(card);
    requestAnimationFrame(drawTrack);
  }
}

async function resampleFloatTo8k(samples, inputSampleRate) {
  const duration = samples.length / inputSampleRate;
  const context = new OfflineAudioContext(1, Math.ceil(duration * 8000), 8000);
  const buffer = new AudioBuffer({ length: samples.length, numberOfChannels: 1, sampleRate: inputSampleRate });
  buffer.copyToChannel(samples, 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  const output = await context.startRendering();
  return { samples: output.getChannelData(0), duration };
}

async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  const context = new AudioContext();
  await context.audioWorklet.addModule('./recorder-processor.js');
  const node = new AudioWorkletNode(context, 'recorder-processor');
  const source = context.createMediaStreamSource(stream);
  source.connect(node);
  const silentGain = context.createGain();
  silentGain.gain.value = 0;
  node.connect(silentGain);
  silentGain.connect(context.destination);
  state.recorder = stream;
  state.recordContext = context;
  state.recordNode = node;
  state.recordPort = node.port;
  state.recordChunks = [];
  state.recordStartedAt = Date.now();
  state.recording = true;
  $('recordButton').textContent = '停止录音';
  $('recordStatus').textContent = '录音中…';

  node.port.onmessage = (event) => {
    if (event.data.samples) state.recordChunks.push(event.data.samples);
  };
}

async function stopRecording() {
  const inputRate = state.recordContext.sampleRate;
  state.recordPort.postMessage('snapshot');
  await new Promise((resolve) => setTimeout(resolve, 120));
  const length = state.recordChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const recorded = new Float32Array(length);
  let offset = 0;
  for (const chunk of state.recordChunks) {
    recorded.set(chunk, offset);
    offset += chunk.length;
  }
  state.recorder.getTracks().forEach((track) => track.stop());
  await state.recordContext.close();
  state.recording = false;
  $('recordButton').textContent = '开始录音';
  $('recordStatus').textContent = '正在处理录音…';

  const decoded = await resampleFloatTo8k(recorded, inputRate);
  const blob = encodeWav(decoded.samples);
  const saveToLibrary = $('recordAsLibrary').checked;
  await processAudioBuffer({
    samples: decoded.samples,
    duration: decoded.duration,
    name: `录音 ${new Date().toLocaleString('zh-CN')}`,
    blob,
    saveToLibrary,
  });
  $('recordStatus').textContent = '录音完成';
}

async function scanLibrary() {
  $('libraryMessage').textContent = '正在扫描库内重复片段…';
  const result = await worker.scanAll();
  const scanMap = new Map(result.results.map((item) => [item.trackId, item]));
  for (const track of state.tracks) {
    const scan = scanMap.get(track.numericId);
    const duplicateOf = scan ? {
      otherTrackId: scan.otherTrackId,
      score: scan.score,
    } : null;
    await setTrackDuplicate(track.id, duplicateOf);
    track.duplicateOf = duplicateOf;
  }
  await renderLibrary(scanMap);
  $('libraryMessage').textContent = `库扫描完成：${result.results.length} 条重复关系，扫描 ${result.elapsed.toFixed(0)} ms。`;
}

$('libraryFiles').addEventListener('change', async (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  if (files.length) await importFiles(files, true);
});

$('queryFile').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  $('queryStatus').textContent = `解码并提取指纹：${file.name}`;
  await importFiles([file], false);
});

$('recordButton').addEventListener('click', async () => {
  try {
    if (state.recording) await stopRecording();
    else await startRecording();
  } catch (error) {
    state.recording = false;
    $('recordButton').textContent = '开始录音';
    $('recordStatus').textContent = `录音失败：${error.message}`;
  }
});

$('queryWaveform').addEventListener('click', (event) => {
  if (!state.query) return;
  $('queryAudio').currentTime = timeFromCanvasEvent(event, $('queryWaveform'), state.query.duration);
});
$('queryAudio').addEventListener('timeupdate', drawCurrentQuery);
$('unloadIndex').addEventListener('click', () => {
  worker.unloadIndex();
  $('memoryEstimate').textContent = '索引已从 Worker 卸载';
});

worker.on('index:progress', (event) => {
  const total = event.total || 1;
  $('libraryMessage').textContent = `索引 ${event.phase}：${event.done}/${total}`;
});

async function init() {
  state.tracks = await getAllTrackMetadata();
  for (const track of state.tracks) {
    track.waveform = waveformFromBuffer(track.waveform);
  }
  await renderLibrary();
  $('libraryMessage').textContent = '提示：刷新后指纹和索引自动恢复；删除曲目后会自动重建索引。';
}

init().catch((error) => {
  $('libraryMessage').textContent = `初始化失败：${error.message}`;
});
