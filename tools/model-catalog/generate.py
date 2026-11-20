#!/usr/bin/env python3
"""Build offline provider chunks. --refresh [SOURCE ...] fetches fresh public facts."""
import argparse
import json
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

sys.dont_write_bytecode = True
from sources import MAPPINGS, URLS, collect, row, sha

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
DATA = ROOT / 'chat-demo/src/services/api/catalog-data'
SNAPS = HERE / 'snapshots'


def compact(data):
    return json.dumps(data, ensure_ascii=False, separators=(',', ':'), sort_keys=True) + '\n'


def write_if_changed(path, text, check=False):
    if path.exists() and path.read_text() == text:
        return
    if check:
        raise ValueError(f'Generated output is stale: {path.relative_to(ROOT)}')
    path.write_text(text)


def presets():
    # Read the live, typed preset list (Node 22.18+ can strip its types).
    code = "import { providerPresets } from './chat-demo/src/services/api/providerPresets.ts'; console.log(JSON.stringify(providerPresets))"
    entries = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', code], cwd=ROOT))
    origins = {p['value']: p['origin'] for p in entries}
    if len(entries) != len(origins) or origins != json.loads((HERE / 'origins.json').read_text()):
        raise ValueError('Preset IDs or endpoints changed. Review the mapping and origins.json.')
    return entries


def validate_source(s):
    if len(s) != 2 or not all(isinstance(x, str) and x for x in s) or urlparse(s[1]).scheme != 'https':
        raise ValueError(f'Invalid source: {s}')


def validate_row(r, sources):
    if len(r) not in (6, 7) or not isinstance(r[0], str) or not r[0] or r[0] != r[0].strip() or re.search(r'[\x00-\x1f\x7f]', r[0]):
        raise ValueError(f'Invalid model ID/row: {r}')
    if r[1] is not None and (not isinstance(r[1], str) or not r[1]):
        raise ValueError(f'Invalid model name: {r}')
    if any(v is not None and (type(v) is not int or not 0 < v <= 2**53 - 1) for v in r[2:5]):
        raise ValueError(f'Invalid token limit: {r}')
    if type(r[5]) is not int or not 0 <= r[5] < len(sources) or (len(r) == 7 and type(r[6]) is not bool):
        raise ValueError(f'Invalid source index or protocol: {r}')


def merge(layers):
    """A stronger source replaces the entire row, preserving its missing fields."""
    models = {}
    for layer in layers:
        for s in layer['sources']:
            validate_source(s)
        for model_id in layer.get('excluded', []):
            models.pop(model_id, None)
        unique = {}
        for r in layer['rows']:
            validate_row(r, layer['sources'])
            if r[0] in unique and r != unique[r[0]]:
                raise ValueError(f'Conflicting records in one source: {r}, {unique[r[0]]}')
            unique[r[0]] = r
        for model_id, r in unique.items():
            source = tuple(layer['sources'][r[5]])
            previous = models.get(model_id)
            # A listing with no numeric fields can still verify the ID/protocol. If
            # an exact pair already has published limits, keep those together with
            # their actual source. Never mix input/output from different budgets.
            if previous and r[2:5] == [None] * 3 and any(previous[0][2:5]):
                prior, source = previous
                r = [r[0], r[1] or prior[1], *prior[2:5], r[5], *r[6:]]
            models[model_id] = (r, source)
    sources = sorted({s for _, s in models.values()})
    rows = []
    for model_id in sorted(models):
        record, source = models[model_id]
        packed = list(record)
        if packed[1] == model_id:
            packed[1] = None
        packed[5] = sources.index(source)
        rows.append(packed)
    return {'sources': sources, 'rows': rows}


