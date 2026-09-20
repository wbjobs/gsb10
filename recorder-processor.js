class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.port.onmessage = (event) => {
      if (event.data === 'snapshot') {
        const length = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const merged = new Float32Array(length);
        let offset = 0;
        for (const chunk of this.chunks) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        this.port.postMessage({ samples: merged }, [merged.buffer]);
      }
      if (event.data === 'reset') this.chunks = [];
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const mono = new Float32Array(input[0].length);
      const channels = input.length;
      for (let i = 0; i < mono.length; i++) {
        let sum = 0;
        for (let channel = 0; channel < channels; channel++) sum += input[channel][i];
        mono[i] = sum / channels;
      }
      this.chunks.push(mono);
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
