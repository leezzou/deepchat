"""Project public model lists onto factual, provider-scoped rows. No credentials."""
import hashlib
import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from urllib.request import Request, urlopen

# Explicit provider keys and endpoint equivalences. None means the upstream uses its
# named native SDK's canonical endpoint. Refuse new hosts, paths or provider IDs.
MAPPINGS = {
    'deepseek': ('deepseek', 'https://api.deepseek.com'),
    'glm': ('zhipuai', 'https://open.bigmodel.cn/api/paas/v4'),
    'zai': ('zai', 'https://api.z.ai/api/paas/v4'),
    'qwen': ('alibaba-cn', 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
    'qwen-intl': ('alibaba', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'),
    'kimi': ('moonshotai-cn', 'https://api.moonshot.cn/v1'),
    'kimi-intl': ('moonshotai', 'https://api.moonshot.ai/v1'),
    'siliconflow': ('siliconflow-cn', 'https://api.siliconflow.cn/v1'),
    'volcengine': ('volcengine', 'https://ark.cn-beijing.volces.com/api/v3'),
    'hunyuan': ('tencent-tokenhub', 'https://tokenhub.tencentmaas.com/v1'),
    'minimax': ('minimax-cn', 'https://api.minimax.cn/anthropic/v1'),
    'minimax-intl': ('minimax', 'https://api.minimax.io/anthropic/v1'),
    'stepfun': ('stepfun', 'https://api.stepfun.com/v1'),
    'openai': ('openai', None), 'anthropic': ('anthropic', None),
    'gemini': ('google', None), 'xai': ('xai', None), 'mistral': ('mistral', None),
    'groq': ('groq', None), 'together': ('togetherai', None),
    'fireworks': ('fireworks-ai', 'https://api.fireworks.ai/inference/v1'),
    'deepinfra': ('deepinfra', None), 'cerebras': ('cerebras', None),
    'sambanova': ('sambanova', 'https://api.sambanova.ai/v1'),
    'novita': ('novita-ai', 'https://api.novita.ai/openai'),
    'openrouter': ('openrouter', 'https://openrouter.ai/api/v1'),
    'perplexity': ('perplexity', None), 'cohere': ('cohere', None),
    'opencode': ('opencode', 'https://opencode.ai/inference/openai/v1'),
    'opencode-go': ('opencode-go', 'https://opencode.ai/inference/go/openai/v1'),
    'lmstudio': ('lmstudio', 'http://127.0.0.1:1234/v1'),
}

URLS = {
    'models-dev': 'https://models.dev/api.json',
    'openrouter': 'https://openrouter.ai/api/v1/models',
    'opencode': 'https://opencode.ai/inference/openai/v1/models',
    'opencode-go': 'https://opencode.ai/inference/go/openai/v1/models',
    'deepinfra': 'https://api.deepinfra.com/v1/openai/models',
    'sambanova': 'https://api.sambanova.ai/v1/models',
    'novita': 'https://api.novita.ai/v3/openai/models',
    'cerebras': 'https://api.cerebras.ai/public/v1/models',
    'siliconflow': 'https://siliconflow.cn/models',
    'together': 'https://docs.together.ai/docs/serverless-models.md',
    'groq': 'https://console.groq.com/docs/models.md',
    'openai': 'https://developers.openai.com/api/docs/models/all.md',
    'anthropic': 'https://platform.claude.com/docs/en/models/overview.md',
    'cohere': 'https://docs.cohere.com/docs/models.mdx',
}


def download(url):
    with urlopen(Request(url, headers={'User-Agent': 'DeepChat-model-catalog/1.0'}), timeout=28) as res:
        return res.read()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def positive(n):
    return n if type(n) is int and n > 0 else None


def integer(text):
    return int(text.replace(',', '')) if re.fullmatch(r'[\d,]+', text) else None


def row(model_id, name=None, ctx=None, inp=None, out=None, source=0, compat=None):
    r = [model_id, name if name != model_id else None, positive(ctx), positive(inp), positive(out), source]
    if compat is not None:
        r.append(compat)
    return r


def chat_text(m):
    modalities = m.get('modalities', {})
    return (m.get('type', 'chat') == 'chat' and 'text' in modalities.get('input', [])
            and 'text' in modalities.get('output', []))


def from_models_dev(doc):
    providers = {}
    for preset, (key, endpoint) in MAPPINGS.items():
        provider = doc[key]
        actual = provider.get('api', '').rstrip('/') or None
        if provider['id'] != key or actual != endpoint:
            raise ValueError(f'Review provider identity: {preset}, {key}, {actual}')
        rows, excluded = [], []
        for model_id, m in provider['models'].items():
            if model_id != m['id']:
                raise ValueError(f'Conflicting model ID at {key}/{model_id}')
            if not chat_text(m):
                excluded.append(model_id)
                continue
            limits = m.get('limit', {})
            rows.append(row(model_id, m.get('name'), limits.get('context'), limits.get('input'), limits.get('output')))
        providers[preset] = {'sources': [[f'models.dev · {key}', f'https://models.dev/#{key}']],
                             'rows': rows, 'excluded': excluded}
    return providers


def from_api(source, doc):
    data = doc['data']
    if not data or doc.get('links', {}).get('next') or doc.get('total_count', len(data)) != len(data):
        raise ValueError(f'Review pagination / empty source: {source}')
    rows, excluded = [], []
    for m in data:
        model_id = m['id']
        ctx = inp = out = compat = None
        name = m.get('name')
        valid = True
        if source in ('opencode', 'opencode-go'):
            valid = chat_text(m)
            ctx, inp, out = (m['limit'].get(k) for k in ('context', 'input', 'output'))
            compat = 'chat-completions' in m['api']
        elif source == 'openrouter':
            a = m['architecture']
            compat = '/api/v1/chat/completions' in m['endpoints']
            valid = compat and 'text' in a['input_modalities'] and 'text' in a['output_modalities']
            ctx, out = m.get('context_length'), m['top_provider'].get('max_completion_tokens')
        elif source == 'deepinfra':
            meta = m['metadata']
            valid = 'chat' in (meta.get('tags') or [])
            ctx = meta.get('context_length')
        elif source == 'novita':
            valid = m['model_type'] == 'chat' and 'text' in m['output_modalities']
            ctx, out = m.get('context_size'), m.get('max_output_tokens')
            compat = 'chat/completions' in m['endpoints']
            name = m.get('display_name')
        elif source == 'cerebras':
            valid = m.get('supported_parameters', {}).get('max_completion_tokens') is True
            ctx, out = m['limits'].get('max_context_length'), m['limits'].get('max_completion_tokens')
        elif source == 'sambanova':
            valid = 'max_completion_tokens' in m
            ctx, out = m.get('context_length'), m.get('max_completion_tokens')
        if valid:
            rows.append(row(model_id, name, ctx, inp, out, compat=compat))
        else:
            excluded.append(model_id)
    return rows, excluded


def from_siliconflow(html):
    # Next.js serializes the public model gallery as a data array inside a JSON string.
    for match in re.finditer(r'self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)', html):
        payload = json.loads(match.group(1))
        index = payload.find('"data":[{"modelId"')
        if index < 0:
            continue
        models, _ = json.JSONDecoder().raw_decode(payload[index + len('"data":'):])
        selected = [m for m in models if m['subType'] == 'chat']
        return ([row(m['modelName'], m.get('DisplayName'), m.get('contextLen')) for m in selected],
                [m['modelName'] for m in models if m['subType'] != 'chat'])
    raise ValueError('SiliconFlow gallery structure changed')


def from_markdown(provider, markdown):
    rows, excluded = [], []
    section = ''
    for line in markdown.splitlines():
        if line.startswith('## '):
            section = line[3:].lower()
        if not line.startswith('| '):
            continue
        cells = [s.strip() for s in line.strip('| ').split('|')]
        if provider == 'together' and section in ('chat models', 'vision models'):
            if len(cells) >= 4 and '/' in cells[2]:
                model_id = cells[2].strip('`')
                rows.append(row(model_id, cells[1], integer(cells[3])))
        if provider == 'groq' and (match := re.search(r'\]\(/docs/model/([^ )]+)\)', cells[0])):
            model_id = match.group(1)
            if not any(term in model_id for term in ('whisper', 'orpheus', 'guard')):
                rows.append(row(model_id, ctx=integer(cells[4]), out=integer(cells[5])))
            else:
                excluded.append(model_id)
    return rows, excluded


def from_cohere(markdown):
    rows = []
    headers = []
    for line in markdown.splitlines():
        if not line.startswith('|'):
            headers = []
            continue
        cells = [s.strip() for s in line.strip('| ').split('|')]
        if 'Model Name' in cells:
            headers = cells
        if 'Endpoints' not in headers or len(cells) != len(headers):
            continue
        fields = dict(zip(headers, cells))
        ids = re.fullmatch(r'`([^`]+)`', fields.get('Model Name', ''))
        if ids and '[Chat]' in fields['Endpoints']:
            # Cohere's tables abbreviate a number of model limits as “4k”, etc.
            # Integer facts take precedence. Other exact counts come from the
            # matching upstream record, never from a guessed binary/decimal unit.
            rows.append(row(ids.group(1), ctx=integer(fields.get('Context Length', '')),
                            out=integer(fields.get('Maximum Output Tokens', ''))))
    return rows, []


def collect_anthropic(raw, lock):
    cards = sorted(set(re.findall(r'\((https://platform\.claude\.com/docs/en/models/[a-z0-9-]+/overview)\)', raw.decode())))

    def details(url):
        url += '.md'
        page = download(url)
        doc = page.decode()
        ids = re.findall(r'^\| Claude API(?: alias)?\s*\|\s*`([^`]+)`', doc, re.M)
        cols = dict((name, value.strip()) for name, value in re.findall(r'^\| (\[Context window\][^|]+|Max output)\s*\|\s*([^|]+)\|\s*$', doc, re.M))
        # Anthropic documents its decimal token thresholds as 200K/1M windows
        # and 64K/128K output limits on the first-party Messages API.
        def token_count(prefix):
            for name, value in cols.items():
                m = re.fullmatch(r'([\d,]+)([KM]?) tokens', value)
                if name.startswith(prefix) and m:
                    return integer(m[1]) * {'': 1, 'K': 1000, 'M': 1000000}[m[2]]
        rows = [row(i, ctx=token_count('[Context'), out=token_count('Max output')) for i in sorted(set(ids))]
        return url, sha(page), rows

    sources, records, digests = [], {}, {}
    with ThreadPoolExecutor(max_workers=4) as pool:
        for url, digest, rows in pool.map(details, cards):
            digests[url] = digest
            for r in rows:
                r[5] = len(sources)
                records[r[0]] = r
            if rows:
                sources.append(['Anthropic · official', url])
    if not records:
        raise ValueError('Anthropic card schema changed')
    lock['cardHashes'] = digests
    return {'lock': lock, 'providers': {'anthropic': {'sources': sources, 'rows': sorted(records.values()), 'excluded': []}}}


def collect_openai(raw, lock):
    index = raw.decode()
    slugs = sorted(set(re.findall(r'^- \[[^\]]+\]\(/api/docs/models/([a-zA-Z0-9._-]+)\.md\)', index, re.M)))
    if not slugs:
        raise ValueError('OpenAI docs index is empty')

    def details(slug):
        url = f'https://developers.openai.com/api/docs/models/{slug}.md'
        page = download(url)
        doc = page.decode()
        match = re.search(r'^Model ID: `([^`]+)`', doc, re.M)
        if not match:
            raise ValueError(f'Missing ID in {url}')
        model_id = match.group(1)
        name = doc.splitlines()[0].removeprefix('# ')
        cc = '| `v1/chat/completions` | Supported |' in doc
        responses = '| `v1/responses` | Supported |' in doc
        accepts_text = re.search(r'^- Input modalities: [^\n]*\btext\b', doc, re.M)
        writes_text = re.search(r'^- Output modalities: [^\n]*\btext\b', doc, re.M)
        if not (accepts_text and writes_text and (cc or responses)):
            return url, sha(page), [], [model_id]
        def limit(label):
            found = re.search(r'^- ([\d,]+) ' + label + '$', doc, re.M)
            return integer(found.group(1)) if found else None
        ctx, out = limit('context window'), limit('max output tokens')
        rows = [row(model_id, name, ctx, None, out, compat=cc)]
        # The card's published numbers identify its current default snapshot. Other
        # dated aliases from the history can have different limits, so leave them null.
        default = re.search(r'^- Default snapshot: `([^`]+)`', doc, re.M)
        if default and default.group(1) != model_id:
            rows.append(row(default.group(1), None, ctx, None, out, compat=cc))
        snapshots = re.search(r'^## Snapshots\n(.*?)(?=^## |\Z)', doc, re.M | re.S)
        if snapshots:
            existing = {r[0] for r in rows}
            for alias in re.findall(r'^- `([^`]+)`', snapshots.group(1), re.M):
                if alias not in existing:
                    rows.append(row(alias, compat=cc))
        return url, sha(page), rows, []

    # Keep a build-time audit trail for each linked model card, including skipped
    # documents. An unavailable card has no authority to erase an existing snapshot.
    sources, records, excluded, page_digests = [], {}, set(), {}
    with ThreadPoolExecutor(max_workers=6) as pool:
        for url, digest, rows, denied in pool.map(details, slugs):
            page_digests[url] = digest
            excluded.update(denied)
            if rows:
                source_index = len(sources)
                sources.append(['OpenAI · official', url])
                for r in rows:
                    r[5] = source_index
                    if r[0] not in records or r[2] is not None:
                        records[r[0]] = r
    if not records:
        raise ValueError('No chat-capable models on OpenAI model cards')
    lock['cardHashes'] = page_digests
    return {'lock': lock, 'providers': {'openai': {'sources': sources, 'rows': sorted(records.values()), 'excluded': sorted(excluded)}}}


def collect(source):
    url = URLS[source]
    raw = download(url)
    lock = {'url': url, 'rawSha256': sha(raw), 'retrievedUtc': datetime.now(timezone.utc).isoformat(timespec='seconds')}
    if source == 'models-dev':
        revision = json.loads(download('https://api.github.com/repos/anomalyco/models.dev/commits/dev'))
        lock.update(observedGitHead=revision['sha'], observedCommitDate=revision['commit']['committer']['date'],
                    license='MIT', licenseUrl=f'https://github.com/anomalyco/models.dev/blob/{revision["sha"]}/LICENSE')
        providers = from_models_dev(json.loads(raw))
    else:
        lock['license'] = 'Public provider facts only (IDs, names, numeric limits, supported protocols)'
        if source == 'openai':
            return collect_openai(raw, lock)
        if source == 'anthropic':
            return collect_anthropic(raw, lock)
        if source == 'cohere':
            rows, excluded = from_cohere(raw.decode())
        elif source == 'siliconflow':
            rows, excluded = from_siliconflow(raw.decode())
        elif source in ('together', 'groq'):
            rows, excluded = from_markdown(source, raw.decode())
        else:
            rows, excluded = from_api(source, json.loads(raw))
        providers = {source: {'sources': [[f'{source} · official', url]], 'rows': rows, 'excluded': excluded}}
    for preset, data in providers.items():
        if not data['rows']:
            raise ValueError(f'Empty parsed catalog for {preset}')
        data['rows'].sort(key=lambda r: r[0])
        data['excluded'] = sorted(set(data['excluded']))
    return {'lock': lock, 'providers': providers}
