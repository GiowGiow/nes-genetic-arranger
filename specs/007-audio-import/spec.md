# Spec 007: audio files to notes, in the browser

**Status**: Implemented (2026-10-20)

## Request

"Tem como a gente converter um vídeo do youtube pra midi/abc e/ou converter áudio pra midi/abc num
app assim sem server? Se tiver como implemente isso."

## Decision

- **Audio file to MIDI: yes, on the visitor's device.** The browser decodes the file, Basic Pitch
  (Apache-2.0, TensorFlow.js, 1.7 MB with the model, vendored and loaded only when an audio file is
  opened) finds the notes, and `core/audio-to-midi.js` writes a MIDI file: a Melody track (the
  strongest line in the singing register, found with a Viterbi path over the model's activations,
  split where the model hears a new onset; the skyline, the highest sounding note, when the path
  finds fewer than 3 notes) and an Accompaniment track, at the tempo found on the onsets,
  with the first beat at the start. The page reads it like any MIDI file.
- **YouTube: no.** A page cannot read another site's video or audio (no CORS, and the site's terms
  forbid it), so it needs a server that downloads on the visitor's behalf. The visitor saves the
  audio and opens the file.

## Requirements

- **FR-001**: Dropping or choosing an audio file (MP3, WAV, M4A, AAC, OGG, FLAC, WebM) transcribes it
  on the device, says how far it is, and then loads the result as a song with its own record.
- **FR-002**: Nothing is uploaded; the model loads from the page's own files, only when needed.
- **FR-003**: At most the first 300 seconds are heard; a file the browser cannot decode, or with no
  notes in it, gets a sentence that says so.
- **FR-004**: The melody options say which track is the melody and are open only when the heuristic
  is unsure.
- **FR-005**: The vendored files carry their license, version, hashes and how they were built.

## Tests

`tests/audio-to-midi.test.js` (notes to MIDI), `tests/audio-import.test.js` (which files are audio),
`tests/basic-pitch.test.js` (the vendored model hears a synthetic tune in Node).

## Tuning on a real recording (2026-10-20)

A 60-second excerpt of a big-band vocal recording (Fly Me to the Moon, Sinatra with Basie) was
transcribed and compared with a community MIDI of the same song, fetched only for the comparison and
not kept. The two were aligned by chroma (the recording runs at about 121 BPM against the MIDI's 128,
and the voice sings an octave under the MIDI's written melody). Share of the MIDI melody's notes
found at the same pitch, at the same time:

| Melody extraction | Same pitch | Same pitch class |
|---|---|---|
| Skyline (highest note) | 0.22 | 0.33 |
| Viterbi path in the singing register, with onsets | 0.55 | 0.61 |

The skyline took the horns above the voice and its floor at G3 cut the low notes of a baritone. The
tempo found (120 BPM) matches the recording's. What stays weak is the polyphonic model itself on a
full band: only about half of the sung pitch classes appear among all the notes it reports, and the
tracker splits the line into more notes than the singer sang. A voice separation step would help
most and is too heavy to run in a page.
