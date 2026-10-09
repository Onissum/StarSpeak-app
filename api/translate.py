"""Keep the original StarSpeak translator; recognition stays in the browser."""
import asyncio
import json
import logging
from http.server import BaseHTTPRequestHandler

import httpx
from googletrans import Translator


async def translate_text(text, source, target):
    # Use the same web translator as the original StarSpeak, rather than
    # googleapis' unauthenticated route (which can reject datacenter IPs).
    try:
        async with Translator(service_urls=["translate.google.com"],
                              timeout=httpx.Timeout(8.0), raise_exception=True) as translator:
            result = await translator.translate(text, src=source, dest=target)
            if result.text and result.text.strip():
                return result.text.strip()
    except Exception as error:
        logging.warning("Primary translation unavailable: %s", type(error).__name__)
    # A checked fallback is preferable to returning the input unchanged as
    # though it were a successful translation. MyMemory accepts <=500 bytes.
    chunks, chunk = [], ""
    for word in text.split():
        candidate = (chunk + " " + word).strip()
        if len(candidate.encode("utf-8")) > 450:
            if not chunk:
                raise ValueError("Word too long")
            chunks.append(chunk)
            chunk = word
        else:
            chunk = candidate
    if chunk:
        chunks.append(chunk)
    async with httpx.AsyncClient(timeout=10.0) as client:
        translated = []
        for chunk in chunks:
            response = await client.get("https://api.mymemory.translated.net/get",
                                        params={"q": chunk, "langpair": source + "|" + target, "mt": 1})
            response.raise_for_status()
            data = response.json()
            if str(data.get("responseStatus")) != "200" or data.get("quotaFinished"):
                raise ValueError("Translation unavailable or quota exhausted")
            result = data.get("responseData", {}).get("translatedText")
            if not isinstance(result, str) or not result.strip():
                raise ValueError("Empty translation")
            translated.append(result.strip())
        return " ".join(translated)


class handler(BaseHTTPRequestHandler):
    def respond(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.respond(405, {"error": "Usa POST per tradurre una frase."})

    def do_POST(self):
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 12000:
                return self.respond(400, {"error": "Testo mancante o troppo lungo."})
            data = json.loads(self.rfile.read(size))
            text = data.get("text")
            source, target = data.get("from"), data.get("to")
            if not isinstance(text, str) or not text.strip() or len(text) > 1200:
                return self.respond(400, {"error": "Scrivi una frase di massimo 1200 caratteri."})
            if (source, target) not in {("it", "en"), ("en", "it")}:
                return self.respond(400, {"error": "Scegli italiano e inglese."})
        except (ValueError, AttributeError, TypeError):
            return self.respond(400, {"error": "La richiesta non è valida."})
        try:
            async def bounded_translation():
                return await asyncio.wait_for(translate_text(text.strip(), source, target), timeout=22)
            translated = asyncio.run(bounded_translation())
            self.respond(200, {"text": translated, "from": source, "to": target})
        except Exception as error:
            # Do not log the spoken text or an upstream URL containing it.
            logging.warning("Translation unavailable: %s", type(error).__name__)
            self.respond(502, {"error": "Il servizio di traduzione non risponde. Riprova tra poco."})

    def log_message(self, format, *args):
        pass
