# Spec 007: audio files to notes, in the browser

**Status**: Implemented (2026-10-20)

## Request

"Tem como a gente converter um vídeo do youtube pra midi/abc e/ou converter áudio pra midi/abc num
app assim sem server? Se tiver como implemente isso."

## Decision

- **Audio file to MIDI: yes, on the visitor's device.** The browser decodes the file, Basic Pitch
  (Apache-2.0, TensorFlow.js, 1.7 MB with the model, vendored and loaded only when an audio file is
  opened) finds the notes, and `core/audio-to-midi.js` writes a MIDI file: a Melody track (the
  skyline, the highest sounding note) and an Accompaniment track, at the tempo found on the onsets,
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
