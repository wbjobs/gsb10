export class FingerprintWorker {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.worker = new Worker('./worker/fingerprint-worker.js', { type: 'module' });
    this.worker.onmessage = (event) => this.handle(event.data);
  }

  handle(message) {
    const listener = this.listeners.get(message.type);
    if (listener) listener(message);
    const request = message.requestId ? this.pending.get(message.requestId) : null;
    if (message.type === 'error') {
      if (request) {
        request.reject(new Error(message.message));
        this.pending.delete(message.requestId);
      }
      return;
    }
    if (request && String(message.type).endsWith(':done')) {
      request.resolve(message);
      this.pending.delete(message.requestId);
    }
  }

  send(type, payload = {}, transfer = []) {
    const requestId = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage({ type, requestId, ...payload }, transfer);
    });
  }

  on(type, listener) {
    this.listeners.set(type, listener);
  }

  fingerprint(samples) {
    return this.send('fingerprint', { samples }, [samples.buffer]);
  }

  reindex() {
    return this.send('reindex');
  }

  query(fingerprint, excludeTrackId) {
    return this.send('query', { fingerprint, excludeTrackId });
  }

  scanAll() {
    return this.send('scanAll');
  }

  unloadIndex() {
    this.worker.postMessage({ type: 'unloadIndex' });
  }
}
