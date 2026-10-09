// Full application with the real WASM recognizer and live Python endpoints.
// The DOM, microphone callbacks and speaker's end event are simulated.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { UtteranceGate, resample16k } = require('../public/audio.js');
const { SpeechDetector } = require('../public/speech-detector.js');
const [modelPath, italianPath, englishPath, accessPath, thanksPath] = process.argv.slice(2);
const apiAccess = accessPath ? JSON.parse(fs.readFileSync(accessPath, 'utf8')) : { origin: 'http://127.0.0.1:8765' };
if (!englishPath) throw new Error('Usage: node tests/verify-conversation.cjs model.cact italian.f32 english.f32');
const root = path.resolve(__dirname, '../public');
const model = fs.readFileSync(modelPath);
const readPcm = filename => {
  const bytes = fs.readFileSync(filename);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};
const samples = { it: readPcm(italianPath), en: readPcm(englishPath) };
const requests = [], recognitions = [], results = [], audioBuffers = [];
let processor, speaker, workerCount = 0;
const track = { enabled: true, stop() { this.stopped = true; } };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

class EngineWorker {
  constructor(url) {
    workerCount++;
    const scope = {
      URL, Blob, Response, TextEncoder, TextDecoder, WebAssembly, performance,
      console, setTimeout, clearTimeout, Float32Array, Uint8Array,
      WorkerGlobalScope: function WorkerGlobalScope() {},
      location: { href: String(url) },
      fetch: async url => {
        requests.push(String(url));
        const bytes = String(url).startsWith('https://huggingface.co/')
          ? model : fs.readFileSync(path.join(root, new URL(url).pathname.slice(1)));
        return new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } });
      },
      postMessage: message => {
        if (message.type === 'result') results.push(message.result);
        queueMicrotask(() => { if (!this.terminated) this.onmessage?.({ data: message }); });
      }
    };
    scope.self = scope;
    this.context = vm.createContext(scope);
    scope.importScripts = url => {
      requests.push(String(url));
      vm.runInContext(fs.readFileSync(path.join(root, new URL(url).pathname.slice(1)), 'utf8'), this.context);
    };
    vm.runInContext(fs.readFileSync(path.join(root, 'needle-worker.js'), 'utf8'), this.context);
  }
  postMessage(message) {
    if (message.type === 'transcribe') recognitions.push({ language: message.language, seconds: message.pcm.byteLength / 64000 });
    queueMicrotask(() => { if (!this.terminated) this.context.self.onmessage({ data: message }); });
  }
  terminate() { this.terminated = true; }
}
function element(id) {
  const classes = new Set();
  return {
    id, value: '', checked: ['auto-voice','alternate'].includes(id), disabled: false,
    hidden: false, textContent: '', style: {}, handlers: {}, attributes: {},
    classList: { toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); } },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(name, handler) { this.handlers[name] = handler; }
  };
}
const elements = new Map();
const document = {
  getElementById(id) { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); },
  addEventListener() {}, hidden: false
};
const node = () => ({ connect() {}, disconnect() {} });
class AudioContext {
  constructor() { this.sampleRate = 16000; this.state = 'running'; this.destination = node(); }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
  createMediaStreamSource() { return node(); }
  createScriptProcessor() { processor = { ...node(), onaudioprocess: null }; return processor; }
  createGain() { return { ...node(), gain: { value: 1 } }; }
  async decodeAudioData(bytes) {
    assert(bytes.byteLength > 1000, 'a real MP3 must be returned, not an empty voice');
    audioBuffers.push(Buffer.from(bytes));
    return { duration: 5 };
  }
  createBufferSource() {
    speaker = { ...node(), start() { this.started = true; }, stop() { this.ended = true; this.onended?.(); } };
    return speaker;
  }
}
const scope = {
  document, Worker: EngineWorker, URL, console, setTimeout, clearTimeout, Float32Array, Date, AbortController,
  location: { href: 'https://starspeak.test/' }, AudioContext,
  StarSpeakAudio: { UtteranceGate, resample16k }, addEventListener() {},
  SpeechDetector: { create: () => SpeechDetector.create(fs.readFileSync(path.join(root, 'vendor/libfvad.wasm'))) },
  navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) } },
  fetch: async (url, options) => {
    const data = JSON.parse(options.body);
    requests.push({ url, body: data });
    const headers = { ...options.headers };
    if (apiAccess.cookie) headers.Cookie = apiAccess.cookie;
    return fetch(apiAccess.origin + url, { ...options, headers });
  }
};
scope.window = scope;
vm.runInContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), vm.createContext(scope));
const el = id => elements.get(id);
async function until(predicate, description) {
  for (let i = 0; i < 250; i++) { if (predicate()) return; await wait(100); }
  throw new Error('Timeout: ' + description + '; status=' + el('status').textContent + '; error=' + el('error').textContent);
}
function feed(pcm) {
  for (let i = 0; i < pcm.length; i += 4096) processor.onaudioprocess({ inputBuffer: { getChannelData: () => pcm.slice(i, i + 4096) } });
}
async function finishVoice() {
  assert(speaker?.started);
  speaker.stop();
  await until(() => track.enabled, 'microphone resumes only after voice ends');
}

