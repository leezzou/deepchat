import json
import unittest
from pathlib import Path

from generate import merge, validate_row
from sources import from_api, from_markdown, from_models_dev, row


class CatalogTest(unittest.TestCase):
    def layer(self, title, rows, excluded=()):
        return {'sources': [[title, 'https://example.com']], 'rows': rows, 'excluded': excluded}

    def test_exact_ids_and_source_precedence(self):
        base = self.layer('base', [row('Model', ctx=2048, out=100), row('model', ctx=42), row('removed')])
        official = self.layer('official', [row('Model', inp=1024)], ['removed'])
        result = merge([base, official])
        self.assertEqual(result['rows'], [['Model', None, None, 1024, None, 1], ['model', None, 42, None, None, 0]])

    def test_id_only_listing_retains_the_source_of_exact_known_limits(self):
        result = merge([self.layer('base', [row('x', ctx=2048)]), self.layer('official', [row('x', compat=False)])])
        self.assertEqual(result['rows'], [['x', None, 2048, None, None, 0, False]])
        self.assertEqual(result['sources'][0][0], 'base')

    def test_duplicates_and_invalid_limits_fail_closed(self):
        with self.assertRaises(ValueError):
            merge([self.layer('base', [row('x', ctx=42), row('x', ctx=100)])])
        for bad in [-1, 0, 1.2, True, 2**53]:
            with self.assertRaises(ValueError):
                validate_row(['x', None, bad, None, None, 0], [('s', 'https://example.com')])
        with self.assertRaises(ValueError):
            from_models_dev({'deepseek': {'id': 'deepseek', 'api': 'https://an-unrelated-host.example/v1'}})

    def test_official_non_chat_information_suppresses_lower_priority_entries(self):
        rows, excluded = from_api('deepinfra', {'data': [
            {'id': 'x', 'metadata': {'tags': ['chat'], 'context_length': 2048, 'max_tokens': 888}},
            {'id': 'embedding', 'metadata': {'tags': ['embed']}}]})
        self.assertEqual(rows, [row('x', ctx=2048)])
        self.assertEqual(excluded, ['embedding'])
        with self.assertRaises(ValueError):
            from_api('openrouter', {'data': [{'id': 'partial'}], 'links': {'next': '/page/2'}})

    def test_markdown_tables_respect_chat_sections_and_exact_id(self):
        fixture = '## Chat models\n| Org | Foo | org/Foo | 128,000 | X |\n## Embedding models\n| Org | Bar | org/Bar | 4096 | X |'
        self.assertEqual(from_markdown('together', fixture), ([row('org/Foo', 'Foo', 128000)], []))

    def test_full_snapshot_is_unique_and_sorted_by_exact_id(self):
        data = Path(__file__).resolve().parents[2] / 'chat-demo/src/services/api/catalog-data'
        for path in data.glob('*.json'):
            with self.subTest(provider=path.stem):
                parsed = json.loads(path.read_text())
                ids = [r[0] for r in parsed['rows']]
                self.assertEqual(ids, sorted(set(ids)))
                for r in parsed['rows']:
                    validate_row(r, parsed['sources'])


if __name__ == '__main__':
    unittest.main()
