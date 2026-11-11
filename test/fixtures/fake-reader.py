"""Offline transport fixture. Does not import Discord or contact a network."""
import json
import os
import sys
import time

def emit(value):
    print(json.dumps(value), flush=True)

token = os.environ.get('READER_TOKEN')
if token == 'fixture-startup-hang':
    time.sleep(10)
    sys.exit(0)
if token == 'fixture-dependency-failure':
    emit({'type': 'fatal', 'code': 'READER_DEPENDENCY'})
    sys.exit(0)
if token not in ('fixture-only-placeholder', 'fixture-replacement-placeholder') or 'BOT_TOKEN' in os.environ or 'FIXTURE_OTHER_SECRET' in os.environ or token in sys.argv:
    emit({'type': 'fatal', 'code': 'READER_STARTUP'})
    sys.exit(0)
emit({'type': 'ready', 'protocol': 1})
for line in sys.stdin:
    request = json.loads(line)
    mode = request['userId'][-3:]
    code = {'112': 'READER_VERIFICATION', '113': 'READER_AUTH', '114': 'READER_ACCESS'}.get(mode)
    if code:
        emit({'id': request['id'], 'ok': False, 'code': code})
        sys.exit(0)
    if mode == '115':
        emit({'id': request['id'], 'ok': False, 'code': 'RATE_LIMIT', 'retryAfterMs': 180000})
    elif mode == '116':
        print('not JSON', flush=True)
    elif mode == '117':
        sys.stdout.write('x' * 8192)
        sys.stdout.flush()
    elif mode == '118':
        time.sleep(10)
    elif mode == '120':
        sys.exit(0)
    else:
        if mode == '119':
            print('sensitive third party log must be suppressed', file=sys.stderr, flush=True)
        emit({'id': request['id'], 'ok': True, 'dates': {
            'premium_since': '2022-01-01T00:00:00+00:00',
            'premium_guild_since': '2023-06-01T00:00:00+00:00',
        }})
