"""Archive complete runs as lossless WebP, plus a small set of paired comparison boards.

python archive.py OUT v55-routes=DIR v56-routes=DIR v55-identity=DIR v56-identity=DIR ...
"""
import hashlib
import io
import json
import sys
import zipfile
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw


def sha(data):
    return hashlib.sha256(data).hexdigest()


def archive(out, sources, after_label='v56 source'):
    out.mkdir(parents=True, exist_ok=False)
    manifest = {}
    seen = {}
    mapped = {}
    with zipfile.ZipFile(out / 'browser-evidence.zip', 'x', compression=zipfile.ZIP_DEFLATED) as z:
        for label, directory in sources.items():
            result = (directory / 'results.json').read_bytes()
            run = json.loads(result)
            if any(case.get('failure') for case in run['cases']):
                raise ValueError(f'Resolve or explicitly report failures in {label} before archiving')
            z.writestr(f'{label}/results.json', result)
            images = {}
            for case in run['cases']:
                for filename in case['shots']:
                    path = directory / filename
                    image = Image.open(path).convert('RGB')
                    data_hash = sha(image.tobytes())
                    if data_hash not in seen:
                        stream = io.BytesIO()
                        image.save(stream, format='WEBP', lossless=True, method=4)
                        payload = stream.getvalue()
                        zip_path = f'pictures/{len(seen) + 1:03}.webp'
                        z.writestr(zip_path, payload, compress_type=zipfile.ZIP_STORED)
                        seen[data_hash] = zip_path
                    images[filename] = {'path': seen[data_hash], 'pixelsSha256': data_hash, 'size': image.size}
                    mapped[(label, filename)] = path
            manifest[label] = {'version': run['version'], 'bundleSha256': run['sha256'], 'started': run['started'], 'images': images}
        z.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
    pairs = [
        ('identity', '390-dark-identities-dual-accounts.png', 'Identity choice and chat source'),
        ('routes', '320-light-routes-api-edit.png', 'API profile editor'),
        ('routes', '390-dark-routes-workbuddyAccount.png', 'WorkBuddy sign-in'),
        ('routes', '1280-light-routes-data.png', 'Desktop data settings'),
        ('model', '320-light-model-menu-closed.png', 'Composer at 320 px'),
    ]
    boards = []
    for key, name, title in pairs:
        before = Image.open(mapped['v55-'+key,name]).convert('RGB')
        after = Image.open(mapped['v56-'+key,name]).convert('RGB')
        if before.size != after.size:
            raise ValueError(f'Inconsistent screenshot dimensions for {name}')
        w, h = before.size
        board = Image.new('RGB', (2*w+8, h+40), '#e7eaed')
        board.paste(before, (0,40)); board.paste(after,(w+8,40))
        draw = ImageDraw.Draw(board)
        draw.text((8,11),f'v55 public   |   {title}',fill='#171a21')
        draw.text((w+16,11),after_label,fill='#171a21')
        filename = name.removesuffix('.png')+'-comparison.webp'
        board.save(out / filename, format='WEBP', lossless=True, method=4)
        boards.append({'comparison':filename,'changedBoundingBox':ImageChops.difference(before,after).getbbox()})
    summary={'archiveSha256':sha((out/'browser-evidence.zip').read_bytes()), 'uniquePictures':len(seen), 'capturedPictures':sum(len(group['images']) for group in manifest.values()), 'comparisons':boards}
    (out/'index.json').write_text(json.dumps(summary, indent=2)+'\n')
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    parser.add_argument('runs', nargs='+', metavar='LABEL=DIR')
    parser.add_argument('--after-label', default='v56 source')
    args = parser.parse_args()
    archive(args.output, {label: Path(directory) for label, directory in (arg.split('=', 1) for arg in args.runs)}, args.after_label)
