"""The fetcher is the server's only door to the internet: these tests pin its safety rules."""

import httpx
import pytest

from server.fetcher import (
    MAX_BYTES,
    USER_AGENT,
    Blocked,
    Fetched,
    ResponseCache,
    TooLarge,
    Unreachable,
    WrongContent,
    sniff,
)
from tests.server.fakes import PUBLIC_DNS, fake_resolver

MIDI = b"MThd\x00\x00\x00\x06\x00\x01\x00\x02\x01\xe0MTrk\x00\x00\x00\x00"
SONG_URL = "https://www.beakauffmann.com/mpb_a/som/song.mid"


def test_a_host_off_the_allow_list_is_refused_without_any_request(make_fetcher, internet):
    fetcher = make_fetcher(resolver=fake_resolver({"evil.example": ["93.184.216.99"]}))
    with pytest.raises(Blocked):
        fetcher.get("https://evil.example/song.mid", {"midi"})
    assert internet.requests == []


@pytest.mark.parametrize(
    "url",
    [
        "http://www.beakauffmann.com/song.mid",  # not https
        "https://www.beakauffmann.com:8443/song.mid",  # another port
        "https://user@www.beakauffmann.com/song.mid",  # credentials in the URL
        "ftp://www.beakauffmann.com/song.mid",
    ],
)
def test_only_plain_https_urls_on_the_default_port_are_fetched(make_fetcher, internet, url):
    with pytest.raises(Blocked):
        make_fetcher().get(url, {"midi"})
    assert internet.requests == []


@pytest.mark.parametrize(
    "address",
    [
        "10.0.0.5",  # private (LAN)
        "172.16.3.4",  # private
        "192.168.1.10",  # private (home router)
        "127.0.0.1",  # loopback
        "169.254.169.254",  # link-local (cloud metadata)
        "100.64.0.1",  # CGNAT (shared address space)
        "0.0.0.0",  # unspecified
        "::1",  # IPv6 loopback
        "fe80::1",  # IPv6 link-local
        "fd00::1",  # IPv6 unique local
        "::ffff:10.0.0.1",  # IPv4-mapped private address
        "224.0.0.1",  # multicast
    ],
)
def test_an_allowed_host_that_resolves_to_a_private_address_is_refused(
    make_fetcher, internet, address
):
    fetcher = make_fetcher(resolver=fake_resolver({"www.beakauffmann.com": [address]}))
    with pytest.raises(Blocked):
        fetcher.get(SONG_URL, {"midi"})
    assert internet.requests == []


def test_one_private_address_among_public_ones_is_enough_to_refuse(make_fetcher, internet):
    dns = {"www.beakauffmann.com": ["93.184.216.34", "10.0.0.5"]}
    with pytest.raises(Blocked):
        make_fetcher(resolver=fake_resolver(dns)).get(SONG_URL, {"midi"})
    assert internet.requests == []


def test_a_name_that_does_not_resolve_is_unreachable(make_fetcher):
    with pytest.raises(Unreachable):
        make_fetcher(resolver=fake_resolver({})).get(SONG_URL, {"midi"})


def test_the_request_goes_to_the_checked_address_under_the_site_name(make_fetcher, internet):
    internet.add(SONG_URL, MIDI)
    fetched = make_fetcher().get(SONG_URL, {"midi"})
    request = internet.requests[0]
    # Connecting to the checked address closes the gap between the DNS check and the connection.
    assert request.url.host == PUBLIC_DNS["www.beakauffmann.com"][0]
    assert request.headers["host"] == "www.beakauffmann.com"
    assert request.extensions["sni_hostname"] == "www.beakauffmann.com"
    assert fetched == Fetched(url=SONG_URL, content=MIDI, kind="midi")


