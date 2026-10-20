"""Per-visitor rate limits, kept only in memory: token buckets keyed by the visitor's address.

A token bucket holds up to N tokens and refills at N per minute. Each request takes one token; a
request that finds the bucket empty is refused with the time until the next token, which the app
sends as `Retry-After`. So a visitor may make a short burst of N requests, and then N a minute.

Each visitor has two buckets: 60 tokens for every request, and 20 for searches, which cost the
upstream sites the most. A search needs a token from both; when either is empty, neither is
spent, so a refused search does not eat into the visitor's other requests.

The visitor is the first address in `X-Forwarded-For`, which the reverse proxy (Traefik) sets,
or the connecting address when there is no proxy. These addresses live only here, in memory, and
a visitor idle for a minute (whose buckets are full again) is forgotten, so the table stays small.
"""

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

REQUESTS_PER_MINUTE = 60
SEARCHES_PER_MINUTE = 20
MAX_VISITORS = 10_000


def client_key(forwarded_for: str | None, peer: str | None) -> str:
    """Return the visitor's address: the first hop of X-Forwarded-For, else the peer address.

    >>> client_key("198.51.100.7, 10.42.0.1", "10.42.0.9")
    '198.51.100.7'
    >>> client_key(None, "10.42.0.9")
    '10.42.0.9'
    """
    first_hop = (forwarded_for or "").split(",")[0].strip()
    return first_hop or peer or "unknown"


@dataclass
class TokenBucket:
    """Up to `capacity` tokens, refilled continuously at `capacity` per minute."""

    capacity: float
    tokens: float
    updated: float

    def refill(self, now: float) -> None:
        """Add the tokens earned since the last update, up to the capacity."""
        earned = (now - self.updated) * self.capacity / 60.0
        self.tokens = min(self.capacity, self.tokens + earned)
        self.updated = now

    def wait(self) -> float:
        """Seconds until one whole token is available (0 when one is available now)."""
        return 0.0 if self.tokens >= 1 else (1 - self.tokens) * 60.0 / self.capacity


class RateLimiter:
    """The buckets of every recent visitor. Thread-safe."""

    def __init__(
        self,
        clock: Callable[[], float] = time.monotonic,
        requests_per_minute: int = REQUESTS_PER_MINUTE,
        searches_per_minute: int = SEARCHES_PER_MINUTE,
        max_visitors: int = MAX_VISITORS,
    ) -> None:
        self.clock = clock
        self.requests_per_minute = requests_per_minute
        self.searches_per_minute = searches_per_minute
        self.max_visitors = max_visitors
        self._buckets: dict[str, tuple[TokenBucket, TokenBucket]] = {}
        self._lock = threading.Lock()

    def check(self, visitor: str, search: bool) -> float:
        """Spend a token for one request; return 0, or the seconds to wait when refused."""
        with self._lock:
            now = self.clock()
            buckets = self._buckets.get(visitor)
            if buckets is None:
                if len(self._buckets) >= self.max_visitors:
                    self._forget_idle(now)
                buckets = (
                    TokenBucket(self.requests_per_minute, self.requests_per_minute, now),
                    TokenBucket(self.searches_per_minute, self.searches_per_minute, now),
                )
                self._buckets[visitor] = buckets
            needed = buckets if search else buckets[:1]
            for bucket in needed:
                bucket.refill(now)
            wait = max(bucket.wait() for bucket in needed)
            if wait == 0:
                for bucket in needed:
                    bucket.tokens -= 1
            return wait

    def visitor_count(self) -> int:
        """How many visitors are remembered right now."""
        with self._lock:
            return len(self._buckets)

    def _forget_idle(self, now: float) -> None:
        # After a minute without requests both buckets are full, so forgetting loses nothing.
        idle = [
            visitor
            for visitor, (requests, _) in self._buckets.items()
            if now - requests.updated >= 60.0
        ]
        for visitor in idle:
            del self._buckets[visitor]
