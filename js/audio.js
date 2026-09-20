import { SAMPLE_RATE } from './config.js';

export async function decodeFileToMono8k(file) {
  const arrayBuffer = await file.arrayBuffer();
  return decodeArrayBufferToMono8k(arrayBuffer, file.type);
}

export async function decodeArrayBufferToMono8k(arrayBuffer, mimeType = '') {
  const originalContext = new AudioContext();
  let decoded;
  try {
    decoded = await originalContext.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    originalContext.close();
  }

  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * SAMPLE_RATE), SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const resampled = await offline.startRendering();
  return {
    samples: resampled.getChannelData(0),
    duration: decoded.duration,
    mimeType,
  };
}

export function buildWaveform(samples, bins = 720) {
  const min = new Float32Array(bins);
  const max = new Float32Array(bins);
  const width = Math.max(1, Math.floor(samples.length / bins));

  for (let bin = 0; bin < bins; bin++) {
    const start = bin * width;
    const end = Math.min(samples.length, start + width);
    let low = 0;
    let high = 0;
    for (let i = start; i < end; i++) {
      low = Math.min(low, samples[i]);
      high = Math.max(high, samples[i]);
    }
    min[bin] = low;
    max[bin] = high;
  }

  const interleaved = new Float32Array(bins * 2);
  interleaved.set(min, 0);
  interleaved.set(max, bins);
  return interleaved;
}

export function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }

  const buffer = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(buffer);
  const writeString = (offset, value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  new Int16Array(buffer, 44).set(pcm);
  return new Blob([buffer], { type: 'audio/wav' });
}

export async function sha256(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '--:--';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}
