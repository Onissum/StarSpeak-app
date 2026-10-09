'use strict';

(() => {
  const ids = ['mic','mic-icon','stop-icon','status','turn','from','to','swap','finish','level','heard','heard-language','translated','result-language','translate','replay','resume','error','auto-voice','alternate'];
  const ui = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  const { UtteranceGate, resample16k } = window.StarSpeakAudio;
  const labels = { it: 'Italiano', en: 'English' };
  const busyPhases = new Set(['loading','recognizing','translating','voice-preparing','speaking','settling']);
  let sourceLanguage = 'it', heardLanguage = 'it';
  let running = false, phase = 'idle', epoch = 0;
  let audioContext, stream, captureSource, processor, mutedOutput, gate;
  let detector, detectorPromise;
  let worker, engineReady = false, bootPromise, bootResolve, bootReject, bootTimer;
  let jobId = 0, playback, requestController, lastTranslation;
  const jobs = new Map();
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const current = token => token === epoch;
  const message = text => { ui.status.textContent = text; };

  function showError(text = '') {
    ui.error.textContent = text;
    ui.error.hidden = !text;
  }
  function renderDirection() {
    ui.from.textContent = labels[sourceLanguage];
    ui.to.textContent = labels[sourceLanguage === 'it' ? 'en' : 'it'];
    ui['heard-language'].textContent = `· ${labels[heardLanguage]}`;
    ui.turn.textContent = running ? `Ora parla in ${sourceLanguage === 'it' ? 'italiano' : 'inglese'}` : 'Tocca il microfono per iniziare';
  }
  function renderControls() {
    const busy = busyPhases.has(phase);
    const active = running || busy;
    ui.mic.classList.toggle('on', active);
    ui.mic.setAttribute('aria-label', running ? 'Ferma conversazione' : busy ? 'Interrompi operazione' : 'Avvia conversazione');
    ui.mic.disabled = false;
    ui['mic-icon'].hidden = active;
    ui['stop-icon'].hidden = !active;
    ui.swap.disabled = busy;
    ui.heard.disabled = busy;
    ui.translate.disabled = busy || !ui.heard.value.trim();
    ui.replay.disabled = busy || !lastTranslation;
    ui['auto-voice'].disabled = busy;
    ui.alternate.disabled = busy;
    ui.finish.disabled = phase !== 'listening' || !gate?.speaking;
    ui.resume.hidden = !running || !['waiting','editing'].includes(phase);
  }
  function setPhase(next) {
    phase = next;
    const listening = running && phase === 'listening';
    // The device track is muted as well as ignoring processor callbacks.
    // Translated speech can never become the input of another turn.
    stream?.getAudioTracks().forEach(track => { track.enabled = listening; });
    if (!listening) ui.level.style.width = '0%';
    renderControls();
  }
  async function ensureAudio() {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) throw new Error('Questo browser non supporta l’audio. Apri StarSpeak in Chrome o Safari.');
    if (!audioContext || audioContext.state === 'closed') audioContext = new Context();
    // Called directly from the microphone / translate / replay gesture to
    // unlock Web Audio before asynchronous model and network work starts.
    if (audioContext.state === 'suspended') await audioContext.resume();
    return audioContext;
  }

  function rejectJobs(error) {
    for (const job of jobs.values()) { clearTimeout(job.timer); job.reject(error); }
    jobs.clear();
  }
  function resetWorker(error) {
    worker?.terminate();
    worker = null;
    engineReady = false;
    clearTimeout(bootTimer);
    bootReject?.(error);
    bootPromise = null; bootResolve = null; bootReject = null;
    rejectJobs(error);
  }
  function ensureEngine() {
    if (engineReady) return Promise.resolve();
    if (bootPromise) return bootPromise;
    bootPromise = new Promise((resolve, reject) => { bootResolve = resolve; bootReject = reject; });
    const promise = bootPromise;
    try {
      worker = new Worker(new URL('/needle-worker.js?v=2.1', location.href));
      bootTimer = setTimeout(() => resetWorker(new Error('Whistle non si è caricato. Controlla la connessione e riprova.')), 180000);
      worker.onerror = () => resetWorker(new Error('Il motore audio non si è avviato. Ricarica la pagina e riprova.'));
      worker.onmessage = ({ data }) => {
        if (data.type === 'status' && phase === 'loading') message(data.text);
        if (data.type === 'ready') {
          engineReady = true;
          clearTimeout(bootTimer);
          bootResolve?.();
          bootResolve = null; bootReject = null;
        } else if (data.type === 'result' || (data.type === 'error' && data.jobId)) {
          const job = jobs.get(data.jobId);
          if (!job) return;
          clearTimeout(job.timer);
          jobs.delete(data.jobId);
          if (data.type === 'result') job.resolve(data.result);
          else job.reject(new Error(data.text));
        } else if (data.type === 'error') resetWorker(new Error(data.text));
      };
      worker.postMessage({ type: 'init' });
    } catch (error) { resetWorker(error); }
    return promise;
  }
  function recognize(pcm, language) {
    return new Promise((resolve, reject) => {
      const id = ++jobId;
      const timer = setTimeout(() => resetWorker(new Error('Il riconoscimento ha impiegato troppo tempo. Riprova con una frase più breve.')), 90000);
      jobs.set(id, { resolve, reject, timer });
      worker.postMessage({ type: 'transcribe', jobId: id, pcm: pcm.buffer, language, keywords: '' }, [pcm.buffer]);
    });
  }

  async function post(url, body, token) {
    requestController = new AbortController();
    const controller = requestController;
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: controller.signal
      });
      if (!current(token)) throw new Error('Operazione interrotta.');
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Il servizio non risponde. Riprova tra poco.');
      }
      // Consume the body before clearing the request timeout.
      return url === '/api/speak' ? await response.arrayBuffer() : await response.json();
    } catch (error) {
      if (error.name === 'AbortError' && current(token)) throw new Error('La connessione ha impiegato troppo tempo. Riprova.');
      throw error;
    } finally {
      clearTimeout(timer);
      if (requestController === controller) requestController = null;
    }
  }
  async function playTranslation(item, token) {
    setPhase('voice-preparing');
    message('Preparo la voce della traduzione…');
    if (!item.audio) item.audio = await post('/api/speak', { text: item.text, language: item.language }, token);
    if (!current(token)) return;
    const context = await ensureAudio();
    const buffer = await context.decodeAudioData(item.audio.slice(0));
    if (!current(token)) return;
    if (context.state !== 'running') throw new Error('Tocca Ascolta traduzione per attivare l’audio.');
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(context.destination);
    playback = node;
    setPhase('speaking');
    message('Leggo la traduzione. Il microfono è in pausa.');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { node.stop(); reject(new Error('La voce si è interrotta. Tocca Ascolta traduzione.')); }, (buffer.duration + 10) * 1000);
      node.onended = () => { clearTimeout(timer); resolve(); };
      try { node.start(); }
      catch (error) { clearTimeout(timer); reject(error); }
    });
    if (playback === node) playback = null;
    node.disconnect();
  }

  async function continueTurn(token, advance) {
    if (!current(token)) return;
    if (lastTranslation) lastTranslation.pendingAdvance = false;
    if (!running) { setPhase('idle'); message('Traduzione pronta. Puoi riascoltarla.'); return; }
    if (advance && ui.alternate.checked && lastTranslation) sourceLanguage = lastTranslation.language;
    renderDirection();
    setPhase('settling');
    // Give the speaker's acoustic tail time to decay before unmuting the mic.
    await wait(350);
    if (!current(token) || !running) return;
    gate.reset();
    setPhase('listening');
    message(`Ascolto in ${sourceLanguage === 'it' ? 'italiano' : 'inglese'}. Parla, poi fai una pausa.`);
  }
  async function translatePhrase(text, language, token) {
    if (!current(token)) return;
    setPhase('translating');
    message('Traduco la frase completa…');
    showError();
    lastTranslation = null;
    ui.translated.textContent = '…';
    renderControls();
    const target = language === 'it' ? 'en' : 'it';
    try {
      const data = await post('/api/translate', { text, from: language, to: target }, token);
      if (!current(token)) return;
      if (typeof data.text !== 'string' || !data.text.trim()) throw new Error('La traduzione è vuota. Riprova.');
      const item = { text: data.text, language: target, audio: null, pendingAdvance: running };
      lastTranslation = item;
      ui.translated.textContent = item.text;
      ui.translated.setAttribute('lang', target);
      ui['result-language'].textContent = `· ${labels[target]}`;
      if (ui['auto-voice'].checked) {
        try { await playTranslation(item, token); }
        catch (error) {
          if (!current(token)) return;
          showError(error.message);
          setPhase(running ? 'waiting' : 'idle');
          message('Traduzione pronta. Tocca Ascolta traduzione per sentire la voce.');
          return;
        }
      }
      await continueTurn(token, true);
    } catch (error) {
      if (!current(token)) return;
      ui.translated.textContent = '—';
      showError(error.message);
      setPhase(running ? 'waiting' : 'idle');
      message('Puoi correggere la frase e premere Traduci questa frase.');
    }
  }
  async function processClip(clip) {
    if (!running || phase !== 'listening') return;
    const token = epoch, language = sourceLanguage;
    setPhase('recognizing');
    gate.reset();
    showError();
    message(clip.reason === 'limit' ? 'Frase lunga: riconosco questo tratto. Usa frasi di meno di 24 secondi.' : 'Riconosco la frase completa…');
    try {
      const result = await recognize(clip.pcm, language);
      if (!current(token)) return;
      const text = (result?.text || '').trim();
      if (!text) { await continueTurn(token, false); message('Non ho riconosciuto la voce. Ripeti la frase vicino al microfono.'); return; }
      heardLanguage = language;
      ui.heard.value = text;
      renderDirection();
      const probabilities = (result.words || []).map(word => word.probability).filter(value => Number.isFinite(value) && value >= 0 && value <= 1);
      const confidence = probabilities.length ? probabilities.reduce((a, b) => a + b, 0) / probabilities.length : 1;
      if (confidence < .65) {
        setPhase('editing');
        message('Non ho riconosciuto bene la frase. Correggi il testo o tocca Continua ad ascoltare per ripetere.');
        showError('Trascrizione incerta: la traduzione automatica è in pausa.');
        return;
      }
      await translatePhrase(text, language, token);
    } catch (error) {
      if (!current(token)) return;
      showError(error.message);
      setPhase('waiting');
      message('Il riconoscimento si è interrotto. Tocca Continua ad ascoltare.');
    }
  }

  function disconnectCapture() {
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    if (processor) { processor.onaudioprocess = null; processor.disconnect(); processor = null; }
    captureSource?.disconnect(); captureSource = null;
    mutedOutput?.disconnect(); mutedOutput = null;
  }
  function stop() {
    epoch++;
    running = false;
    requestController?.abort();
    if (playback) { try { playback.stop(); } catch {} playback = null; }
    rejectJobs(new Error('Operazione interrotta.'));
    disconnectCapture();
    gate?.reset();
    if (lastTranslation) lastTranslation.pendingAdvance = false;
    setPhase('idle');
    renderDirection();
    message('Conversazione fermata. Tocca il microfono per riprendere.');
  }
  async function start() {
    if (busyPhases.has(phase)) return;
    running = true;
    const token = ++epoch;
    setPhase('loading'); renderDirection(); showError();
    message('Preparo l’ascolto…');
    try {
      const context = await ensureAudio();
      if (!current(token)) return;
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Il microfono non è disponibile. Apri questa pagina in un browser aggiornato.');
      if (!detectorPromise) detectorPromise = window.SpeechDetector.create().then(value => { detector = value; }).catch(error => { detectorPromise = null; throw error; });
      await Promise.all([ensureEngine(), detectorPromise]);
      if (!current(token)) return;
      const media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!current(token)) { media.getTracks().forEach(track => track.stop()); return; }
      stream = media;
      stream.getAudioTracks().forEach(track => { track.onended = () => { if (running) { stop(); showError('Il microfono si è disconnesso. Tocca il microfono per riprendere.'); } }; });
      gate = new UtteranceGate({ isSpeech: frame => detector.isSpeech(frame), resetSpeech: () => detector.reset() });
      captureSource = context.createMediaStreamSource(stream);
      processor = context.createScriptProcessor(4096, 1, 1);
      mutedOutput = context.createGain(); mutedOutput.gain.value = 0;
      processor.onaudioprocess = event => {
        if (!running || phase !== 'listening') return;
        const pcm = resample16k(event.inputBuffer.getChannelData(0), context.sampleRate);
        let clip;
        try { clip = gate.push(pcm); }
        catch (error) { stop(); showError(error.message); return; }
        ui.level.style.width = `${Math.min(100, gate.level * 1000)}%`;
        ui.finish.disabled = !gate.speaking;
        if (clip) void processClip(clip);
      };
      captureSource.connect(processor); processor.connect(mutedOutput); mutedOutput.connect(context.destination);
      setPhase('listening');
      message(`Ascolto in ${sourceLanguage === 'it' ? 'italiano' : 'inglese'}. Parla, poi fai una pausa.`);
    } catch (error) {
      if (!current(token)) return;
      stop();
      const text = error.name === 'NotAllowedError' ? 'Consenti l’accesso al microfono nelle impostazioni del browser.' : error.name === 'NotFoundError' ? 'Nessun microfono disponibile su questo dispositivo.' : error.message;
      showError(text);
    }
  }

  ui.mic.addEventListener('click', () => running || busyPhases.has(phase) ? stop() : void start());
  ui.finish.addEventListener('click', () => {
    if (phase !== 'listening') return;
    const clip = gate.finish();
    if (clip) void processClip(clip);
    else { ui.finish.disabled = true; message('Non ho rilevato una frase. Ripeti vicino al microfono.'); }
  });
  ui.swap.addEventListener('click', () => {
    if (busyPhases.has(phase)) return;
    sourceLanguage = sourceLanguage === 'it' ? 'en' : 'it';
    heardLanguage = sourceLanguage;
    gate?.reset();
    renderDirection();
    if (running) { setPhase('listening'); message(`Ascolto in ${sourceLanguage === 'it' ? 'italiano' : 'inglese'}.`); }
  });
  ui.heard.addEventListener('focus', () => {
    if (running && phase === 'listening') { gate.reset(); setPhase('editing'); message('Correggi la frase e tocca Traduci questa frase, oppure continua ad ascoltare.'); }
  });
  ui.heard.addEventListener('input', renderControls);
  ui.translate.addEventListener('click', async () => {
    if (busyPhases.has(phase) || !ui.heard.value.trim()) return;
    const token = epoch;
    setPhase('translating'); gate?.reset(); showError();
    try { await ensureAudio(); if (current(token)) await translatePhrase(ui.heard.value.trim(), heardLanguage, token); }
    catch (error) { if (current(token)) { showError(error.message); setPhase(running ? 'waiting' : 'idle'); } }
  });
  ui.replay.addEventListener('click', async () => {
    if (!lastTranslation || busyPhases.has(phase)) return;
    const token = epoch, item = lastTranslation, advance = item.pendingAdvance;
    setPhase('voice-preparing'); gate?.reset(); showError();
    try { await ensureAudio(); if (!current(token)) return; await playTranslation(item, token); await continueTurn(token, advance); }
    catch (error) { if (current(token)) { showError(error.message); setPhase(running ? 'waiting' : 'idle'); message('Tocca Ascolta traduzione per riprovare.'); } }
  });
  ui.resume.addEventListener('click', () => {
    if (!running || !['waiting','editing'].includes(phase)) return;
    showError();
    void continueTurn(epoch, Boolean(lastTranslation?.pendingAdvance));
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && running) stop(); });
  window.addEventListener('pagehide', () => {
    stop();
    resetWorker(new Error('La pagina è stata sospesa.'));
    if (audioContext && audioContext.state !== 'closed') audioContext.close().catch(() => {});
  });
  renderDirection(); renderControls();
})();