def test_ipv4_addresses_are_tried_before_ipv6_and_a_failed_connection_tries_the_next(
    make_fetcher, internet
):
    dns = {"www.beakauffmann.com": ["2606:2800:220:1::1", "93.184.216.34", "93.184.216.40"]}
    tried = []

    def answer(request: httpx.Request) -> httpx.Response:
        tried.append(request.url.host)
        if request.url.host == "93.184.216.34":
            raise httpx.ConnectError("connection refused")
        return httpx.Response(200, content=MIDI)

    internet.add_answer(SONG_URL, answer)
    make_fetcher(resolver=fake_resolver(dns)).get(SONG_URL, {"midi"})
    assert tried == ["93.184.216.34", "93.184.216.40"]


def test_every_request_carries_the_project_user_agent_and_a_ten_second_timeout(
    make_fetcher, internet
):
    internet.add(SONG_URL, MIDI)
    make_fetcher().get(SONG_URL, {"midi"})
    request = internet.requests[0]
    assert request.headers["user-agent"] == USER_AGENT
    assert USER_AGENT.startswith("nes-genetic-arranger/1.0 (+https://github.com/GiowGiow/")
    assert request.extensions["timeout"] == {
        "connect": 10.0,
        "read": 10.0,
        "write": 10.0,
        "pool": 10.0,
    }


def test_a_redirect_within_the_allow_list_is_followed(make_fetcher, internet):
    moved = "https://www.beakauffmann.com/mpb_a/som/song-2.mid"
    internet.add(SONG_URL, status=301, headers={"location": "/mpb_a/som/song-2.mid"})
    internet.add(moved, MIDI)
    fetched = make_fetcher().get(SONG_URL, {"midi"})
    assert fetched.url == moved
    assert fetched.content == MIDI


@pytest.mark.parametrize(
    "location",
    [
        "https://evil.example/song.mid",  # off the allow-list
        "http://www.beakauffmann.com/song.mid",  # down to plain http
    ],
)
def test_a_redirect_off_the_allow_list_is_refused(make_fetcher, internet, location):
    internet.add(SONG_URL, status=302, headers={"location": location})
    with pytest.raises(Blocked):
        make_fetcher().get(SONG_URL, {"midi"})
    assert len(internet.requests) == 1


def test_endless_redirects_give_up(make_fetcher, internet):
    internet.add(SONG_URL, status=302, headers={"location": SONG_URL})
    with pytest.raises(Unreachable):
        make_fetcher().get(SONG_URL, {"midi"})
    assert 1 < len(internet.requests) <= 6


def test_an_error_status_at_the_source_is_unreachable(make_fetcher, internet):
    internet.add(SONG_URL, b"gone", status=404)
    with pytest.raises(Unreachable):
        make_fetcher().get(SONG_URL, {"midi"})


