import { FFT, createHannWindow } from './fft.js';
import {
  ANCHOR_FRAME_STRIDE,
  ANCHOR_PEAK_STRIDE,
  BAND_COUNT,
  FFT_SIZE,
  HOP_SIZE,
  MAX_BIN,
  MAX_TARGETS_PER_ANCHOR,
  MIN_BIN,
  PEAKS_PER_BAND,
  TARGET_DELTA_MAX,
  TARGET_DELTA_MIN,
} from './config.js';

const BANDS = Array.from({ length: BAND_COUNT + 1 }, (_, index) => {
  if (index === 0) return MIN_BIN;
  if (index === BAND_COUNT) return MAX_BIN;
  return MIN_BIN + Math.round(((MAX_BIN - MIN_BIN) * index) / BAND_COUNT);
});

function bandForBin(bin) {
  for (let band = 0; band < BAND_COUNT; band++) {
    if (bin >= BANDS[band] && bin < BANDS[band + 1]) return band;
  }
  return -1;
}

function insertPeak(topBins, topMags, bin, magnitude) {
  let slot = topBins.length;
  while (slot > 0 && magnitude > topMags[slot - 1]) slot--;
  if (slot >= topBins.length) return;
  for (let j = topBins.length - 1; j > slot; j--) {
    topBins[j] = topBins[j - 1];
    topMags[j] = topMags[j - 1];
  }
  topBins[slot] = bin;
  topMags[slot] = magnitude;
}

function isLocalPeak(ring, centerIndex, bin, frameCountInRing) {
  const center = ring[centerIndex][bin];
  let strongestOther = 0;
  let strongestSpectral = 0;
  let neighborhoodSum = 0;
  let neighborhoodCount = 0;

  for (const offset of [-2, 2]) {
    if (centerIndex + offset < 0 || centerIndex + offset >= frameCountInRing) continue;
    const value = ring[centerIndex + offset][bin];
    strongestOther = Math.max(strongestOther, value);
    neighborhoodSum += value;
    neighborhoodCount++;
  }

  for (const freqOffset of [-2, 2]) {
    const neighborBin = bin + freqOffset;
    if (neighborBin < MIN_BIN || neighborBin >= MAX_BIN) continue;
    const value = ring[centerIndex][neighborBin];
    strongestSpectral = Math.max(strongestSpectral, value);
    neighborhoodSum += value;
    neighborhoodCount++;
  }

  const neighborhoodAverage = neighborhoodSum / Math.max(1, neighborhoodCount);
  return center >= strongestOther
    && center > strongestSpectral * 1.04
    && center > neighborhoodAverage * 1.55
    && center > 0.00008;
}

function encodeHash(firstBin, secondBin, deltaFrames) {
  const first = Math.min(firstBin >> 1, 127);
  const second = Math.min(secondBin >> 1, 127);
  const delta = Math.min(deltaFrames >> 1, 63);
  return (first << 13) | (second << 6) | delta;
}

