/* Whistle runs off the UI thread. StarSpeak pauses capture during transcription. */
'use strict';

// Hugging Face distribuisce needle.js come text/plain. Serviamo il runtime
// insieme all'app, con il MIME corretto e senza importare script esterni.
const ENGINE_BASE = new URL('./vendor/', self.location.href).href;
const MODEL_URL = 'https://huggingface.co/Cactus-Compute/whistle/resolve/b358ddadd89b7a713b5aa131f23032d3cca1b251/whistle.cact';
const CACHE_NAME = 'voce-testo-whistle-v1';
let engine = null;

function readCString(mod, ptr) {
  let end = ptr;
  while (mod.HEAPU8[end] !== 0) end++;
  return new TextDecoder().decode(mod.HEAPU8.subarray(ptr, end));
}

function lastError(mod) {
  try {
    const ptr = mod._needle_last_error();
    if (ptr) return readCString(mod, ptr);
  } catch (_) {}
  return 'Il motore Whistle non ha completato la trascrizione.';
}

function allocString(mod, value) {
  if (!value) return 0;
  const bytes = new TextEncoder().encode(value);
  const ptr = mod._malloc(bytes.length + 1);
  if (!ptr) throw new Error('Memoria insufficiente per le opzioni audio.');
  mod.HEAPU8.set(bytes, ptr);
  mod.HEAPU8[ptr + bytes.length] = 0;
  return ptr;
}

async function loadModel() {
  postMessage({ type: 'status', text: 'Carico il motore Whistle…' });
  importScripts(ENGINE_BASE + 'needle.js');
  if (typeof self.createNeedle !== 'function') throw new Error('Il runtime WebAssembly non si è avviato.');
  // Questa build Emscripten non espone locateFile: passiamo il binario
  // esplicitamente, evitando una richiesta a /needle.wasm nella cartella errata.
  const wasmResponse = await fetch(ENGINE_BASE + 'needle.wasm');
  if (!wasmResponse.ok) throw new Error(`Download del motore non riuscito (${wasmResponse.status}).`);
  const mod = await self.createNeedle({ wasmBinary: await wasmResponse.arrayBuffer() });

  let response = null;
  if ('caches' in self) {
    const cache = await caches.open(CACHE_NAME).catch(() => null);
    if (cache) response = await cache.match(MODEL_URL);
    if (response) postMessage({ type: 'status', text: 'Modello già salvato sul dispositivo…' });
  }
  if (!response) {
    response = await fetch(MODEL_URL, { mode: 'cors' });
    if (!response.ok) throw new Error(`Download del modello non riuscito (${response.status}).`);
    const total = Number(response.headers.get('content-length')) || 16900000;
    const reader = response.body && response.body.getReader ? response.body.getReader() : null;
    if (reader) {
      const parts = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        received += value.byteLength;
        postMessage({ type: 'status', text: `Scarico il modello · ${Math.round(received / 1048576)} / ${Math.max(1, Math.round(total / 1048576))} MB` });
      }
      response = new Response(new Blob(parts, { type: 'application/octet-stream' }));
      if ('caches' in self) {
        const cacheCopy = response.clone();
        const cache = await caches.open(CACHE_NAME).catch(() => null);
        if (cache) await cache.put(MODEL_URL, cacheCopy).catch(() => {});
      }
    }
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  postMessage({ type: 'status', text: 'Preparo il modello…' });
  const ptr = mod._malloc(bytes.byteLength);
  if (!ptr) throw new Error('Memoria insufficiente per caricare il modello.');
  try {
    mod.HEAPU8.set(bytes, ptr);
    const loaded = mod._needle_load(ptr, BigInt(bytes.byteLength));
    if (loaded < 0) throw new Error(lastError(mod));
  } finally {
    mod._free(ptr);
  }
  engine = mod;
  postMessage({ type: 'ready' });
}

function transcribe(message) {
  const mod = engine;
  if (!mod) throw new Error('Il modello non è pronto.');
  const pcm = new Float32Array(message.pcm);
  if (!pcm.length || pcm.length > 16000 * 30) throw new Error('La frase audio deve durare meno di 30 secondi.');
  const outCapacity = 131072;
  const pcmPtr = mod._malloc(pcm.byteLength);
  const outPtr = mod._malloc(outCapacity);
  let languagePtr = 0;
  let keywordsPtr = 0;
  if (!pcmPtr || !outPtr) throw new Error('Memoria insufficiente per trascrivere questo segmento.');
  try {
    // I campioni Float32 vengono copiati come byte nella memoria WASM.
    mod.HEAPU8.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), pcmPtr);
    mod.HEAPU8.fill(0, outPtr, outPtr + outCapacity);
    languagePtr = allocString(mod, message.language || null);
    keywordsPtr = allocString(mod, message.keywords || null);
    const count = mod._needle_transcribe(pcmPtr, pcm.length, languagePtr, keywordsPtr, 1, outPtr, outCapacity);
    if (count < 0) throw new Error(lastError(mod));
    const result = JSON.parse(readCString(mod, outPtr));
    postMessage({ type: 'result', jobId: message.jobId, result, offsetSeconds: message.offsetSeconds, overlapSeconds: message.overlapSeconds });
  } finally {
    mod._free(pcmPtr);
    mod._free(outPtr);
    if (languagePtr) mod._free(languagePtr);
    if (keywordsPtr) mod._free(keywordsPtr);
  }
}

self.onmessage = event => {
  const message = event.data;
  try {
    if (message.type === 'init') loadModel().catch(error => postMessage({ type: 'error', text: error.message || String(error) }));
    else if (message.type === 'transcribe') transcribe(message);
  } catch (error) {
    postMessage({ type: 'error', jobId: message.jobId, text: error.message || String(error) });
  }
};
