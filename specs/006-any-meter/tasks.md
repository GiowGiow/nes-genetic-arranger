# Tasks: Any Meter

Test-first (constitution II). Python is the reference, and the app must match it (parity).

- [X] T001 Write failing tests in `tests/test_meter.py` (or the existing meter tests):
  - the nine old meters equal the old table;
  - the rule for 3/2, 6/4, 5/8, 8/8, 11/8, 3/8, 12/16, 7/4, 1/4 and 4/1;
  - additive `2+2+3/8` and `(3+3+2)/8`;
  - refusals (3/32, 33/8, none, 3/5).
- [X] T002 Implement the derivation in `src/leadsheet/meter.py`, plus additive parsing. Keep
  `FOUR_FOUR` and keep the nine as `COMMON_METERS`. Update the module docstring, doctests and
  error message.
- [X] T003 Check the readers for meter assumptions and fix them:
  - `src/leadsheet/abc_reader.py`: meter scan, additive text, `[M:...]` inline;
  - `src/leadsheet/midi_reader.py`;
  - `src/leadsheet/abc_writer.py`, which writes the meter back, additive too.
- [X] T004 Add tunes in `tests/data/meters/` (3/2, 6/4, 5/8, 11/8, 3/8, 2+2+3/8). Extend the
  fixtures command so it covers them, and regenerate. Only new fixture files may appear.
- [X] T005 Write failing tests in `arranger/tests/meter.test.js` mirroring T001, and in the
  reader tests.
- [X] T006 Implement the same in `arranger/src/core/meter.js`: one interned object per meter
  text, a prototype `toString`, and additive support. Check `abc-reader.js` (abcjs meter text),
  `midi-song.js` and `abc-writer.js`.
- [X] T007 The Session: `arranger/src/core/thesession.js` maps three-two to 3/2. Update its
  tests.
- [X] T008 Docs: README (meter terms, the supported list), `arranger/src/core/abc-reader.js`
  header, input panel hints, glossary.
- [X] T009 Run all suites. Samples and old fixtures must be unchanged.
