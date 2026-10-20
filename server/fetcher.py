"""The fetcher: the song server's only way out to the internet, and the rules it follows.

A server that downloads URLs for visitors is a classic target: a visitor could ask it to read a
machine on the home network (server-side request forgery), to download something huge, or to
hammer a small music site. Every outbound request therefore goes through one `Fetcher`, which
enforces each rule of the constitution's "Song Server Constraints" in one place:

1. Allow-list. Only `https` URLs on a few music sites, on the default port, are fetched. A
   redirect is followed by hand, and only when it stays on the list.
2. No private networks. The site's name is resolved first, and every address must be public:
   not LAN, loopback, link-local, carrier-grade NAT, multicast or reserved. The request then
   connects to the address that was checked (the name still goes in the Host header and in TLS),
   so a second DNS answer cannot swap in a private address between the check and the connection.
3. Caps. A response may hold at most 2 MB, counted while it streams, and must arrive within
   10 seconds.
4. Sniffing. The first bytes say what the content is (MIDI starts with "MThd", an ABC tune has an
   "X:" line, JSON and HTML have their own openings), and the caller says which kinds it accepts.
5. Politeness. Requests to the same site start at least 1 second apart, and each one carries the
   project's User-Agent, so the site's owner can see who is asking.
6. A temporary cache. Answers stay in memory for at most 24 hours, in at most 200 MB, and the
   least recently used ones leave first. Nothing is written to disk.

The network transport, the DNS resolver and the clock are parameters, so the tests run every rule
against a fake internet. Error messages name the site, never the full URL, because a search URL
holds the visitor's query and the server logs no visitor data.
"""

import ipaddress
import json
import logging
import re
import socket
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Collection
from dataclasses import dataclass

import httpx

ALLOWED_HOSTS = frozenset(
    {"www.beakauffmann.com", "www.mutopiaproject.org", "bitmidi.com", "imslp.org"}
)
USER_AGENT = "nes-genetic-arranger/1.0 (+https://github.com/GiowGiow/nes-genetic-arranger)"
MAX_BYTES = 2 * 1024 * 1024
TIMEOUT_SECONDS = 10.0
HOST_SPACING_SECONDS = 1.0
MAX_REDIRECTS = 5
CACHE_BYTES = 200 * 1024 * 1024
CACHE_TTL_SECONDS = 24 * 3600

SNIFF_BYTES = 4096  # an ABC tune's X: line or an HTML opening shows up well within this

# httpx logs every request URL at INFO level, and a search URL holds the visitor's query.
for library in ("httpx", "httpcore"):
    logging.getLogger(library).setLevel(logging.WARNING)


class FetchError(Exception):
    """A fetch the server refused or could not finish; the message names the site only."""


class Blocked(FetchError):
    """The URL, a redirect or an address the site resolves to is not allowed."""


class Unreachable(FetchError):
    """The site did not answer, answered with an error status, or was too slow."""


class TooLarge(FetchError):
    """The response is over the size cap."""


class WrongContent(FetchError):
    """The response is not the kind of content the caller asked for."""


@dataclass(frozen=True)
class Fetched:
    """A downloaded response: the final URL (after redirects), its bytes and their sniffed kind."""

    url: str
    content: bytes
    kind: str | None


def sniff(content: bytes) -> str | None:
    """Say what a response holds from its first bytes: "midi", "abc", "json", "html" or None.

    >>> sniff(b"MThd\\x00\\x00\\x00\\x06")
    'midi'
    >>> sniff(b"%abc-2.1\\nX:1\\nT:Polka\\n")
    'abc'
    >>> sniff(b'{"results": []}'), sniff(b"<!DOCTYPE html><html></html>")
    ('json', 'html')
    >>> sniff(b"\\x00\\x01 something else") is None
    True
    """
    if content.startswith(b"MThd"):
        return "midi"
    head = content[:SNIFF_BYTES].decode("utf-8", errors="replace").lstrip("﻿ \t\r\n")
    if head[:1] in ("{", "["):
        try:
            json.loads(content.decode("utf-8-sig"))
        except ValueError:
            return None
        return "json"
    lowered = head[:1024].lower()
    if lowered.startswith(("<!doctype html", "<html")) or "<html" in lowered:
        return "html"
    if re.search(r"(?m)^X:", head):
        return "abc"
    return None


