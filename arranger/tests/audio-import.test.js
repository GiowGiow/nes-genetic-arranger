// @ts-check
// Tests for ui/audio-import.js: which files are taken as audio. The listening itself needs a
// browser (decoding) and is checked with the vendored model in tests/basic-pitch.test.js.

import assert from "node:assert/strict";
import { test } from "node:test";

import { AUDIO_EXTENSIONS, MAX_SECONDS, isAudioName } from "../src/ui/audio-import.js";

test("audio files are told by their extension, whatever its case", () => {
  for (const name of ["song.mp3", "Song.MP3", "a.b.wav", "x.m4a", "x.ogg", "x.flac", "x.opus"]) {
    assert.equal(isAudioName(name), true, name);
  }
  for (const name of ["song.mid", "tune.abc", "notes.txt", "mp3", "song.mp3.txt", ""]) {
    assert.equal(isAudioName(name), false, name);
  }
});

test("MIDI and ABC extensions are never audio, and at most five minutes are heard", () => {
  for (const extension of ["mid", "midi", "kar", "abc", "txt"]) assert.ok(!AUDIO_EXTENSIONS.includes(extension));
  assert.equal(MAX_SECONDS, 300);
});
