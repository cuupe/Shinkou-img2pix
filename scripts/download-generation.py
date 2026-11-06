"""Download pinned generation weights with bounded retries and verified HTTP ranges."""
import argparse
import hashlib
import json
import re
import time
from pathlib import Path

import requests


def download(model, root, proxy=None):
    root = root.resolve()
    target = (root / model['path']).resolve()
    if not target.is_relative_to(root):
        raise ValueError('Model path must stay inside the selected models directory')
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + '.partial')

    def verified(path):
        if path.stat().st_size != model['bytes']:
            return False
        with path.open('rb') as handle:
            digest = hashlib.sha256()
            while chunk := handle.read(4 * 1024 * 1024):
                digest.update(chunk)
            return digest.hexdigest() == model['sha256']

    if target.exists():
        if not verified(target):
            raise ValueError(f'Existing model is invalid; it has not been overwritten: {target}')
        print(f'Verified {model["path"]}', flush=True)
        return
    proxies = {'https': proxy, 'http': proxy} if proxy else None
    for attempt in range(5):
        offset = partial.stat().st_size if partial.exists() else 0
        if offset == model['bytes']:
            break
        if offset > model['bytes']:
            raise ValueError(f'Partial model is oversized: {partial}')
        try:
            print(f'Downloading {model["path"]}: {offset:,} / {model["bytes"]:,} bytes', flush=True)
            with requests.get(model['url'], headers={'Range': f'bytes={offset}-', 'Accept-Encoding': 'identity'}, proxies=proxies, stream=True, timeout=(30, 60)) as response:
                response.raise_for_status()
                if offset or response.status_code == 206:
                    value = response.headers.get('Content-Range', '')
                    match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', value)
                    if response.status_code != 206 or not match or int(match[1]) != offset or int(match[3]) != model['bytes']:
                        raise ValueError('Server did not honor the requested byte range; partial file preserved')
                elif int(response.headers.get('Content-Length', 0)) != model['bytes']:
                    raise ValueError('Unexpected model response size')
                reported = time.monotonic()
                with partial.open('ab') as handle:
                    for chunk in response.iter_content(1024 * 1024):
                        if not chunk:
                            continue
                        if handle.tell() + len(chunk) > model['bytes']:
                            raise ValueError('Model response exceeds expected size')
                        handle.write(chunk)
                        if time.monotonic() - reported > 15:
                            print(f'{model["path"]}: {handle.tell():,} / {model["bytes"]:,} bytes', flush=True)
                            reported = time.monotonic()
            if partial.stat().st_size == model['bytes']:
                break
            raise requests.ConnectionError('Incomplete model response')
        except requests.RequestException:
            if attempt == 4:
                raise RuntimeError('Model download interrupted. Run setup again to resume.') from None
            # Do not log signed redirect URLs or proxy credentials from exception messages.
            print(f'Connection interrupted; resuming (attempt {attempt + 2}/5).', flush=True)
            time.sleep(2 ** attempt)
    if not partial.exists() or not verified(partial):
        raise ValueError(f'Model checksum mismatch; partial file preserved: {partial}')
    # Never overwrite an existing destination, even if another installer finished first.
    if target.exists():
        raise ValueError(f'Model destination appeared during download: {target}')
    partial.rename(target)
    print(f'Verified {model["path"]}', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--models-dir', type=Path, required=True)
    parser.add_argument('--proxy')
    parser.add_argument('--only')
    args = parser.parse_args()
    manifest = json.loads(Path(__file__).with_name('generation-models.json').read_text(encoding='utf-8'))
    models = [m for m in manifest['models'] if not args.only or m['path'] == args.only]
    if not models:
        parser.error('Unknown model')
    for model in models:
        download(model, args.models_dir, args.proxy)