def test_a_network_timeout_is_unreachable(make_fetcher, internet):
    def answer(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("no answer")

    internet.add_answer(SONG_URL, answer)
    with pytest.raises(Unreachable):
        make_fetcher().get(SONG_URL, {"midi"})


def test_a_body_that_trickles_past_the_ten_second_deadline_is_abandoned(
    make_fetcher, internet, clock
):
    def slow_chunks():
        yield MIDI
        for _ in range(20):
            clock.now += 1.0  # each chunk arrives one second later
            yield b"\x00" * 10

    internet.add_answer(SONG_URL, lambda request: httpx.Response(200, content=slow_chunks()))
    with pytest.raises(Unreachable):
        make_fetcher().get(SONG_URL, {"midi"})


def test_a_body_over_two_megabytes_is_refused_while_it_streams(make_fetcher, internet):
    sent = []

    def big_chunks():
        yield MIDI
        for _ in range(100):
            sent.append(1)
            yield b"\x00" * (256 * 1024)

    internet.add_answer(SONG_URL, lambda request: httpx.Response(200, content=big_chunks()))
    with pytest.raises(TooLarge):
        make_fetcher().get(SONG_URL, {"midi"})
    assert MAX_BYTES == 2 * 1024 * 1024
    assert len(sent) <= 9  # stopped right after crossing 2 MB, not at the end of the stream


def test_a_declared_length_over_two_megabytes_is_refused_before_reading(make_fetcher, internet):
    def answer(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, headers={"content-length": str(MAX_BYTES + 1)}, content=iter([MIDI])
        )

    internet.add_answer(SONG_URL, answer)
    with pytest.raises(TooLarge):
        make_fetcher().get(SONG_URL, {"midi"})


@pytest.mark.parametrize(
    ("content", "kind"),
    [
        (MIDI, "midi"),
        (b"X:1\nT:Tune\nK:C\nCDEF|\n", "abc"),
        (b"\xef\xbb\xbf%abc-2.1\n% comment\n\nX:2\nT:Tune\n", "abc"),
        (b'  {"result": {"results": []}}', "json"),
        (b"[1, 2]", "json"),
        (b"<!DOCTYPE html>\n<html><body>hi</body></html>", "html"),
        (b"\n<HTML><body>hi</body></HTML>", "html"),
        (b"\x00\x01\x02 not a known format", None),
        (b"{not json", None),
    ],
)
def test_content_is_sniffed_from_its_first_bytes(content, kind):
    assert sniff(content) == kind


def test_content_of_the_wrong_kind_is_refused(make_fetcher, internet):
    internet.add(SONG_URL, b"<!DOCTYPE html><html>Error page</html>")
    with pytest.raises(WrongContent):
        make_fetcher().get(SONG_URL, {"midi", "abc"})


def test_requests_to_one_host_are_spaced_at_least_one_second_apart(make_fetcher, internet, clock):
    times = []

    def answer(request: httpx.Request) -> httpx.Response:
        times.append(clock.now)
        return httpx.Response(200, content=MIDI)

    for name in ("a", "b", "c"):
        internet.add_answer(f"https://www.beakauffmann.com/{name}.mid", answer)
    fetcher = make_fetcher()
    for name in ("a", "b", "c"):
        fetcher.get(f"https://www.beakauffmann.com/{name}.mid", {"midi"})
    assert [later - earlier for earlier, later in zip(times, times[1:], strict=False)] == [1.0, 1.0]


def test_requests_to_different_hosts_do_not_wait_for_each_other(make_fetcher, internet, clock):
    internet.add(SONG_URL, MIDI)
    internet.add("https://bitmidi.com/uploads/1.mid", MIDI)
    fetcher = make_fetcher()
    fetcher.get(SONG_URL, {"midi"})
    fetcher.get("https://bitmidi.com/uploads/1.mid", {"midi"})
    assert clock.sleeps == []


def test_a_cached_response_is_served_without_asking_the_source_again(make_fetcher, internet):
    internet.add(SONG_URL, MIDI)
    fetcher = make_fetcher()
    first = fetcher.get(SONG_URL, {"midi"})
    second = fetcher.get(SONG_URL, {"midi"})
    assert first == second
    assert len(internet.requests) == 1


def test_cached_responses_expire_after_a_day(make_fetcher, internet, clock):
    internet.add(SONG_URL, MIDI)
    fetcher = make_fetcher()
    fetcher.get(SONG_URL, {"midi"})
    clock.now += 24 * 3600 + 1
    fetcher.get(SONG_URL, {"midi"})
    assert len(internet.requests) == 2


def test_the_cache_drops_the_least_recently_used_response_when_it_is_full(clock):
    cache = ResponseCache(max_bytes=100, ttl=3600, clock=clock)
    cache.put("a", Fetched("a", b"x" * 40, None))
    cache.put("b", Fetched("b", b"x" * 40, None))
    assert cache.get("a") is not None  # "a" is now the most recently used
    cache.put("c", Fetched("c", b"x" * 40, None))
    assert cache.get("b") is None
    assert cache.get("a") is not None
    assert cache.get("c") is not None
    assert cache.size_bytes == 80


def test_a_response_larger_than_the_whole_cache_is_not_cached(clock):
    cache = ResponseCache(max_bytes=100, ttl=3600, clock=clock)
    cache.put("big", Fetched("big", b"x" * 101, None))
    assert cache.get("big") is None
    assert cache.size_bytes == 0


def test_the_default_cache_holds_200_megabytes_for_24_hours():
    cache = ResponseCache()
    assert cache.max_bytes == 200 * 1024 * 1024
    assert cache.ttl == 24 * 3600
