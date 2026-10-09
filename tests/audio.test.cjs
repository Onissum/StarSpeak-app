const test = require('node:test');
const assert = require('node:assert/strict');
const { UtteranceGate, resample16k } = require('../public/audio.js');
const tone = (seconds, amplitude = .1, rate = 16000) => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => amplitude * Math.sin(2 * Math.PI * 220 * i / rate));
const silence = seconds => new Float32Array(Math.round(seconds * 16000));
function feed(gate, pcm) {
  const clips = [];
  for (let i = 0; i < pcm.length; i += 4096) {
    const clip = gate.push(pcm.slice(i, i + 4096));
    if (clip) clips.push(clip);
  }
  return clips;
}
function join(...arrays) {
  const result = new Float32Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) { result.set(a, offset); offset += a.length; }
  return result;
}
test('silence and quiet background never become phrases', () => {
  const gate = new UtteranceGate();
  assert.equal(feed(gate, silence(60)).length, 0);
  assert.equal(feed(gate, tone(20, .002)).length, 0);
  assert.equal(gate.finish(), null);
});
test('isolated clicks do not trigger recognition', () => {
  const gate = new UtteranceGate();
  assert.equal(feed(gate, join(silence(.4), tone(.02), silence(2))).length, 0);
  assert.equal(gate.finish(), null);
});
test('a phrase longer than three seconds and with short pauses stays intact', () => {
  const clips = feed(new UtteranceGate(), join(silence(.5), tone(2.5), silence(.5), tone(3), silence(1.5)));
  assert.equal(clips.length, 1);
  assert(clips[0].pcm.length > 16000 * 6, 'both halves of the sentence must remain');
  assert(clips[0].pcm.length < 16000 * 6.6, 'long silent tail must be trimmed');
  assert(clips[0].voicedSeconds > 5.3);
});
test('manual finish preserves the end of a phrase without waiting for silence', () => {
  const gate = new UtteranceGate();
  feed(gate, join(silence(.2), tone(1.23)));
  const clip = gate.finish();
  assert(clip && clip.reason === 'manual');
  assert(clip.pcm.length >= 16000 * 1.4);
});
test('long phrases cannot exceed the model input limit', () => {
  const gate = new UtteranceGate();
  const clips = feed(gate, tone(27));
  assert.equal(clips[0].reason, 'limit');
  assert(clips[0].pcm.length <= 16000 * 24);
});
test('48 kHz conversion keeps duration and suppresses high-frequency aliasing', () => {
  const low = resample16k(tone(1, .1, 48000), 48000);
  assert.equal(low.length, 16000);
  assert(Math.max(...low) > .095);
  const high = Float32Array.from({ length: 48000 }, (_, i) => Math.sin(2 * Math.PI * 16000 * i / 48000));
  const down = resample16k(high, 48000);
  assert(Math.max(...down.map(Math.abs)) < .0001);
});
