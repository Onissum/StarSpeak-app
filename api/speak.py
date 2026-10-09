"""Return translated speech as MP3, as in the original Flask app."""
import json
import logging
from http.server import BaseHTTPRequestHandler
from io import BytesIO

from gtts import gTTS


def synthesize(text, language):
    output = BytesIO()
    gTTS(text=text, lang=language, lang_check=False, timeout=(5, 12)).write_to_fp(output)
    return output.getvalue()


class handler(BaseHTTPRequestHandler):
    def respond(self, status, data, content_type="application/json; charset=utf-8"):
        body = data if isinstance(data, bytes) else json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.respond(405, {"error": "Usa POST per leggere una frase."})

    def do_POST(self):
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 12000:
                return self.respond(400, {"error": "Testo mancante o troppo lungo."})
            data = json.loads(self.rfile.read(size))
            text, language = data.get("text"), data.get("language")
            if not isinstance(text, str) or not text.strip() or len(text) > 1200 or language not in {"it", "en"}:
                return self.respond(400, {"error": "Testo o lingua non validi."})
        except (ValueError, AttributeError, TypeError):
            return self.respond(400, {"error": "La richiesta non è valida."})
        try:
            audio = synthesize(text.strip(), language)
            if not audio:
                raise ValueError("Empty speech")
            self.respond(200, audio, "audio/mpeg")
        except Exception as error:
            logging.warning("Speech unavailable: %s", type(error).__name__)
            self.respond(502, {"error": "La voce non è disponibile. Tocca Ascolta traduzione per riprovare."})

    def log_message(self, format, *args):
        pass
