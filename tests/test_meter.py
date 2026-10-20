"""A meter tells how long a bar is, where its beats fall and which beats are strong."""

import pytest

from leadsheet.meter import (
    COMMON_METERS,
    FOUR_FOUR,
    Meter,
    bar_starts,
    beat_onsets,
    groups,
    parse_meter,
    strong_beats,
    strong_onsets,
    total_beats,
)
from leadsheet.model import Bar


@pytest.mark.parametrize(
    ("text", "bar_beats", "beats", "strong", "steps"),
    [
        ("2/2", 4.0, (2.0, 2.0), (0,), 16),
        ("2/4", 2.0, (1.0, 1.0), (0,), 8),
        ("3/4", 3.0, (1.0, 1.0, 1.0), (0,), 12),
        ("4/4", 4.0, (1.0, 1.0, 1.0, 1.0), (0, 2), 16),
        ("6/8", 3.0, (1.5, 1.5), (0,), 12),
        ("9/8", 4.5, (1.5, 1.5, 1.5), (0,), 18),
        ("12/8", 6.0, (1.5, 1.5, 1.5, 1.5), (0, 2), 24),
        ("5/4", 5.0, (1.0, 1.0, 1.0, 1.0, 1.0), (0, 3), 20),
        ("7/8", 3.5, (1.0, 1.0, 1.5), (0,), 14),
    ],
)
def test_each_common_meter_has_its_bar_length_beats_and_strong_beats(
    text, bar_beats, beats, strong, steps
):
    meter = parse_meter(text)

    assert (meter.bar_beats, meter.beats, meter.strong, meter.steps) == (
        bar_beats,
        beats,
        strong,
        steps,
    )
    assert sum(meter.beats) == meter.bar_beats
    assert str(meter) == text


def test_the_common_meters_are_the_nine_of_spec_003():
    assert [str(meter) for meter in COMMON_METERS] == [
        "2/2",
        "2/4",
        "3/4",
        "4/4",
        "6/8",
        "9/8",
        "12/8",
        "5/4",
        "7/8",
    ]


# The table that spec 003 wrote by hand: (beat lengths in quarter notes, strong beat indices).
SPEC_003_TABLE = {
    (2, 2): ((2.0, 2.0), (0,)),
    (2, 4): ((1.0, 1.0), (0,)),
    (3, 4): ((1.0, 1.0, 1.0), (0,)),
    (4, 4): ((1.0, 1.0, 1.0, 1.0), (0, 2)),
    (6, 8): ((1.5, 1.5), (0,)),
    (9, 8): ((1.5, 1.5, 1.5), (0,)),
    (12, 8): ((1.5, 1.5, 1.5, 1.5), (0, 2)),
    (5, 4): ((1.0, 1.0, 1.0, 1.0, 1.0), (0, 3)),
    (7, 8): ((1.0, 1.0, 1.5), (0,)),
}


def test_the_rule_derives_exactly_the_table_of_spec_003_for_the_nine_common_meters():
    derived = {
        (meter.numerator, meter.denominator): (meter.beats, meter.strong) for meter in COMMON_METERS
    }

    assert derived == SPEC_003_TABLE


@pytest.mark.parametrize(
    ("text", "beats", "strong"),
    [
        # Simple: n beats of the denominator note.
        ("3/2", (2.0, 2.0, 2.0), (0,)),
        ("3/8", (0.5, 0.5, 0.5), (0,)),
        ("7/4", (1.0,) * 7, (0, 4)),
        ("1/4", (1.0,), (0,)),
        ("4/1", (4.0, 4.0, 4.0, 4.0), (0, 2)),
        ("4/8", (0.5, 0.5, 0.5, 0.5), (0, 2)),
        ("2/8", (0.5, 0.5), (0,)),
        # Compound: a multiple of 3, from 6 on, in beats of three denominator notes.
        ("6/4", (3.0, 3.0), (0,)),
        ("12/16", (0.75, 0.75, 0.75, 0.75), (0, 2)),
        ("9/16", (0.75, 0.75, 0.75), (0,)),
        # Irregular fast: eighths or sixteenths in twos, and a last three when n is odd.
        ("5/8", (1.0, 1.5), (0,)),
        ("8/8", (1.0, 1.0, 1.0, 1.0), (0, 2)),
        ("11/8", (1.0, 1.0, 1.0, 1.0, 1.5), (0, 3)),
        ("7/16", (0.5, 0.5, 0.75), (0,)),
    ],
)
def test_the_rule_derives_the_beats_and_strong_beats_of_any_meter(text, beats, strong):
    meter = parse_meter(text)

    assert (meter.beats, meter.strong) == (beats, strong)
    assert sum(meter.beats) == meter.bar_beats
    assert meter.steps == 16 * meter.numerator // meter.denominator
    assert str(meter) == text


@pytest.mark.parametrize(
    ("beat_count", "strong"),
    [(1, (0,)), (2, (0,)), (3, (0,)), (4, (0, 2)), (5, (0, 3)), (6, (0, 3)), (7, (0, 4))],
)
def test_the_strong_beats_are_the_first_and_the_middle_one_from_four_beats_on(beat_count, strong):
    assert strong_beats(beat_count) == strong