(async () => {
  el('mic').handlers.click();
  await until(() => processor?.onaudioprocess && track.enabled, 'recognizer and microphone ready');
  feed(new Float32Array(16000 * 45));
  feed(Float32Array.from({ length: 16000 * 10 }, (_, i) => .001 * Math.sin(i)));
  await wait(50);
  assert.equal(recognitions.length, 0, 'silence and background must not reach ASR');
  assert.equal(requests.filter(r => r.url === '/api/translate').length, 0);
  // This noise produced "Grazie mille" before adding the real WebRTC VAD.
  let seed = 123456;
  const noise = Float32Array.from({length:32000}, () => {
    seed = (Math.imul(seed,1664525) + 1013904223) >>> 0;
    return ((seed / 4294967296) * 2 - 1) * .12;
  });
  feed(noise); feed(new Float32Array(24000));
  await wait(100);
  assert.equal(recognitions.length, 0, 'loud noise must not reach the recognizer');
  assert.equal(requests.filter(r => r.url === '/api/translate').length, 0, 'noise must not produce a spoken translation');
  console.log(JSON.stringify({check:'loud noise',recognitions:0,translationRequests:0}));
  for (const language of ['it', 'en']) {
    feed(samples[language]);
    feed(new Float32Array(16000 * 1.5));
    assert.equal(track.enabled, false, 'microphone pauses before recognition');
    await until(() => speaker?.started && el('status').textContent.startsWith('Leggo'), 'live translation and MP3 playback');
    assert.equal(recognitions.length, language === 'it' ? 1 : 2, 'one whole phrase per turn');
    assert.equal(recognitions.at(-1).language, language);
    assert(recognitions.at(-1).seconds > (language === 'it' ? 3 : 2), 'preserve the whole phrase');
    if (language === 'it') assert.match(el('heard').value.toLowerCase(), /tavolo|persone/);
    else assert.match(el('heard').value.toLowerCase(), /table|two|people/);
    assert.equal(el('from').textContent, language === 'it' ? 'Italiano' : 'English', 'language cannot change before speech ends');
    const before = recognitions.length;
    feed(samples.en); // Simulate the app's own output coming back to the mic.
    assert.equal(recognitions.length, before, 'speaker feedback must not be recognized');
    console.log(JSON.stringify({ check: 'whole phrase and live translation', ...recognitions.at(-1), heard: el('heard').value, translated: el('translated').textContent, words: results.at(-1).words }));
    await finishVoice();
    assert.equal(el('from').textContent, language === 'it' ? 'English' : 'Italiano');
  }
  const before = recognitions.length;
  el('replay').handlers.click();
  await until(() => el('status').textContent.startsWith('Leggo'), 'replay voice');
  assert.equal(track.enabled, false);
  await finishVoice();
  assert.equal(el('from').textContent, 'Italiano', 'replaying an old result must not advance the language again');
  assert.equal(recognitions.length, before);
  if (thanksPath) {
    feed(readPcm(thanksPath)); feed(new Float32Array(24000));
    await until(() => el('status').textContent.startsWith('Leggo'), 'real thanks phrase is not blacklisted');
    assert.match(el('heard').value.toLowerCase(), /grazie mille/);
    assert.match(el('translated').textContent.toLowerCase(), /thank/);
    console.log(JSON.stringify({check:'thanks actually spoken',heard:el('heard').value,translated:el('translated').textContent}));
    await finishVoice();
    assert.equal(el('from').textContent, 'English');
  }
  feed(samples.it.subarray(0, 16000 * 2));
  assert.equal(el('finish').disabled, false);
  el('finish').handlers.click();
  el('mic').handlers.click(); // Stop while recognition / translation is pending.
  await wait(1500);
  assert(track.stopped);
  assert.equal(el('status').textContent, 'Conversazione fermata. Tocca il microfono per riprendere.');
  assert.equal(el('replay').disabled, false, 'last completed audio remains replayable');
  assert.equal(workerCount, 1);
  audioBuffers.forEach((bytes, i) => fs.writeFileSync(path.join(__dirname, `verified-voice-${i}.mp3`), bytes));
  assert(!requests.some(url => typeof url === 'string' && /huggingface.*needle\.(js|wasm)/.test(url)));
  console.log(JSON.stringify({ passed: true, checks: ['55 seconds silence/noise','loud noise that previously hallucinated thanks','whole phrases','Italian/English','live translations','real MP3s','no speaker feedback','turns after onended','replay without direction switch','manual finish and stop'], workerCount, recognitions: recognitions.length }));
})().catch(error => { console.error(error); console.error(JSON.stringify({heard:el('heard').value, results})); process.exitCode = 1; });
