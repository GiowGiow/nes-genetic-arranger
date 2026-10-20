"""Fakes for the song server tests: a fake internet, a fake DNS and a fake clock.

No test touches the network (constitution, "Song Server Constraints"). The fetcher sends each
request to the address it checked, with the site's name in the Host header, so the fake internet
answers by Host header and path, as a real web server would.
"""

from collections.abc import Callable

import httpx

# Public addresses (never contacted: the transport is fake). Documentation ranges such as
# 203.0.113.0/24 would not do, because the fetcher refuses them as reserved.
PUBLIC_DNS = {
    "www.beakauffmann.com": ["93.184.216.34"],
    "www.mutopiaproject.org": ["93.184.216.35"],
    "bitmidi.com": ["93.184.216.36"],
    "imslp.org": ["93.184.216.37"],
}

Answer = Callable[[httpx.Request], httpx.Response]


class FakeInternet:
    """Answers requests by their original URL (Host header + path) and records every request."""

    def __init__(self) -> None:
        self.answers: dict[str, Answer] = {}
        self.requests: list[httpx.Request] = []

    def add(
        self,
        url: str,
        content: bytes = b"",
        status: int = 200,
        headers: dict[str, str] | None = None,
    ) -> None:
        """Serve `content` at `url` (a fresh response for every request)."""
        self.answers[url] = lambda request: httpx.Response(
            status, content=content, headers=headers or {}
        )

    def add_answer(self, url: str, answer: Answer) -> None:
        """Serve `url` with a function of the request (for streams, errors and timing)."""
        self.answers[url] = answer

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        url = f"https://{request.headers['host']}{request.url.raw_path.decode('ascii')}"
        answer = self.answers.get(url)
        return answer(request) if answer else httpx.Response(404, content=b"not here")

    def urls(self) -> list[str]:
        """The original URLs requested so far, in order."""
        return [
            f"https://{r.headers['host']}{r.url.raw_path.decode('ascii')}" for r in self.requests
        ]


class FakeClock:
    """A monotonic clock that only moves when the code under test sleeps (or a test says so)."""

    def __init__(self) -> None:
        self.now = 1000.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def fake_resolver(table: dict[str, list[str]]) -> Callable[[str], list[str]]:
    """A DNS that knows only `table`; other names fail like an unknown host."""

    def resolve(host: str) -> list[str]:
        if host not in table:
            raise OSError(f"unknown host {host}")
        return table[host]

    return resolve
