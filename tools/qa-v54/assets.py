"""Extract only WebView assets from a supplied APK for Playwright. Prints new root."""
import argparse
from pathlib import Path
import shutil
import tempfile
from zipfile import ZipFile


def extract(apk):
    root = Path(tempfile.mkdtemp(prefix='deepchat-qa-assets-')).resolve()
    prefix = 'assets/public/'
    with ZipFile(apk) as archive:
        for item in archive.infolist():
            if not item.filename.startswith(prefix) or item.is_dir():
                continue
            dest = (root / item.filename[len(prefix):]).resolve()
            if root not in dest.parents:
                raise ValueError('Unexpected asset path')
            dest.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(item) as source, dest.open('xb') as target:
                shutil.copyfileobj(source, target)
    if not (root / 'index.html').is_file():
        raise ValueError('No WebView entry point in APK')
    return root


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('apk', type=Path)
    print(extract(parser.parse_args().apk.resolve(strict=True)))
