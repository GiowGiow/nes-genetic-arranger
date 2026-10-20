"""Meters: how long a bar is, where its beats fall and which beats are strong.

A meter (time signature) such as 3/4 says that a bar holds three quarter notes. The listener
does not hear the bar as an even row of notes but as a few *beats*, the pulse a foot taps, and
some beats are *strong*: beat 1 always, and in 4/4 also beat 3. Every texture of the arranger
leans on that pulse: the bass plays the root on a strong beat, the drums kick on strong beats and
hit the snare on weak ones.

A meter n/d holds n notes of the denominator's value d (4 is a quarter note, 8 an eighth). The
arranger does not look the beats up in a table: it derives them by one rule, the way musicians
count, so every meter with d = 1, 2, 4, 8 or 16 and n from 1 to 32 can be arranged. The rule
sorts the meters into four families:

- **Compound** meters, whose numerator is a multiple of 3 from 6 on (6/8, 9/8, 12/8, 6/4), group
  their notes in threes, so a beat is a dotted note: 6/8 has two beats of 1.5 quarters each, and
  a jig is felt "in two".
- **Irregular** fast meters, of eighths or sixteenths, with 5 notes or more and not compound
  (5/8, 7/8, 8/8, 11/8), group their notes in twos, with a last group of three when n is odd:
  7/8 is felt 2 + 2 + 3, so its three beats last 1, 1 and 1.5 quarters.
- **Simple** meters, all the others (2/2, 3/4, 4/4, 5/4, 7/4, 3/2, 3/8), count beats of the
  denominator note: 3/4 has three quarter-note beats.
- **Additive** meters, which ABC writes as 2+2+3/8 or (3+3+2)/8, state their own groups: one beat
  per group, so a tune can ask for another grouping than the rule's.

The strong beats split the bar in two halves: beat 1, and the first beat of the second half when
the bar has four beats or more. With an odd number of beats the first half is the longer one, so
5/4 is felt 3 + 2 (strong beats 1 and 4). A bar of up to three beats has only one strong beat.
The rule gives exactly the nine meters that spec 003 listed by hand (`COMMON_METERS`).

All lengths are in quarter-note beats, the unit of the whole method, so a 6/8 bar lasts 3.0 and a
7/8 bar 3.5. The drums and the score tables work on a grid of sixteenth notes, and a denominator
of 32 or more would put beats off that grid, so those meters stay unsupported.
"""

import re
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import accumulate
from typing import Protocol

# The note values a meter may count (whole, half, quarter, eighth, sixteenth) and its most notes.
DENOMINATORS = (1, 2, 4, 8, 16)
MAX_NUMERATOR = 32

# Names that ABC writes for two meters: "C" (common time) and "C|" (cut time).
_SYMBOLS = {"C": "4/4", "C|": "2/2"}

# "3/4", an additive "2+2+3/8", or an additive in parentheses "(3+3+2)/8".
_METER_TEXT = re.compile(
    r"(?:\((?P<grouped>\d+(?:\+\d+)+)\)|(?P<plain>\d+(?:\+\d+)*))/(?P<denominator>\d+)"
)

SUPPORTED_RANGE = (
    "n/d with n from 1 to 32 and d = 1, 2, 4, 8 or 16, additive meters such as 2+2+3/8, C and C|"
)


def _unsupported(text: str, bar_number: int | None) -> ValueError:
    where = f"bar {bar_number}: " if bar_number is not None else ""
    return ValueError(
        f"{where}the meter {text} is not supported; supported meters: {SUPPORTED_RANGE}"
    )


def _in_range(numerator: int, denominator: int) -> bool:
    return denominator in DENOMINATORS and 1 <= numerator <= MAX_NUMERATOR


