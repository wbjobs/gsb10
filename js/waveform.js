export function drawWaveform(canvas, waveform, options = {}) {
  const ctx = canvas.getContext('2d');
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

  const bins = waveform.length / 2;
  const min = waveform.subarray(0, bins);
  const max = waveform.subarray(bins);
  const middle = height / 2;

  ctx.clearRect(0, 0, width, height);

  for (const segment of options.segments ?? []) {
    const start = Math.max(0, segment.start * width);
    const end = Math.min(width, segment.end * width);
    ctx.fillStyle = segment.color ?? 'rgba(245, 158, 11, 0.30)';
    ctx.fillRect(start, 0, Math.max(1, end - start), height);
  }

  const baseline = ctx.createLinearGradient(0, 0, 0, height);
  baseline.addColorStop(0, '#93c5fd');
  baseline.addColorStop(0.5, '#60a5fa');
  baseline.addColorStop(1, '#2563eb');

  ctx.fillStyle = options.color ?? baseline;
  const barWidth = Math.max(1, width / bins);
  for (let i = 0; i < bins; i++) {
    const x = (i / bins) * width;
    const low = middle + min[i] * (height * 0.46);
    const high = middle - max[i] * (height * 0.46);
    ctx.fillRect(x, high, barWidth, Math.max(1, low - high));
  }

  const position = options.currentTime !== undefined && options.duration
    ? options.currentTime / options.duration
    : 0;
  if (position > 0) {
    ctx.fillStyle = 'rgba(15, 23, 42, 0.14)';
    ctx.fillRect(0, 0, position * width, height);
    ctx.strokeStyle = '#f97316';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(position * width, 0);
    ctx.lineTo(position * width, height);
    ctx.stroke();
  }
}

export function timeFromCanvasEvent(event, canvas, duration) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.min(rect.width, Math.max(0, event.clientX - rect.left));
  return (x / rect.width) * duration;
}