def is_public_address(address: str) -> bool:
    """Whether an IP address is on the public internet, so the server may connect to it.

    LAN, loopback, link-local, carrier-grade NAT (100.64.0.0/10), multicast, reserved and
    documentation ranges are not; nor is an IPv6 address that embeds such an IPv4 address.

    >>> is_public_address("93.184.216.34")
    True
    >>> [is_public_address(a) for a in ("10.1.2.3", "100.64.0.1", "169.254.169.254", "::1")]
    [False, False, False, False]
    """
    ip = ipaddress.ip_address(address)
    if isinstance(ip, ipaddress.IPv6Address):
        embedded = ip.ipv4_mapped or ip.sixtofour or (ip.teredo[1] if ip.teredo else None)
        if embedded is not None and not is_public_address(str(embedded)):
            return False
    return ip.is_global and not ip.is_multicast and not ip.is_reserved


def resolve_host(host: str) -> list[str]:
    """Return the IP addresses a host name resolves to (the real DNS; tests pass a fake)."""
    infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(str(info[4][0]) for info in infos))


class ResponseCache:
    """An in-memory LRU cache of responses, bounded in bytes and in age.

    Thread-safe: the server answers requests from several threads.
    """

    def __init__(
        self,
        max_bytes: int = CACHE_BYTES,
        ttl: float = CACHE_TTL_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.max_bytes = max_bytes
        self.ttl = ttl
        self.clock = clock
        self.size_bytes = 0
        self._entries: OrderedDict[str, tuple[float, Fetched]] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str) -> Fetched | None:
        """Return the cached response for `key`, or None when absent or older than the TTL."""
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return None
            stored_at, fetched = entry
            if self.clock() - stored_at > self.ttl:
                self._drop(key)
                return None
            self._entries.move_to_end(key)
            return fetched

    def put(self, key: str, fetched: Fetched) -> None:
        """Store a response, dropping the least recently used ones until it fits."""
        size = len(fetched.content)
        if size > self.max_bytes:
            return
        with self._lock:
            if key in self._entries:
                self._drop(key)
            self._entries[key] = (self.clock(), fetched)
            self.size_bytes += size
            while self.size_bytes > self.max_bytes:
                self._drop(next(iter(self._entries)))

    def _drop(self, key: str) -> None:
        _, fetched = self._entries.pop(key)
        self.size_bytes -= len(fetched.content)


