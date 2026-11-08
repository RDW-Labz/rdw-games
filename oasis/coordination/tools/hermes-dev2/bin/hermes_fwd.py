#!/usr/bin/python3 -I
"""Per-job forwarder (decision #384), run by hermes-fwd@<id>.service as hermes-w.

The job and this forwarder share ONE private network namespace
(PrivateNetwork=yes + JoinsNamespaceOf=), which holds only a loopback
device. So nothing in it can reach dev2's host network, its listeners or
its abstract Unix sockets. This process listens on 127.0.0.1:JOB_PROXY_PORT
inside that namespace and relays each connection, byte for byte, to the
proxy's Unix socket (PROXY_SOCKET), the only host path bind-mounted in.
The job itself can't open Unix sockets at all (RestrictAddressFamilies=AF_INET).

Python stdlib only; at most MAX_CONNECTIONS relays at once. Each relay opens
a NEW connection to the proxy socket, so a proxy restart (the socket file is
recreated in the preserved /run/hermes-proxy) never cuts the forwarder off.

The unit runs with PrivatePIDs=yes, so this process is PID 1 of its own PID
namespace and the kernel ignores signals it has no handler for: SIGTERM and
SIGINT get explicit handlers so `systemctl stop` ends it at once.
"""

from __future__ import annotations

import asyncio
import os
import signal
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from hermes_dev2_common import load_config  # noqa: E402

MAX_CONNECTIONS = 4
IDLE_TIMEOUT = 900  # seconds without bytes either way, both directions open
HALF_OPEN_TIMEOUT = 120  # once one direction has closed: seconds with no bytes either way
HALF_OPEN_POLL = 1.0


async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, last: list[float]) -> None:
    """Copy one direction. On EOF, pass the half-close on (the other direction keeps flowing)."""
    loop = asyncio.get_running_loop()
    try:
        while data := await asyncio.wait_for(reader.read(65536), IDLE_TIMEOUT):
            last[0] = loop.time()
            writer.write(data)
            await writer.drain()
        if writer.can_write_eof():
            writer.write_eof()
    except (asyncio.TimeoutError, ConnectionError, OSError):
        pass


async def _both(a, b, last: list[float], half_open_timeout: float = HALF_OPEN_TIMEOUT,
                poll: float = HALF_OPEN_POLL) -> None:
    """Run both directions. When one ends, give the other until no bytes have
    moved either way for `half_open_timeout`, then cancel it, so a client that
    never closes its side can't hold a slot for IDLE_TIMEOUT."""
    loop = asyncio.get_running_loop()
    pending = {asyncio.ensure_future(a), asyncio.ensure_future(b)}
    _, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
    while pending:
        _, pending = await asyncio.wait(pending, timeout=poll)
        if pending and loop.time() - last[0] > half_open_timeout:
            for t in pending:
                t.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            return


def _close(*writers: asyncio.StreamWriter) -> None:
    for w in writers:
        try:
            w.close()
        except Exception:  # noqa: BLE001
            pass


def make_relay(socket_path: str, slots: asyncio.Semaphore):
    async def relay(client_r: asyncio.StreamReader, client_w: asyncio.StreamWriter) -> None:
        if slots.locked():
            client_w.close()
            return
        async with slots:
            try:
                up_r, up_w = await asyncio.open_unix_connection(socket_path)
            except OSError:
                client_w.close()
                return
            last = [asyncio.get_running_loop().time()]
            try:
                await _both(_pipe(client_r, up_w, last), _pipe(up_r, client_w, last), last)
            finally:
                _close(up_w, client_w)
    return relay


async def serve(host: str, port: int, socket_path: str) -> None:
    server = await asyncio.start_server(make_relay(socket_path, asyncio.Semaphore(MAX_CONNECTIONS)), host, port)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    async with server:
        await stop.wait()


def main() -> None:
    config = load_config()
    asyncio.run(serve("127.0.0.1", int(config["JOB_PROXY_PORT"]), config["PROXY_SOCKET"]))


if __name__ == "__main__":
    main()