export function fingerprintAudio(samples) {
  const frameCount = Math.max(0, Math.floor((samples.length - FFT_SIZE) / HOP_SIZE) + 1);
  if (frameCount <= TARGET_DELTA_MAX + 4) {
    throw new Error('音频至少需要约 3 秒');
  }

  const emphasized = new Float32Array(samples.length);
  emphasized[0] = samples[0];
  for (let i = 1; i < samples.length; i++) {
    emphasized[i] = samples[i] - 0.97 * samples[i - 1];
  }

  const fft = new FFT(FFT_SIZE);
  const window = createHannWindow(FFT_SIZE);
  const real = new Float32Array(FFT_SIZE);
  const imag = new Float32Array(FFT_SIZE);
  const ring = Array.from({ length: 5 }, () => new Float32Array(FFT_SIZE / 2));

  const peakCapacity = Math.min(frameCount * PEAKS_PER_BAND * BAND_COUNT, 1_000_000);
  const peakFrames = new Uint32Array(peakCapacity);
  const peakBins = new Uint16Array(peakCapacity);
  const peakMags = new Float32Array(peakCapacity);
  const peaksPerFrame = new Uint16Array(frameCount);
  let peakCount = 0;

  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * HOP_SIZE;
    fft.transform(emphasized.subarray(start, start + FFT_SIZE), real, imag, window);
    const magnitude = ring[frame % 5];
    for (let bin = 0; bin < FFT_SIZE / 2; bin++) {
      magnitude[bin] = Math.sqrt(real[bin] * real[bin] + imag[bin] * imag[bin]);
    }

    if (frame < 4) continue;

    const centerFrame = frame - 2;
    const centerIndex = centerFrame % 5;
    const topBins = Array.from({ length: BAND_COUNT }, () => new Int32Array(PEAKS_PER_BAND).fill(-1));
    const topMags = Array.from({ length: BAND_COUNT }, () => new Float32Array(PEAKS_PER_BAND));

    for (let bin = MIN_BIN; bin < MAX_BIN; bin++) {
      if (!isLocalPeak(ring, centerIndex, bin, 5)) continue;
      const band = bandForBin(bin);
      if (band >= 0) insertPeak(topBins[band], topMags[band], bin, ring[centerIndex][bin]);
    }

    for (let band = 0; band < BAND_COUNT; band++) {
      for (let slot = 0; slot < PEAKS_PER_BAND; slot++) {
        const bin = topBins[band][slot];
        if (bin < 0 || peakCount >= peakCapacity) continue;
        peakFrames[peakCount] = centerFrame;
        peakBins[peakCount] = bin;
        peakMags[peakCount] = topMags[band][slot];
        peaksPerFrame[centerFrame]++;
        peakCount++;
      }
    }
  }

  const frameStart = new Uint32Array(frameCount + 1);
  for (let frame = 0; frame < frameCount; frame++) {
    frameStart[frame + 1] = frameStart[frame] + peaksPerFrame[frame];
  }

  const hashCapacity = Math.min(peakCount * MAX_TARGETS_PER_ANCHOR, 2_000_000);
  const hashes = new Uint32Array(hashCapacity);
  const anchorTimes = new Uint32Array(hashCapacity);
  let hashCount = 0;

  for (let anchorIndex = 0; anchorIndex < peakCount; anchorIndex++) {
    const anchorFrame = peakFrames[anchorIndex];
    const anchorBin = peakBins[anchorIndex];
    if (anchorFrame % ANCHOR_FRAME_STRIDE !== 0 || anchorIndex % ANCHOR_PEAK_STRIDE !== 0) continue;
    if (anchorFrame + TARGET_DELTA_MAX >= frameCount) continue;

    const targets = [];
    const lastFrame = Math.min(anchorFrame + TARGET_DELTA_MAX, frameCount - 1);
    for (let targetFrame = anchorFrame + TARGET_DELTA_MIN; targetFrame <= lastFrame; targetFrame++) {
      const end = frameStart[targetFrame + 1];
      for (let index = frameStart[targetFrame]; index < end; index++) {
        const bin = peakBins[index];
        if (Math.abs(bin - anchorBin) > 100) continue;
        targets.push({ frame: targetFrame, bin, magnitude: peakMags[index] });
      }
    }

    targets.sort((a, b) => b.magnitude - a.magnitude);
    const targetCount = Math.min(MAX_TARGETS_PER_ANCHOR, targets.length);
    for (let i = 0; i < targetCount && hashCount < hashCapacity; i++) {
      const target = targets[i];
      hashes[hashCount] = encodeHash(anchorBin, target.bin, target.frame - anchorFrame);
      anchorTimes[hashCount] = anchorFrame;
      hashCount++;
    }
  }

  return {
    frameCount,
    peakCount,
    hashCount,
    hashes: hashes.slice(0, hashCount),
    anchorTimes: anchorTimes.slice(0, hashCount),
  };
}