def generate(args):
    entries = presets()
    if args.refresh is not None:
        names = args.refresh or list(URLS)
        if set(names) - URLS.keys():
            raise ValueError(f'Unknown source(s). Available: {", ".join(URLS)}')
        # Finish network collection before replacing any pinned snapshots.
        with ThreadPoolExecutor(max_workers=4) as pool:
            updated = dict(zip(names, pool.map(collect, names)))
        for source, new in updated.items():
            write_if_changed(SNAPS / f'{source}.json', compact(new))
    snapshots = {name: json.loads((SNAPS / f'{name}.json').read_text()) for name in URLS}
    base = snapshots['models-dev']['providers']
    if set(base) != set(MAPPINGS):
        raise ValueError('Pinned models.dev provider set differs from reviewed mapping')
    ids = {p['value'] for p in entries}
    unexpected = {f.stem for f in DATA.glob('*.json')} - ids
    overrides = {f.stem: json.loads(f.read_text()) for f in (HERE / 'overrides').glob('*.json')}
    if unexpected or overrides.keys() - ids:
        raise ValueError(f'Unknown provider files: {unexpected | (overrides.keys() - ids)}')
    report = {'sources': {}, 'providers': {}, 'totalModels': 0, 'knownContext': 0, 'chunkBytes': 0}
    for name, snap in snapshots.items():
        lock = snap['lock']
        if lock['url'] != URLS[name] or not re.fullmatch(r'[a-f0-9]{64}', lock['rawSha256']):
            raise ValueError(f'Invalid snapshot provenance: {name}')
        report['sources'][name] = {k: v for k, v in lock.items() if k != 'cardHashes'}
        report['sources'][name]['snapshotSha256'] = sha((SNAPS / f'{name}.json').read_bytes())
    outputs = {}
    for preset in entries:
        key = preset['value']
        layers = []
        if preset['model'] and key != 'lmstudio':
            # Presets may refer to an old snapshot or a private deployment. Their
            # IDs are real app inputs; the preset alone supplies no numeric limits.
            link = preset['origin'] if key != 'ollama' else 'https://ollama.com/library/llama3.2'
            layers.append({'sources': [['DeepChat preset · ID only', link]], 'rows': [row(preset['model'])]})
        if key in base:
            layers.append(base[key])
        if key in snapshots:
            layers.append(snapshots[key]['providers'][key])
        if key in overrides:
            layers.append(overrides[key])
        chunk = merge(layers)
        packed = compact(chunk)
        outputs[DATA / f'{key}.json'] = packed
        rows = chunk['rows']
        counts = {'origin': preset['origin'], 'modelsDevKey': MAPPINGS[key][0] if key in MAPPINGS else None,
                  'models': len(rows), 'context': sum(r[2] is not None for r in rows),
                  'input': sum(r[3] is not None for r in rows), 'output': sum(r[4] is not None for r in rows),
                  'missingContextIds': [r[0] for r in rows if r[2] is None],
                  'otherProtocolIds': [r[0] for r in rows if len(r) == 7 and not r[6]],
                  'bytes': len(packed.encode()), 'sha256': sha(packed.encode())}
        # A source may have several URLs (OpenAI card per model). Count all rows.
        counts['sources'] = {}
        for r in rows:
            label = chunk['sources'][r[5]][0]
            counts['sources'][label] = counts['sources'].get(label, 0) + 1
        report['providers'][key] = counts
        report['totalModels'] += len(rows)
        report['knownContext'] += counts['context']
        report['chunkBytes'] += counts['bytes']
    outputs[HERE / 'coverage.json'] = json.dumps(report, ensure_ascii=False, indent=2) + '\n'
    for path, text in outputs.items():
        write_if_changed(path, text, args.check)
    print(f"{len(entries)} presets, {report['totalModels']} models, {report['knownContext']} contexts, {report['chunkBytes']} bytes")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument('--refresh', nargs='*', metavar='SOURCE', help='refresh all or selected upstream snapshots')
    actions.add_argument('--check', action='store_true', help='validate offline and reject stale generated files')
    generate(parser.parse_args())
