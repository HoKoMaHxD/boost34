"""Single credential, one client, serial profile reads over private stdio.

No credential discovery, CAPTCHA solving, alternate credentials, proxy rotation,
raw HTTP profile fallback, or automatic re-login after a terminal error.
"""
import asyncio
import json
import logging
import math
import os
import queue
import sys
import threading
import warnings
from datetime import datetime, timezone
from dependencies import inspect_runtime

PROTOCOL_OUT = sys.stdout
logging.disable(logging.CRITICAL)
warnings.filterwarnings('ignore')


def emit(value):
    PROTOCOL_OUT.write(json.dumps(value, separators=(',', ':')) + '\n')
    PROTOCOL_OUT.flush()


def classify(error):
    status = getattr(error, 'status', None)
    code = getattr(error, 'code', None)
    name = type(error).__name__
    if code == 40002 or name == 'CaptchaRequired':
        return 'READER_VERIFICATION', True
    if status == 401 or name == 'LoginFailure':
        return 'READER_AUTH', True
    if status == 403:
        return 'READER_ACCESS', True
    if status == 429 or name == 'RateLimited':
        return 'RATE_LIMIT', False
    if status == 404 or name == 'NotFound':
        return 'PROFILE_NOT_FOUND', False
    if isinstance(error, (asyncio.TimeoutError, ConnectionError, OSError)):
        return 'NETWORK', False
    return 'UNAVAILABLE', False


def dates_only(profile):
    dates = {}
    for field in ('premium_since', 'premium_guild_since'):
        value = getattr(profile, field, None)
        if value is None:
            dates[field] = None
        elif isinstance(value, datetime) and value.tzinfo is not None and value <= datetime.now(timezone.utc):
            dates[field] = value.astimezone(timezone.utc).isoformat()
        else:
            raise ValueError('Invalid timestamp')
    return dates


async def handle(client, request):
    request_id = request.get('id')
    user_id = request.get('userId')
    if not isinstance(request_id, str) or len(request_id) > 30 or not isinstance(user_id, str) or not user_id.isascii() or not user_id.isdigit() or not 17 <= len(user_id) <= 20:
        return {'id': request_id, 'ok': False, 'code': 'INVALID_TARGET'}, False
    try:
        profile = await asyncio.wait_for(client.fetch_user_profile(
            int(user_id), with_mutual_guilds=False,
            with_mutual_friends_count=False, with_mutual_friends=False,
        ), timeout=30)
        if getattr(profile, 'private', False) is True or (hasattr(profile, 'is_blocker') and profile.is_blocker()):
            return {'id': request_id, 'ok': False, 'code': 'PROFILE_PRIVATE'}, False
        return {'id': request_id, 'ok': True, 'dates': dates_only(profile)}, False
    except Exception as error:
        code, fatal = classify(error)
        reply = {'id': request_id, 'ok': False, 'code': code}
        retry_after = getattr(error, 'retry_after', None)
        if code == 'RATE_LIMIT' and isinstance(retry_after, (int, float)) and math.isfinite(retry_after) and retry_after > 0:
            reply['retryAfterMs'] = math.ceil(retry_after * 1000)
        return reply, fatal


async def serve(discord, token):
    ready = asyncio.Event()
    # No member scan/history fetch. Presence/session transport is managed by the
    # library. The application only calls the documented profile wrapper method.
    client = discord.Client(chunk_guilds_at_startup=False,
                            member_cache_flags=discord.MemberCacheFlags.none(),
                            guild_subscriptions=False,
                            max_ratelimit_timeout=30.0)
    @client.event
    async def on_ready():
        ready.set()

    runner = asyncio.create_task(client.start(token, reconnect=False))
    ready_wait = asyncio.create_task(ready.wait())
    try:
        done, _ = await asyncio.wait({runner, ready_wait}, timeout=45,
                                     return_when=asyncio.FIRST_COMPLETED)
        if runner in done:
            try:
                await runner
                emit({'type': 'fatal', 'code': 'READER_STARTUP'})
            except Exception as error:
                code, fatal = classify(error)
                emit({'type': 'fatal', 'code': code if fatal else 'READER_STARTUP'})
            return
        if not ready.is_set():
            emit({'type': 'fatal', 'code': 'READER_STARTUP'})
            return
        emit({'type': 'ready', 'protocol': 1})
        # A daemon owns blocking stdin; polling the bounded inbox lets the main
        # loop notice a disconnected gateway without waiting for another command.
        inbox = queue.Queue(maxsize=3)
        def read_input():
            while True:
                raw = sys.stdin.buffer.readline(4097)
                inbox.put(raw)
                if not raw or len(raw) > 4096:
                    return
        threading.Thread(target=read_input, daemon=True).start()
        while not runner.done():
            try:
                raw = inbox.get_nowait()
            except queue.Empty:
                await asyncio.sleep(0.05)
                continue
            if not raw:
                return
            if len(raw) > 4096:
                emit({'type': 'fatal', 'code': 'READER_PROTOCOL'})
                return
            try:
                request = json.loads(raw)
                if not isinstance(request, dict):
                    raise ValueError()
            except Exception:
                emit({'type': 'fatal', 'code': 'READER_PROTOCOL'})
                return
            reply, fatal = await handle(client, request)
            emit(reply)
            if fatal:
                emit({'type': 'fatal', 'code': reply['code']})
                return
        try:
            await runner
            emit({'type': 'fatal', 'code': 'READER_CLOSED'})
        except Exception as error:
            code, fatal = classify(error)
            emit({'type': 'fatal', 'code': code if fatal else 'READER_CLOSED'})
    finally:
        ready_wait.cancel()
        await client.close()
        if not runner.done():
            runner.cancel()
        await asyncio.gather(runner, ready_wait, return_exceptions=True)


def main():
    # Silence all third-party stdout/stderr, including import-time diagnostics.
    # Only emit() can write to the original protocol channel.
    sys.stdout = open(os.devnull, 'w')
    sys.stderr = open(os.devnull, 'w')
    token = os.environ.get('READER_TOKEN', '').strip()
    if not token:
        emit({'type': 'fatal', 'code': 'READER_AUTH'})
        return
    report, discord = inspect_runtime()
    if discord is None:
        emit({'type': 'fatal', 'code': report['code']})
        return
    try:
        asyncio.run(serve(discord, token))
    except BaseException:
        emit({'type': 'fatal', 'code': 'READER_CLOSED'})


if __name__ == '__main__':
    main()
