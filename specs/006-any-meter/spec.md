# Feature Specification: Any Meter

**Feature Branch**: `main` (direct commits, as the student chose for this repository)

**Created**: 2026-10-20

**Status**: Implemented (2026-10-20)

**Input**: User description (translated from Portuguese): "Support every kind of time signature, not
only the ones defined today."

## Context

Spec 003 added nine meters: 2/2, 2/4, 3/4, 4/4, 6/8, 9/8, 12/8, 5/4 and 7/8. Every other time
signature is refused, both in the command line and in the app. That covers 3/2, 3/8, 6/4, 5/8,
11/8, 12/16 and others.

The rest of the method already reads only three facts of a meter:
- the length of each beat;
- which beats are strong;
- the number of sixteenth-note steps in a bar.

So derive these facts by rule for any time signature, instead of looking them up in a table of
nine.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Arrange a song in any meter (Priority: P1)

A visitor opens a song in 3/2, 6/4, 5/8, 11/8, 3/8, 12/16, 7/4 or 2/8, or a tune written with
an additive meter such as `M:2+2+3/8`. The song is read and arranged like any other. The
textures follow its beats and strong beats.

**Independent Test**: arrange a 3/2 tune and an 11/8 tune from the command line and in the app.
Both give complete arrangements, and the drum pattern falls on the meter's beats.

**Acceptance Scenarios**:

1. **Given** the nine meters of spec 003, **Then** their beats, strong beats and steps are
   exactly as before. Samples, plans, fitness, MIDI and the parity fixtures do not change.
2. **Given** a time signature n/d with d in {1, 2, 4, 8, 16} and 1 ≤ n ≤ 32, **Then** it is
   accepted, and its beats follow the rule in the requirements.
3. **Given** an additive ABC meter (`M:2+2+3/8` or `M:(3+3+2)/8`), **Then** each group is one
   beat of that many units.
4. **Given** a denominator of 32 or more, a numerator over 32, a free meter (`M:none`) or
   anything that is not a meter, **Then** the error names the bar and says what range is
   accepted.
5. **Given** a MIDI file whose time-signature map holds any of these meters, **Then** its bars
   follow that map.
6. **Given** The Session tunes of type three-two, **Then** they open in 3/2.

## Requirements *(mandatory)*

- **FR-001**: A meter n/d MUST be accepted when d ∈ {1, 2, 4, 8, 16} and 1 ≤ n ≤ 32. "C" means
  4/4 and "C|" means 2/2, as before.
- **FR-002**: Beats MUST be derived as follows, in units of the denominator note (u = 4/d
  quarter notes):
  - **Compound**, when n is a multiple of 3 and n ≥ 6: n/3 beats of 3u (6/8, 9/8, 12/8, 6/4,
    9/16).
  - **Irregular fast**, when d ≥ 8, n ≥ 5 and the meter is not compound: groups of 2u, then a
    final group of 3u when n is odd (7/8 = 2+2+3, 5/8 = 2+3, 11/8 = 2+2+2+2+3, 8/8 = 2+2+2+2).
  - **Simple**, otherwise: n beats of u (2/2, 3/4, 4/4, 5/4, 7/4, 3/2, 3/8, 4/8).
  - **Additive**, when written a+b+…/d: one beat per group, of that group times u.
- **FR-003**: With B beats, the strong beats MUST be:
  - beat 0;
  - plus beat B/2 when B is even and B ≥ 4;
  - plus beat ⌈B/2⌉ when B is odd and B ≥ 5.

  This rule reproduces the nine meters of spec 003 exactly.
- **FR-004**: Steps per bar MUST stay 16·n/d, an integer for every accepted meter.
- **FR-005**: The Python reference and the app MUST derive identical meters. The parity fixtures
  MUST gain tunes in new meters, and the existing fixtures MUST NOT change.
- **FR-006**: The text that lists supported meters MUST describe the new rule: the README, the
  app's hints and the docstrings.

## Success Criteria *(mandatory)*

- **SC-001**: The nine spec 003 meters derive exactly the old table (a test compares them).
- **SC-002**: At least six new meters are arranged end to end in both stacks, with parity
  fixtures: 3/2, 6/4, 5/8, 11/8, 3/8 and 2+2+3/8.
- **SC-003**: The samples rerun to the same bytes, and `uv run src/main.py fixtures` leaves the
  existing fixtures untouched.

## Assumptions

- Groupings of irregular meters vary by tradition. The rule picks one convention, the same one
  spec 003 used for 5/4 and 7/8. An ABC tune can state another grouping with an additive meter.
- Denominators of 32 or more would put beats off the sixteenth-note grid of the drums and the
  score tables, so they stay unsupported.
