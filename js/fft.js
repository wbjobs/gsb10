export class FFT {
  constructor(size) {
    if ((size & (size - 1)) !== 0) throw new Error('FFT size must be power of two');
    this.size = size;
    this.stages = Math.log2(size);
    this.cos = new Float32Array(size / 2);
    this.sin = new Float32Array(size / 2);
    this.reverse = new Uint32Array(size);
    for (let i = 0; i < size / 2; i++) {
      const angle = (-2 * Math.PI * i) / size;
      this.cos[i] = Math.cos(angle);
      this.sin[i] = Math.sin(angle);
    }
    for (let i = 0; i < size; i++) {
      let reversed = 0;
      for (let bit = 0; bit < this.stages; bit++) {
        reversed = (reversed << 1) | ((i >> bit) & 1);
      }
      this.reverse[i] = reversed;
    }
  }

  transform(input, real, imag, window) {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.reverse[i];
      real[i] = input[j] * window[j];
      imag[i] = 0;
    }

    for (let half = 1; half < n; half <<= 1) {
      const step = n / (half * 2);
      for (let group = 0; group < n; group += half * 2) {
        let twiddleIndex = 0;
        for (let j = 0; j < half; j++) {
          const even = group + j;
          const odd = even + half;
          const wr = this.cos[twiddleIndex];
          const wi = this.sin[twiddleIndex];
          const xr = real[odd];
          const xi = imag[odd];
          const tr = wr * xr - wi * xi;
          const ti = wr * xi + wi * xr;
          real[odd] = real[even] - tr;
          imag[odd] = imag[even] - ti;
          real[even] += tr;
          imag[even] += ti;
          twiddleIndex += step;
        }
      }
    }
  }
}

export function createHannWindow(size) {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return window;
}