class Fetcher:
    """Download allow-listed URLs under the rules in the module docstring."""

    def __init__(
        self,
        transport: httpx.BaseTransport | None = None,
        resolver: Callable[[str], list[str]] = resolve_host,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        cache: ResponseCache | None = None,
        allowed_hosts: Collection[str] = ALLOWED_HOSTS,
    ) -> None:
        # No connection reuse: two allowed sites may share an address (a CDN), and a pooled TLS
        # connection opened for one name must not carry a request for the other.
        self._client = httpx.Client(
            transport=transport,
            follow_redirects=False,
            trust_env=False,
            timeout=TIMEOUT_SECONDS,
            limits=httpx.Limits(max_keepalive_connections=0),
        )
        self.resolver = resolver
        self.clock = clock
        self.sleep = sleep
        self.cache = cache if cache is not None else ResponseCache(clock=clock)
        self.allowed_hosts = frozenset(allowed_hosts)
        self._next_turn: dict[str, float] = {}
        self._turn_lock = threading.Lock()

    def get(self, url: str, kinds: Collection[str]) -> Fetched:
        """Download `url` (or take it from the cache) and check that its content is of `kinds`.

        Raises:
            Blocked: off the allow-list, a private address, or a redirect off the list.
            Unreachable: no answer, an error status, too many redirects or over 10 seconds.
            TooLarge: over 2 MB.
            WrongContent: the sniffed kind is not one of `kinds`.
        """
        fetched = self.cache.get(url)
        if fetched is None:
            fetched = self._download(httpx.URL(url))
            self.cache.put(url, fetched)
        if fetched.kind not in kinds:
            host = httpx.URL(fetched.url).host
            raise WrongContent(f"{host} sent {fetched.kind or 'unknown content'}")
        return fetched

    def _download(self, url: httpx.URL) -> Fetched:
        current = url
        for _ in range(MAX_REDIRECTS + 1):
            addresses = self._checked_addresses(current)
            self._wait_turn(current.host)
            deadline = self.clock() + TIMEOUT_SECONDS
            response = self._send(current, addresses)
            try:
                if response.is_redirect:
                    current = current.join(response.headers["location"])
                    continue
                if response.status_code != 200:
                    raise Unreachable(f"{current.host} answered HTTP {response.status_code}")
                content = self._read(response, current.host, deadline)
            finally:
                response.close()
            return Fetched(url=str(current), content=content, kind=sniff(content))
        raise Unreachable(f"{url.host} redirected more than {MAX_REDIRECTS} times")

    def _checked_addresses(self, url: httpx.URL) -> list[str]:
        """The site's addresses, IPv4 first, after checking the URL and every address."""
        if url.scheme != "https" or url.port not in (None, 443) or url.userinfo:
            raise Blocked(f"only plain https URLs are fetched, not {url.scheme}://{url.host}")
        if url.host not in self.allowed_hosts:
            raise Blocked(f"{url.host} is not on the allow-list")
        try:
            addresses = self.resolver(url.host)
        except OSError:
            raise Unreachable(f"{url.host} does not resolve") from None
        if not addresses:
            raise Unreachable(f"{url.host} does not resolve")
        if not all(is_public_address(address) for address in addresses):
            raise Blocked(f"{url.host} resolves to a private address")
        return sorted(addresses, key=lambda address: ":" in address)

    def _wait_turn(self, host: str) -> None:
        """Wait until at least HOST_SPACING_SECONDS have passed since the last turn of `host`.

        Each caller books the next free turn under the lock and then sleeps outside it, so
        requests to one site are spaced out without holding up requests to other sites.
        """
        with self._turn_lock:
            now = self.clock()
            turn = max(now, self._next_turn.get(host, now))
            self._next_turn[host] = turn + HOST_SPACING_SECONDS
        if turn > now:
            self.sleep(turn - now)

    def _send(self, url: httpx.URL, addresses: list[str]) -> httpx.Response:
        """Send the request to each checked address in turn until one accepts the connection."""
        for address in addresses:
            request = self._client.build_request(
                "GET",
                url.copy_with(host=address),
                headers={"Host": url.host, "User-Agent": USER_AGENT, "Accept-Encoding": "identity"},
                extensions={"sni_hostname": url.host},
            )
            try:
                return self._client.send(request, stream=True)
            except httpx.ConnectError:
                continue
            except httpx.HTTPError as error:
                raise Unreachable(f"{url.host} did not answer ({type(error).__name__})") from None
        raise Unreachable(f"{url.host} refused the connection")

    def _read(self, response: httpx.Response, host: str, deadline: float) -> bytes:
        """Read the body, stopping as soon as it passes the size cap or the deadline."""
        declared = response.headers.get("content-length", "")
        if declared.isdigit() and int(declared) > MAX_BYTES:
            raise TooLarge(f"{host} sent more than {MAX_BYTES} bytes")
        body = bytearray()
        try:
            for chunk in response.iter_bytes():
                body += chunk
                if len(body) > MAX_BYTES:
                    raise TooLarge(f"{host} sent more than {MAX_BYTES} bytes")
                if self.clock() > deadline:
                    raise Unreachable(f"{host} took more than {TIMEOUT_SECONDS:g} seconds")
        except httpx.HTTPError as error:
            raise Unreachable(f"{host} broke off the answer ({type(error).__name__})") from None
        return bytes(body)
