#!/usr/bin/env python3
"""Keep published catalog and shelf routes across full Pages uploads."""

import argparse
import json
import os
import tempfile
from pathlib import Path
from urllib.parse import unquote, urlsplit


def release_routes(public):
    catalog = json.loads((public / 'games.json').read_text())
    if not catalog['tiles']:
        raise ValueError('the staged catalog has no tiles')
    if not (public / 'shelf/index.html').is_file():
        raise ValueError('the staged shelf is missing')

    routes = {'/shelf/'}
    for tile in catalog['tiles']:
        url = tile['url']
        if url.startswith('/') and not url.startswith('//'):
            path = public / unquote(urlsplit(url).path).lstrip('/')
            if not any(page.is_file() for page in (path, path / 'index.html', path.with_suffix('.html'))):
                raise ValueError(f'the staged catalog points to a missing game: {url}')
        routes.add(url)

    for page in (public / 'games').rglob('*.html'):
        if page.parent != public / 'games/arcade':
            routes.add('/' + page.relative_to(public).as_posix())
    return routes


def record(baseline, routes):
    with tempfile.NamedTemporaryFile(mode='w', dir=baseline.parent, delete=False) as output:
        pending = Path(output.name)
        try:
            json.dump(sorted(routes), output, indent=2)
            output.write('\n')
            output.close()
            os.replace(pending, baseline)
        finally:
            pending.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('check', 'record'))
    parser.add_argument('public', type=Path)
    parser.add_argument('baseline', type=Path)
    args = parser.parse_args()
    try:
        routes = release_routes(args.public)
        if args.action == 'record':
            record(args.baseline, routes)
        else:
            before = json.loads(args.baseline.read_text())
            if not isinstance(before, list) or not before or any(not isinstance(url, str) for url in before):
                raise ValueError('invalid release baseline')
            missing = set(before) - routes
            if missing:
                raise ValueError('missing published routes:\n' + '\n'.join(sorted(missing)))
            print(f'Release preserves {len(before)} published catalog and shelf routes')
    except (OSError, KeyError, TypeError, ValueError) as error:
        parser.exit(1, f'{error}\n')


if __name__ == '__main__':
    main()
