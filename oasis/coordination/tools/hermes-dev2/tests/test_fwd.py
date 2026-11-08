"""The per-job forwarder: one fresh proxy connection per relay, so a proxy restart never cuts a job off."""

import asyncio
import os
import tempfile
import unittest

from _load import load

fwd = load("bin/hermes_fwd.py", "hermes_fwd")


class ForwarderTest(unittest.TestCase):
    def test_survives_a_proxy_restart(self):
        async def scenario():
            d = tempfile.mkdtemp(dir="/tmp")
            path = os.path.join(d, "p.sock")

            async def proxy(tag):
                async def echo(r, w):
                    data = await r.read(100)
                    w.write(tag + data)
                    await w.drain()
                    w.close()
                return await asyncio.start_unix_server(echo, path)

            async def ask(port):
                r, w = await asyncio.open_connection("127.0.0.1", port)
                w.write(b"ping")
                await w.drain()
                w.write_eof()
                out = await asyncio.wait_for(r.read(), 5)
                w.close()
                return out

            first = await proxy(b"one:")
            relay = await asyncio.start_server(fwd.make_relay(path, asyncio.Semaphore(4)), "127.0.0.1", 0)
            port = relay.sockets[0].getsockname()[1]
            try:
                self.assertEqual(await ask(port), b"one:ping")
                first.close()
                await first.wait_closed()
                if os.path.exists(path):
                    os.unlink(path)  # the proxy restarts: a NEW socket file in the same (preserved) folder
                second = await proxy(b"two:")
                self.assertEqual(await ask(port), b"two:ping")  # same forwarder, no restart
                second.close()
                await second.wait_closed()
            finally:
                relay.close()
                await relay.wait_closed()
                if os.path.exists(path):
                    os.unlink(path)
                os.rmdir(d)

        asyncio.run(scenario())

    def test_handles_sigterm_as_pid_1(self):
        src = (fwd.__file__ and open(fwd.__file__).read())
        self.assertIn("loop.add_signal_handler(sig, stop.set)", src)
        self.assertIn("signal.SIGTERM", src)

    def test_half_open_side_is_cut_after_the_timeout_not_held_forever(self):
        """A client that stops reading AND writing after one side has closed (no EOF, no
        data) must not hold the forwarder's relay for IDLE_TIMEOUT (15 min): _both cancels
        the still-open direction once nothing has moved for half_open_timeout."""
        async def scenario():
            cancelled = asyncio.Event()

            async def closes_at_once():
                return  # simulates one direction hitting EOF right away

            async def never_closes_never_sends():
                try:
                    await asyncio.sleep(1000)
                except asyncio.CancelledError:
                    cancelled.set()
                    raise

            last = [asyncio.get_running_loop().time()]
            started = asyncio.get_running_loop().time()
            await fwd._both(closes_at_once(), never_closes_never_sends(), last,
                            half_open_timeout=0.3, poll=0.05)
            elapsed = asyncio.get_running_loop().time() - started
            self.assertLess(elapsed, 2.0)  # cut well before IDLE_TIMEOUT, not hung
            self.assertTrue(cancelled.is_set())

        asyncio.run(scenario())

    def test_half_open_timeout_resets_while_the_open_side_keeps_moving_bytes(self):
        """If the still-open side keeps moving data, the half-open clock doesn't fire early."""
        async def scenario():
            async def closes_at_once():
                return

            async def sends_for_a_while():
                loop = asyncio.get_running_loop()
                for _ in range(4):
                    await asyncio.sleep(0.1)
                    last[0] = loop.time()  # a real pipe would bump this on every chunk
                return

            last = [asyncio.get_running_loop().time()]
            started = asyncio.get_running_loop().time()
            await fwd._both(closes_at_once(), sends_for_a_while(), last, half_open_timeout=0.3, poll=0.05)
            elapsed = asyncio.get_running_loop().time() - started
            self.assertGreaterEqual(elapsed, 0.4)  # ran to completion, not cut by the half-open timeout

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
