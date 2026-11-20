"""Read the synthetic test's automatic ZIP from stdin, check CRC and ten actual turns."""
import io
import json
import sys
from zipfile import ZipFile

with ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    assert archive.testzip() is None, 'Unreadable ZIP entry'
    manifest = json.loads(archive.read('manifest.json'))
    index = json.loads(archive.read('chat_session_index.json'))
    assert manifest['export_format_version'] >= 3 and len(index) == 1
    session = json.loads(archive.read(f"chat_sessions/{index[0]['id']}.json"))
    messages = session['messages']
    assert len(messages) == index[0]['message_count'] == 20
    assert sum(m['role'] == 'ASSISTANT' and m['status'] == 'FINISHED' for m in messages) == 10
    for turn in range(1, 11):
        question, reply = [json.dumps(m, ensure_ascii=False) for m in messages[2 * (turn - 1):2 * turn]]
        assert f'第 {turn} 次备份测试' in question and f'回答已完成 {turn}' in reply
    print(json.dumps({'entries': len(archive.namelist()), 'finishedTurns': 10, 'crc': 'pass'}))
