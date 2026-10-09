'use strict';

// libfvad is WebRTC's voice activity classifier. The WASM has no imports,
// network access or JavaScript glue; the 20 ms audio frames remain local.
class SpeechDetector {
  static async create(binary) {
    if (!binary) {
      const response = await fetch('/vendor/libfvad.wasm');
      if (!response.ok) throw new Error('Il rilevatore di voce non si è caricato. Riprova.');
      binary = await response.arrayBuffer();
    }
    const { instance } = await WebAssembly.instantiate(binary);
    instance.exports._initialize?.();
    return new SpeechDetector(instance.exports);
  }
  constructor(exports) {
    this.exports = exports;
    this.instance = exports.fvad_new();
    this.buffer = exports.malloc(640);
    if (!this.instance || !this.buffer) throw new Error('Memoria insufficiente per rilevare la voce.');
    this.reset();
  }
  reset() {
    const mod = this.exports;
    mod.fvad_reset(this.instance);
    if (mod.fvad_set_sample_rate(this.instance, 16000) || mod.fvad_set_mode(this.instance, 2)) throw new Error('Configurazione del rilevatore di voce non riuscita.');
  }
  isSpeech(frame) {
    if (frame.length !== 320) throw new Error('Il rilevatore richiede campioni di 20 millisecondi.');
    const pcm = new Int16Array(this.exports.memory.buffer, this.buffer, 320);
    let crossings = 0;
    for (let i = 0; i < frame.length; i++) {
      const value = Math.max(-1, Math.min(1, frame[i]));
      pcm[i] = Math.round(value * (value < 0 ? 32768 : 32767));
      if (i && (frame[i] >= 0) !== (frame[i - 1] >= 0)) crossings++;
    }
    const result = this.exports.fvad_process(this.instance, this.buffer, 320);
    if (result < 0) throw new Error('Analisi del segnale audio non riuscita.');
    // A high zero-crossing rate is broadband hiss. Such frames can be retained
    // inside a phrase (fricatives), but cannot start or validate one by themselves.
    return result === 1 && crossings / frame.length < .32;
  }
  destroy() {
    this.exports.fvad_free(this.instance);
    this.exports.free(this.buffer);
  }
}
if (typeof module !== 'undefined') module.exports = { SpeechDetector };
else window.SpeechDetector = SpeechDetector;