def beat_grouping(numerator: int, denominator: int) -> tuple[int, ...]:
    """How the bar's notes of the denominator's value gather into beats, by the module's rule.

    Each number is one beat, counted in denominator notes: compound meters group them in
    threes, irregular fast meters in twos with a last three when the numerator is odd, and
    simple meters count every note as a beat.

    >>> beat_grouping(6, 8), beat_grouping(7, 8), beat_grouping(11, 8), beat_grouping(3, 4)
    ((3, 3), (2, 2, 3), (2, 2, 2, 2, 3), (1, 1, 1))
    """
    if numerator % 3 == 0 and numerator >= 6:  # compound: 6/8, 9/8, 12/8, 6/4
        return (3,) * (numerator // 3)
    if denominator >= 8 and numerator >= 5:  # irregular fast: 5/8 = 2+3, 8/8 = 2+2+2+2
        if numerator % 2:
            return (2,) * ((numerator - 3) // 2) + (3,)
        return (2,) * (numerator // 2)
    return (1,) * numerator  # simple: 3/4, 5/4, 3/2, 3/8


def strong_beats(beat_count: int) -> tuple[int, ...]:
    """Indices of the strong beats of a bar of `beat_count` beats.

    Beat 0 always; from four beats on, also the first beat of the second half, which starts
    after the longer half when the count is odd (5 beats are felt 3 + 2).

    >>> strong_beats(3), strong_beats(4), strong_beats(5), strong_beats(7)
    ((0,), (0, 2), (0, 3), (0, 4))
    """
    if beat_count < 4:
        return (0,)
    return (0, (beat_count + 1) // 2)


@dataclass(frozen=True)
class Meter:
    """A time signature, with its beats and strong beats.

    Attributes:
        numerator: notes of the denominator's value per bar, as written (1 to 32).
        denominator: the note value of the numerator: 1, 2, 4, 8 or 16.
        grouping: the groups of an additive meter as written (2+2+3/8 is (2, 2, 3)), one beat
            each; None for a plain meter, whose beats follow the rule of the module docstring.

    >>> waltz = Meter(3, 4)
    >>> waltz.bar_beats, waltz.beats, waltz.strong, waltz.steps
    (3.0, (1.0, 1.0, 1.0), (0,), 12)
    >>> Meter(6, 8).beats  # two dotted-quarter beats
    (1.5, 1.5)
    >>> str(Meter(8, 8, (3, 3, 2))), Meter(8, 8, (3, 3, 2)).beats
    ('3+3+2/8', (1.5, 1.5, 1.0))
    """

    numerator: int
    denominator: int
    grouping: tuple[int, ...] | None = None

    def __post_init__(self) -> None:
        if not _in_range(self.numerator, self.denominator):
            raise _unsupported(str(self), None)
        groups_ok = (
            self.grouping is None
            or len(self.grouping) >= 2
            and min(self.grouping) >= 1
            and sum(self.grouping) == self.numerator
        )
        if not groups_ok:
            raise ValueError(
                f"the groups {'+'.join(map(str, self.grouping or ()))} do not make an additive "
                f"meter of {self.numerator}/{self.denominator}: it needs two or more groups "
                f"that add up to {self.numerator}"
            )

    @property
    def bar_beats(self) -> float:
        """The bar length in quarter notes: numerator × 4 / denominator."""
        return self.numerator * 4 / self.denominator

    @property
    def beats(self) -> tuple[float, ...]:
        """The length of each beat in quarter notes; they add up to `bar_beats`."""
        grouping = self.grouping or beat_grouping(self.numerator, self.denominator)
        return tuple(notes * 4 / self.denominator for notes in grouping)

    @property
    def strong(self) -> tuple[int, ...]:
        """Indices into `beats` of the strong beats; beat 0 is always strong."""
        return strong_beats(len(self.beats))

    @property
    def steps(self) -> int:
        """Sixteenth-note steps in one bar, the grid of the drums and of the score tables."""
        return round(4 * self.bar_beats)

    def __str__(self) -> str:
        top = "+".join(map(str, self.grouping)) if self.grouping else str(self.numerator)
        return f"{top}/{self.denominator}"


FOUR_FOUR = Meter(4, 4)

# The nine meters of spec 003, which the rule derives exactly as that spec listed them.
COMMON_METERS = tuple(
    Meter(n, d)
    for n, d in ((2, 2), (2, 4), (3, 4), (4, 4), (6, 8), (9, 8), (12, 8), (5, 4), (7, 8))
)


def parse_meter(text: str, bar_number: int | None = None) -> Meter:
    """Read a meter as ABC or a time signature writes it: "3/4", "2+2+3/8", "(3+3+2)/8", "C".

    Args:
        text: the meter text; "C" is 4/4 and "C|" is 2/2.
        bar_number: the bar (counted from 1) where the meter appears, named in the error.

    Raises:
        ValueError: for a meter outside the supported range (see the module docstring), or a
            text that is not a meter, such as ABC's free meter "none".

    >>> parse_meter("C|")
    Meter(numerator=2, denominator=2, grouping=None)
    >>> str(parse_meter("(3+3+2)/8"))
    '3+3+2/8'
    >>> parse_meter("3/32", bar_number=3)  # doctest: +ELLIPSIS
    Traceback (most recent call last):
    ...
    ValueError: bar 3: the meter 3/32 is not supported; supported meters: n/d with n from 1 to 32...
    """
    cleaned = text.strip()
    match = _METER_TEXT.fullmatch(_SYMBOLS.get(cleaned, cleaned))
    if match is not None:
        groups = tuple(int(group) for group in (match["grouped"] or match["plain"]).split("+"))
        denominator = int(match["denominator"])
        if min(groups) >= 1 and _in_range(sum(groups), denominator):
            return Meter(sum(groups), denominator, groups if len(groups) > 1 else None)
    raise _unsupported(cleaned, bar_number)


def beat_onsets(meter: Meter) -> tuple[float, ...]:
    """The onset of each beat, in quarter notes from the bar start.

    >>> beat_onsets(Meter(7, 8))
    (0.0, 1.0, 2.0)
    """
    return (0.0, *accumulate(meter.beats[:-1]))


def strong_onsets(meter: Meter) -> tuple[float, ...]:
    """The onsets of the strong beats.

    >>> strong_onsets(FOUR_FOUR), strong_onsets(Meter(5, 4))
    ((0.0, 2.0), (0.0, 3.0))
    """
    onsets = beat_onsets(meter)
    return tuple(onsets[index] for index in meter.strong)


def groups(meter: Meter) -> tuple[tuple[float, float], ...]:
    """The (onset, length) spans from each strong beat to the next one or to the bar end.

    These are the stretches over which the MIDI reader decides one chord: half bars in 4/4,
    3 + 2 beats in 5/4, the whole bar in 3/4.

    >>> groups(FOUR_FOUR)
    ((0.0, 2.0), (2.0, 2.0))
    >>> groups(Meter(3, 4))
    ((0.0, 3.0),)
    """
    starts = strong_onsets(meter)
    ends = (*starts[1:], meter.bar_beats)
    return tuple((start, end - start) for start, end in zip(starts, ends, strict=True))


class _HasMeter(Protocol):
    @property
    def meter(self) -> Meter: ...


def bar_starts(bars: Sequence[_HasMeter]) -> list[float]:
    """The onset of each bar, in quarter notes from the start of the piece.

    >>> class B:  # anything with a meter, such as a lead-sheet Bar
    ...     def __init__(self, text): self.meter = parse_meter(text)
    >>> bar_starts([B("4/4"), B("2/4"), B("3/4")])
    [0.0, 4.0, 6.0]
    """
    return [0.0, *accumulate(bar.meter.bar_beats for bar in bars[:-1])] if bars else []


def total_beats(bars: Sequence[_HasMeter]) -> float:
    """The length of the piece in quarter notes: the sum of its bar lengths.

    >>> class B:
    ...     def __init__(self, text): self.meter = parse_meter(text)
    >>> total_beats([B("6/8"), B("6/8")])
    6.0
    """
    return float(sum(bar.meter.bar_beats for bar in bars))
