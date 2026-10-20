"""Per-visitor rate limits: 60 requests a minute, of which at most 20 searches."""

import pytest

from server.limits import RateLimiter, client_key
from tests.server.fakes import FakeClock


def test_the_visitor_is_the_first_hop_of_x_forwarded_for():
    assert client_key("198.51.100.7, 10.42.0.1", "10.42.0.9") == "198.51.100.7"
    assert client_key(" 198.51.100.7 ", "10.42.0.9") == "198.51.100.7"


def test_without_x_forwarded_for_the_visitor_is_the_connecting_address():
    assert client_key(None, "10.42.0.9") == "10.42.0.9"
    assert client_key("", "10.42.0.9") == "10.42.0.9"
    assert client_key(None, None) == "unknown"


def test_a_visitor_gets_60_requests_in_a_burst_and_then_waits_about_a_second():
    limiter = RateLimiter(clock=FakeClock())
    assert all(limiter.check("a", search=False) == 0 for _ in range(60))
    assert limiter.check("a", search=False) == pytest.approx(1.0)


def test_at_most_20_of_the_requests_may_be_searches():
    limiter = RateLimiter(clock=FakeClock())
    assert all(limiter.check("a", search=True) == 0 for _ in range(20))
    assert limiter.check("a", search=True) == pytest.approx(3.0)
    # Other requests still have their own 40 tokens left.
    assert all(limiter.check("a", search=False) == 0 for _ in range(40))
    assert limiter.check("a", search=False) > 0


def test_a_refused_search_does_not_spend_a_request_token():
    limiter = RateLimiter(clock=FakeClock())
    for _ in range(20):
        limiter.check("a", search=True)
    for _ in range(10):
        assert limiter.check("a", search=True) > 0
    assert all(limiter.check("a", search=False) == 0 for _ in range(40))


def test_tokens_come_back_with_time():
    clock = FakeClock()
    limiter = RateLimiter(clock=clock)
    for _ in range(60):
        limiter.check("a", search=False)
    clock.now += 30
    assert all(limiter.check("a", search=False) == 0 for _ in range(30))
    assert limiter.check("a", search=False) > 0


def test_each_visitor_has_its_own_budget():
    limiter = RateLimiter(clock=FakeClock())
    for _ in range(60):
        limiter.check("a", search=False)
    assert limiter.check("b", search=False) == 0


def test_idle_visitors_are_forgotten_so_memory_stays_bounded():
    clock = FakeClock()
    limiter = RateLimiter(clock=clock, max_visitors=3)
    for visitor in ("a", "b", "c"):
        limiter.check(visitor, search=False)
    clock.now += 61  # a minute later every bucket is full again, so nothing is lost
    limiter.check("d", search=False)
    assert limiter.visitor_count() == 1