@pytest.mark.parametrize(
    ("text", "written", "beats", "strong"),
    [
        ("2+2+3/8", "2+2+3/8", (1.0, 1.0, 1.5), (0,)),
        ("(3+3+2)/8", "3+3+2/8", (1.5, 1.5, 1.0), (0,)),
        ("3+2/4", "3+2/4", (3.0, 2.0), (0,)),
        ("2+2+2+3/8", "2+2+2+3/8", (1.0, 1.0, 1.0, 1.5), (0, 2)),
    ],
)
def test_an_additive_meter_has_one_beat_per_group(text, written, beats, strong):
    meter = parse_meter(text)

    assert (meter.beats, meter.strong) == (beats, strong)
    assert meter.numerator == sum(meter.grouping)
    assert meter.bar_beats == sum(beats)
    assert str(meter) == written
    assert parse_meter(written) == meter


def test_an_additive_meter_keeps_its_grouping_apart_from_the_plain_meter():
    additive = parse_meter("2+2+3/8")

    assert additive == Meter(7, 8, (2, 2, 3))
    assert additive != Meter(7, 8)
    assert Meter(7, 8).grouping is None
    assert parse_meter("3+2+2/8").beats == (1.5, 1.0, 1.0)


def test_a_grouping_must_add_up_to_the_numerator():
    with pytest.raises(ValueError, match=r"the groups 2\+2 do not make an additive meter of 7/8"):
        Meter(7, 8, (2, 2))


def test_common_time_is_four_four_and_cut_time_is_two_two():
    assert parse_meter("C") == FOUR_FOUR == Meter(4, 4)
    assert parse_meter("C|") == Meter(2, 2)


def test_spaces_around_the_meter_are_ignored():
    assert parse_meter(" 3/4 ") == Meter(3, 4)


SUPPORTED_RANGE = (
    "supported meters: n/d with n from 1 to 32 and d = 1, 2, 4, 8 or 16, "
    "additive meters such as 2+2+3/8, C and C|"
)


@pytest.mark.parametrize(
    "text",
    ["3/32", "33/8", "none", "3/5", "0/4", "4", "3/0", "2+0+3/8", "(3+2/8", "2+2+3/32", "x/4"],
)
def test_a_meter_outside_the_range_is_refused_naming_the_meter_the_bar_and_the_range(text):
    with pytest.raises(ValueError) as error:
        parse_meter(text, bar_number=5)

    assert str(error.value) == f"bar 5: the meter {text} is not supported; {SUPPORTED_RANGE}"


def test_without_a_bar_number_the_message_names_only_the_meter():
    with pytest.raises(
        ValueError, match=r"^the meter 3/32 is not supported; supported meters: n/d"
    ):
        parse_meter("3/32")


@pytest.mark.parametrize(("numerator", "denominator"), [(3, 32), (33, 8), (0, 4), (3, 6)])
def test_constructing_a_meter_outside_the_range_directly_is_refused(numerator, denominator):
    with pytest.raises(ValueError, match=f"the meter {numerator}/{denominator} is not supported"):
        Meter(numerator, denominator)


def test_the_limits_of_the_range_are_accepted():
    assert [str(parse_meter(text)) for text in ("1/1", "32/16", "32/1", "1/16")] == [
        "1/1",
        "32/16",
        "32/1",
        "1/16",
    ]
    assert parse_meter("32/16").steps == 32


def test_beat_and_strong_onsets_are_running_sums_of_the_beats():
    assert beat_onsets(FOUR_FOUR) == (0.0, 1.0, 2.0, 3.0)
    assert strong_onsets(FOUR_FOUR) == (0.0, 2.0)
    seven = parse_meter("7/8")
    assert beat_onsets(seven) == (0.0, 1.0, 2.0)
    assert strong_onsets(seven) == (0.0,)
    assert strong_onsets(parse_meter("12/8")) == (0.0, 3.0)


def test_groups_run_from_one_strong_beat_to_the_next():
    assert groups(FOUR_FOUR) == ((0.0, 2.0), (2.0, 2.0))
    assert groups(parse_meter("5/4")) == ((0.0, 3.0), (3.0, 2.0))
    assert groups(parse_meter("3/4")) == ((0.0, 3.0),)
    assert groups(parse_meter("12/8")) == ((0.0, 3.0), (3.0, 3.0))


def test_bar_starts_add_up_the_lengths_of_the_bars_before():
    bars = [
        Bar(0, (), (), "A", "verse", 0, False, meter=FOUR_FOUR),
        Bar(1, (), (), "A", "verse", 0, False, meter=parse_meter("2/4")),
        Bar(2, (), (), "A", "verse", 0, True, meter=parse_meter("3/4")),
    ]

    assert bar_starts(bars) == [0.0, 4.0, 6.0]
    assert total_beats(bars) == 9.0


def test_a_bar_built_without_a_meter_is_four_four():
    assert Bar(0, (), (), "A", "verse", 0, False).meter == FOUR_FOUR
