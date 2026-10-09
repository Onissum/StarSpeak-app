"""Development server: same Python endpoints and static files as Vercel."""
import importlib.util
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "api" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


translate, speak = load("translate"), load("speak")


class Router(SimpleHTTPRequestHandler):
    respond = speak.handler.respond

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "public"), **kwargs)

    def do_POST(self):
        routes = {"/api/translate": translate.handler.do_POST, "/api/speak": speak.handler.do_POST}
        route = routes.get(self.path)
        if route:
            route(self)
        else:
            self.respond(404, {"error": "Not found"})

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    print("StarSpeak: http://127.0.0.1:8765", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8765), Router).serve_forever()
