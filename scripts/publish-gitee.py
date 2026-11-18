from __future__ import annotations

#!/usr/bin/env python3
"""Create/update the Gitee release and upload the APK.

Requires GITEE_TOKEN in the environment; reads GITEE_REPO (owner/repo).
No token or API response secrets are printed.
"""

import json
import os
import sys
import urllib.parse
import urllib.request
import uuid
from pathlib import Path


def request(url: str, data: bytes | None = None, headers: dict[str, str] | None = None) -> dict:
    req = urllib.request.Request(url, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=120) as response:
        body = response.read()
    return json.loads(body) if body else {}


def main() -> int:
    if len(sys.argv) < 4:
        print('usage: publish-gitee.py <version> <notes> <apk>', file=sys.stderr)
        return 2
    version, notes, apk_path = sys.argv[1], sys.argv[2], Path(sys.argv[3])
    token = os.environ.get('GITEE_TOKEN', '').strip()
    repo = os.environ.get('GITEE_REPO', 'yllzz/deepchat').strip('/')
    if not token:
        print('GITEE_TOKEN is empty', file=sys.stderr)
        return 2
    if not apk_path.is_file():
        print(f'APK not found: {apk_path}', file=sys.stderr)
        return 2

    tag = f'v{version}'
    api = f'https://gitee.com/api/v5/repos/{repo}'
    headers = {'Authorization': f'token {token}', 'User-Agent': 'DeepChat-Release'}
    releases = request(f'{api}/releases?per_page=100', headers=headers)
    release = next((item for item in releases if item.get('tag_name') == tag), None)
    if release is None:
        form = urllib.parse.urlencode(
            {
                'tag_name': tag,
                'name': f'DeepChat {tag}',
                'body': notes or f'DeepChat {tag}',
                'target_commitish': 'main',
                'prerelease': 'false',
            }
        ).encode()
        release = request(
            f'{api}/releases',
            data=form,
            headers={**headers, 'Content-Type': 'application/x-www-form-urlencoded'},
        )
        print(f'created Gitee release {tag}')
    else:
        print(f'Gitee release {tag} already exists')

    release_id = release.get('id')
    if not release_id:
        print('Gitee release id is missing', file=sys.stderr)
        return 1

    assets = release.get('assets') or []
    asset = next((item for item in assets if item.get('name') == 'deepchat.apk'), None)
    if asset is None:
        content = apk_path.read_bytes()
        boundary = '----DeepChat' + uuid.uuid4().hex
        parts: list[bytes] = []

        def field(name: str, value: str) -> None:
            parts.append(
                f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
            )

        def file_part(name: str, filename: str, data: bytes, content_type: str) -> None:
            parts.append(
                f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
                f'Content-Type: {content_type}\r\n\r\n'.encode()
                + data
                + b'\r\n'
            )

        field('access_token', token)
        file_part('file', 'deepchat.apk', content, 'application/vnd.android.package-archive')
        parts.append(f'--{boundary}--\r\n'.encode())
        asset = request(
            f'{api}/releases/{release_id}/attach_files',
            data=b''.join(parts),
            headers={**headers, 'Content-Type': f'multipart/form-data; boundary={boundary}'},
        )
        print('uploaded Gitee APK')
    else:
        print('Gitee APK already attached')

    url = (
        asset.get('browser_download_url')
        or f'https://gitee.com/{repo}/releases/download/{tag}/deepchat.apk'
    )
    print(url)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
