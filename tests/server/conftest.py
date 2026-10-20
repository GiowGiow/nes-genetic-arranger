"""Fixtures for the song server tests, built on the fakes in `fakes.py`."""

from collections.abc import Callable

import httpx
import pytest

from server.fetcher import Fetcher
from tests.server.fakes import PUBLIC_DNS, FakeClock, FakeInternet, fake_resolver


@pytest.fixture
def internet() -> FakeInternet:
    return FakeInternet()


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def make_fetcher(internet: FakeInternet, clock: FakeClock) -> Callable[..., Fetcher]:
    """Build a Fetcher on the fake internet, fake DNS and fake clock; keywords override."""

    def build(**overrides) -> Fetcher:
        options = {
            "transport": httpx.MockTransport(internet.handler),
            "resolver": fake_resolver(PUBLIC_DNS),
            "clock": clock,
            "sleep": clock.sleep,
        }
        options.update(overrides)
        return Fetcher(**options)

    return build
