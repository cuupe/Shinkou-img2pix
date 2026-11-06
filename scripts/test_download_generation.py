import hashlib
import importlib.util
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('downloader', Path(__file__).with_name('download-generation.py'))
downloader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(downloader)
BODY = bytes(range(256)) * 12288


class DownloadTests(unittest.TestCase):
    def test_resumes_after_a_real_connection_interruption_and_verifies_complete_file(self):
        offsets = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                start = int(self.headers['Range'].split('=')[1].split('-')[0])
                offsets.append(start)
                self.send_response(206)
                self.send_header('Content-Range', f'bytes {start}-{len(BODY)-1}/{len(BODY)}')
                self.send_header('Content-Length', str(len(BODY)-start))
                self.end_headers()
                self.wfile.write(BODY[:1500000] if len(offsets) == 1 else BODY[start:])
                self.close_connection = True

            def log_message(self, *_):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'NO_PROXY': '127.0.0.1'}):
                model = {'path': 'encoder/test.safetensors', 'bytes': len(BODY), 'sha256': hashlib.sha256(BODY).hexdigest(), 'url': f'http://127.0.0.1:{server.server_port}/model'}
                downloader.download(model, Path(folder))
                self.assertEqual((Path(folder)/model['path']).read_bytes(), BODY)
                self.assertEqual(offsets, [0, 1024 * 1024])
                # A verified destination is reused without a second download.
                downloader.download(model, Path(folder))
                self.assertEqual(len(offsets), 2)
        finally:
            server.shutdown()
            server.server_close()

    def test_invalid_existing_file_is_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder)/'model'
            target.write_bytes(b'wrong')
            with self.assertRaises(ValueError):
                downloader.download({'path': 'model', 'bytes': 5, 'sha256': 'bad'}, Path(folder))
            self.assertEqual(target.read_bytes(), b'wrong')

    def test_rejects_paths_outside_selected_model_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                downloader.download({'path': '../outside', 'bytes': 1, 'sha256': 'bad'}, Path(folder))


if __name__ == '__main__':
    unittest.main()
