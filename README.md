# StarSpeak con Whistle

Traduttore vocale bidirezionale italiano ↔ inglese. Il riconoscimento avviene
nel browser con Whistle. Traduzione e voce riutilizzano googletrans e gTTS,
come nello StarSpeak originale. MyMemory è il servizio di riserva per la
traduzione, con controllo di errori e quota.

## Conversazione

1. Tocca il microfono e parla nella lingua mostrata.
2. Una pausa di un secondo conclude la frase. Puoi anche toccare **Ho finito di parlare**.
3. Durante riconoscimento, traduzione e riproduzione il microfono è disabilitato.
4. Al termine della voce, l'app ascolta nell'altra lingua. Disattiva **Alterna italiano e inglese** per tenere la stessa direzione.
5. **Ascolta traduzione** riproduce l'ultima frase senza cambiare nuovamente lingua.
6. Puoi correggere la trascrizione o scrivere una frase e premere **Traduci questa frase**.

Il tasto centrale ferma la conversazione, cancella le richieste in corso e
rilascia il microfono. Tornando in secondo piano, la pagina smette di ascoltare.

## Correzioni rispetto al primo prototipo

- Le frasi non vengono più tagliate ogni tre secondi. WebRTC VAD (libfvad,
  modalità 2, 20 ms a 16 kHz) distingue voce e rumore prima di Whistle. Un
  filtro sul livello audio scarta silenzio e brevi impulsi; il tasso di zero
  crossing evita che un fruscio inizi una frase. Pre-roll di 300 ms e coda di
  160 ms preservano l'inizio e la fine delle parole.
- Una frase con probabilità media delle parole sotto 0,65 viene mostrata
  per correggerla o ripeterla, senza tradurla e pronunciarla automaticamente.
- I turni sono sequenziali: riconoscimento → traduzione → MP3 → ascolto.
  Le callback audio vengono ignorate e la traccia del microfono viene
  disabilitata durante il turno. La lingua cambia dopo la fine della voce.
- La riproduzione usa Web Audio, attivato dal gesto iniziale, con un pulsante
  di riascolto e un messaggio esplicito in caso di errore.
- I risultati arrivati dopo Stop vengono ignorati. Il motore già caricato si
  può riutilizzare; timer e richieste vengono cancellati.
- Il runtime JS/WASM è distribuito sullo stesso dominio, con MIME corretti
  e hash SHA-256 verificati durante la build.
- Le richieste di traduzione e voce sono POST. La lingua sorgente e quella
  di destinazione sono controllate anche sul server, in entrambe le direzioni.

## Rete e limiti

Il modello Whistle da circa 16,9 MB viene scaricato alla prima apertura e
salvato, se il browser lo consente, nella Cache API. La registrazione non viene
caricata sul server. Il testo della frase viene inviato ai servizi Google per
traduzione e voce, oppure a MyMemory se Google non risponde alla traduzione;
queste due funzioni richiedono Internet.

Il VAD riduce le false attivazioni, ma può ancora riconoscere voci di una TV o
di altre persone. Whistle può sbagliare con rumore, accenti e frasi brevi;
la trascrizione resta visibile e modificabile. Una frase continua viene
conclusa a 24 secondi per rispettare il limite di 30 secondi del motore.
googletrans e gTTS sono librerie non ufficiali dei servizi web Google: possono
subire limiti o indisponibilità. Gli errori del servizio vengono mostrati,
senza pronunciare o sostituire la traduzione con contenuti inventati.

## Sviluppo e distribuzione

Richiede Node 24 e Python 3.12+.

```sh
npm run build
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python tests/serve.py
```

Apri `http://127.0.0.1:8765`. Su Vercel usa preset **Other**, output `public`
e build `node build.cjs`; le funzioni Python sotto `api/` sono rilevate
automaticamente. Non sono richieste chiavi API. I file Flask/HTML originali
nel repository sono conservati per riferimento.

## Verifica

`npm test` copre silenzio, rumore debole, impulsi, frasi oltre tre secondi,
fine manuale, limite audio e conversione 48 → 16 kHz.

`tests/verify-conversation.cjs` esegue il codice dell'interfaccia e il vero
motore WASM, con endpoint Python reali. DOM, input del microfono e fine della
riproduzione sono simulati; il testo riconosciuto non è predefinito. Passa il
modello e due file PCM float32 little-endian mono a 16 kHz (frasi dimostrative
italiana e inglese):

```sh
node tests/verify-conversation.cjs /path/whistle.cact /path/italian.f32 /path/english.f32
```

Il test verifica anche il rumore che prima produceva «Grazie mille», l'assenza
di feedback dalla voce e la lingua dopo il
termine della riproduzione, il riascolto e lo stop durante una richiesta.
Gli MP3 restituiti possono essere verificati con ffmpeg. Un eventuale quarto
argomento è un file JSON temporaneo con `origin` e `cookie` per verificare
un deployment protetto; non salvarlo nel repository.

I test con audio dimostrativo non sostituiscono una prova con il microfono e
l'altoparlante del telefono dell'utente.

## Licenze

StarSpeak originale: MIT. Needle/Whistle: vedere `public/vendor/NOTICE.txt`
e `public/vendor/LICENSE-Needle.txt`. WebRTC/libfvad: BSD-3-Clause, vedere
`public/vendor/LICENSE-WebRTC.txt`, `AUTHORS-WebRTC.txt` e `PATENTS-WebRTC.txt`.
I runtime sono generati dalla build e non
deve essere incluso nei commit.
