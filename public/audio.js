'use strict';

class UtteranceGate {
  constructor({ sampleRate = 16000, silenceMs = 1000, maxSeconds = 24, isSpeech, resetSpeech } = {}) {
    this.sampleRate = sampleRate;
    this.frameSize = Math.round(sampleRate * .02);
    this.silenceFrames = Math.ceil(silenceMs / 20);
    this.maxFrames = Math.floor(maxSeconds / .02);
    this.isSpeech = isSpeech;
    this.resetSpeech = resetSpeech;
    this.reset();
  }
  reset() {
    this.pending = new Float32Array(0);
    this.pre = [];
    this.frames = [];
    this.noise = .001;
    this.onset = 0;
    this.voiced = 0;
    this.silent = 0;
    this.speaking = false;
    this.level = 0;
    this.resetSpeech?.();
  }
  push(samples) {
    // Work in 20 ms frames so microphone buffer sizes do not affect endings.
    const input = new Float32Array(this.pending.length + samples.length);
    input.set(this.pending);
    input.set(samples, this.pending.length);
    let offset = 0;
    for (; offset + this.frameSize <= input.length; offset += this.frameSize) {
      const frame = input.slice(offset, offset + this.frameSize);
      let energy = 0, mean = 0;
      for (const value of frame) { energy += value * value; mean += value; }
      const rms = Math.sqrt(Math.max(0, energy / frame.length - (mean / frame.length) ** 2));
      this.level = rms;
      const hasEnergy = rms >= Math.max(.006, this.noise * 2.8);
      const classified = this.isSpeech ? this.isSpeech(frame) : true;
      const isVoice = hasEnergy && classified;
      if (!this.speaking) {
        this.pre.push(frame);
        if (this.pre.length > 15) this.pre.shift();
        this.onset = isVoice ? this.onset + 1 : 0;
        if (!hasEnergy) this.noise = this.noise * .95 + rms * .05;
        if (this.onset >= 3) {
          this.speaking = true;
          this.frames = this.pre.slice();
          this.voiced = this.onset;
          this.silent = 0;
        }
      } else {
        this.frames.push(frame);
        if (isVoice) { this.voiced++; this.silent = 0; }
        else this.silent++;
        if (this.silent >= this.silenceFrames || this.frames.length >= this.maxFrames) {
          const reason = this.frames.length >= this.maxFrames ? 'limit' : 'pause';
          const clip = this.finish(reason);
          if (clip) return clip;
        }
      }
    }
    this.pending = input.slice(offset);
    return null;
  }
  finish(reason = 'manual') {
    // Ignore clicks and silence, and retain only 160 ms of trailing silence.
    if (!this.speaking || this.voiced < 10) { this.reset(); return null; }
    const remove = Math.max(0, this.silent - 8);
    const frames = this.frames.slice(0, this.frames.length - remove);
    const pcm = new Float32Array(frames.length * this.frameSize + (reason === 'manual' ? this.pending.length : 0));
    frames.forEach((frame, i) => pcm.set(frame, i * this.frameSize));
    if (reason === 'manual') pcm.set(this.pending, frames.length * this.frameSize);
    const result = { pcm, reason, voicedSeconds: this.voiced * .02 };
    this.reset();
    return result;
  }
}

function resample16k(input, sampleRate) {
  if (sampleRate === 16000) return new Float32Array(input);
  const ratio = sampleRate / 16000;
  const output = new Float32Array(Math.floor(input.length / ratio));
  // Average the source interval instead of dropping samples from 48 kHz.
  for (let i = 0; i < output.length; i++) {
    const start = i * ratio, end = (i + 1) * ratio;
    let sum = 0;
    for (let j = Math.floor(start); j < Math.ceil(end); j++) {
      const weight = Math.max(0, Math.min(end, j + 1) - Math.max(start, j));
      sum += (input[j] || 0) * weight;
    }
    output[i] = sum / ratio;
  }
  return output;
}

if (typeof module !== 'undefined') module.exports = { UtteranceGate, resample16k };
else window.StarSpeakAudio = { UtteranceGate, resample16k };
