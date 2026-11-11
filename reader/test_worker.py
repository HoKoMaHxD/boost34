import asyncio
import io
import json
import unittest
from datetime import datetime, timezone, timedelta
from types import SimpleNamespace
from unittest.mock import patch
import worker

USER_ID = '141947703742562304'

class FakeClient:
    def __init__(self, result=None, error=None):
        self.result = result
        self.error = error
        self.calls = []
    async def fetch_user_profile(self, user_id, **kwargs):
        self.calls.append((user_id, kwargs))
        if self.error:
            raise self.error
        return self.result

def api_error(status, code=None):
    error = RuntimeError('sensitive exception details must not leave the worker')
    error.status = status
    error.code = code
    return error

class WorkerTests(unittest.IsolatedAsyncioTestCase):
    async def call(self, client, user_id=USER_ID):
        return await worker.handle(client, {'id': '1', 'userId': user_id})

    async def test_extracts_only_subscription_dates_and_skips_mutual_data(self):
        since = datetime(2022, 1, 1, tzinfo=timezone.utc)
        client = FakeClient(SimpleNamespace(premium_since=since, premium_guild_since=None, bio='private content'))
        reply, fatal = await self.call(client)
        self.assertFalse(fatal)
        self.assertEqual(reply, {'id': '1', 'ok': True, 'dates': {'premium_since': since.isoformat(), 'premium_guild_since': None}})
        self.assertEqual(client.calls, [(int(USER_ID), {'with_mutual_guilds': False, 'with_mutual_friends_count': False, 'with_mutual_friends': False})])

    async def test_invalid_ids_do_not_contact_client(self):
        client = FakeClient()
        for user_id in ['abc', '1', '١٤١٩٤٧٧٠٣٧٤٢٥٦٢٣٠٤', USER_ID + '000', 141947703742562304]:
            reply, fatal = await self.call(client, user_id)
            self.assertEqual(reply['code'], 'INVALID_TARGET')
            self.assertFalse(fatal)
        self.assertEqual(client.calls, [])

    async def test_private_and_blocked_profiles_are_not_reported_as_no_nitro(self):
        for profile in [SimpleNamespace(private=True), SimpleNamespace(is_blocker=lambda: True)]:
            reply, fatal = await self.call(FakeClient(profile))
            self.assertEqual(reply['code'], 'PROFILE_PRIVATE')
            self.assertFalse(fatal)

    async def test_invalid_dates_are_not_passed_as_valid(self):
        for value in ['invalid', datetime(2022, 1, 1), datetime.now(timezone.utc) + timedelta(days=1)]:
            reply, fatal = await self.call(FakeClient(SimpleNamespace(premium_since=value)))
            self.assertEqual(reply['code'], 'UNAVAILABLE')
            self.assertFalse(fatal)

    async def test_auth_verification_and_forbidden_are_terminal_and_redacted(self):
        for error, expected in [(api_error(401), 'READER_AUTH'), (api_error(403), 'READER_ACCESS'), (api_error(403, 40002), 'READER_VERIFICATION'), (type('CaptchaRequired', (Exception,), {})('sensitive'), 'READER_VERIFICATION')]:
            reply, fatal = await self.call(FakeClient(error=error))
            self.assertTrue(fatal)
            self.assertEqual(reply['code'], expected)
            self.assertNotIn('sensitive', json.dumps(reply))

    async def test_not_found_and_network_failures_are_nonterminal(self):
        for error, expected in [(api_error(404), 'PROFILE_NOT_FOUND'), (OSError('sensitive'), 'NETWORK'), (asyncio.TimeoutError(), 'NETWORK')]:
            reply, fatal = await self.call(FakeClient(error=error))
            self.assertFalse(fatal)
            self.assertEqual(reply['code'], expected)

    async def test_library_retry_delay_is_preserved(self):
        error = type('RateLimited', (Exception,), {})('sensitive')
        error.retry_after = 180.25
        reply, fatal = await self.call(FakeClient(error=error))
        self.assertFalse(fatal)
        self.assertEqual(reply, {'id': '1', 'ok': False, 'code': 'RATE_LIMIT', 'retryAfterMs': 180250})

    async def test_gateway_disconnect_is_reported_even_without_a_command(self):
        class Client:
            def __init__(self, **options):
                self.options = options
            def event(self, handler):
                self.ready = handler
                return handler
            async def start(self, token, reconnect):
                assert reconnect is False
                await self.ready()
                await asyncio.sleep(0.1)
                raise OSError('sensitive gateway failure')
            async def close(self):
                pass
        class IdleInput:
            def readline(self, length):
                # A daemon input thread remains blocked while the gateway exits.
                import threading
                threading.Event().wait()
        discord = SimpleNamespace(Client=Client, MemberCacheFlags=SimpleNamespace(none=lambda: None))
        output = io.StringIO()
        with patch.object(worker, 'PROTOCOL_OUT', output), patch.object(worker.sys, 'stdin', SimpleNamespace(buffer=IdleInput())):
            await asyncio.wait_for(worker.serve(discord, 'fixture-token'), timeout=2)
        messages = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(messages, [{'type': 'ready', 'protocol': 1}, {'type': 'fatal', 'code': 'READER_CLOSED'}])

if __name__ == '__main__':
    unittest.main()
