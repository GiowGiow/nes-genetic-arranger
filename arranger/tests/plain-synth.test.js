// @ts-check
// Tests for audio/plain-synth.js, which makes the input audible for the A/B comparison.
//
// The input is played plainly on the same beat timeline as the arrangement: a lead sheet as its
// melody over a quiet chord pad, a MIDI song as its own tracks cut to the excerpt. The tests check
// the notes in beats (what the channel view draws) and the sound: duration, energy in the melody
// and chord bands, drums as noise, and determinism. The last tests cover the track preview (spec
// 005 story 2): which bars of a track it plays, and how they play back to back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { leadSheetFromJson } from "../src/core/leadsheet.js";
import { readMidiFile, writeMidiFile } from "../src/core/midi-file.js";
import {
  PAD_LOWEST_PITCH,
  beatClock,
  leadSheetVoices,
  midiExcerptVoices,
  previewWindow,
  renderLeadSheet,
  renderMidiExcerpt,
  renderVoices,
  soundingBars,
  trackPreview,
  windowVoices,
} from "../src/audio/plain-synth.js";
import { assertClose, countInSongBytes, readFixture } from "./helpers.js";

const RATE = 44100;
const korobeiniki = leadSheetFromJson(readFixture("leadsheets/korobeiniki.json"));

/**
 * A small 120 BPM song: a melody, a bass and drums. Bar 1 starts at 2 s.
 * @returns {import("../src/core/midi-file.js").MidiSong}
 */
function smallSong() {
  const note = (/** @type {number} */ start, /** @type {number} */ end, /** @type {number} */ pitch) => ({ start, end, pitch, velocity: 100 });
  const bytes = writeMidiFile({
    tempoBpm: 120,
    tracks: [
      { name: "melody", channel: 0, program: 0, notes: [note(0, 0.5, 72), note(2, 2.5, 74), note(3.75, 4.25, 76), note(4.5, 5, 77)] },
      { name: "bass", channel: 1, program: 33, notes: [note(2, 4, 40)] },
      { name: "drums", channel: 9, program: 0, notes: [note(2, 2.1, 36), note(2.25, 2.35, 42), note(4, 4.1, 36)] },
    ],
  });
  return readMidiFile(bytes);
}

/**
 * Index of the instrument named `name` (readMidiFile lists them in pretty_midi's order).
 * @param {import("../src/core/midi-file.js").MidiSong} midi
 * @param {string} name
 */
function trackIndex(midi, name) {
  return midi.instruments.findIndex((instrument) => instrument.name === name);
}

/**
 * Share of the power of a Hann-windowed block that falls in each frequency band.
 * @param {Float32Array} samples
 * @param {number} start first sample of the block
 * @param {number} size block length (a DFT of this size)
 * @param {Array<[number, number]>} bands [low Hz, high Hz] pairs
 */
function bandShares(samples, start, size, bands) {
  const block = Float64Array.from({ length: size }, (_, n) => samples[start + n] * (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / size)));
  const cosTable = Float64Array.from({ length: size }, (_, n) => Math.cos((2 * Math.PI * n) / size));
  const sinTable = Float64Array.from({ length: size }, (_, n) => Math.sin((2 * Math.PI * n) / size));
  const shares = bands.map(() => 0);
  let total = 0;
  for (let k = 1; k < size / 2; k++) {
    let re = 0;
    let im = 0;
    for (let n = 0; n < size; n++) {
      const angle = (k * n) % size;
      re += block[n] * cosTable[angle];
      im -= block[n] * sinTable[angle];
    }
    const power = re * re + im * im;
    const hz = (k * RATE) / size;
    total += power;
    bands.forEach(([low, high], i) => {
      if (hz >= low && hz <= high) shares[i] += power;
    });
  }
  return shares.map((share) => share / total);
}

/**
 * The largest normalized autocorrelation of a block over lags from `minLag` to `maxLag`.
 * A pitched tone repeats (near 1 at its period); noise does not (near 0).
 * @param {Float32Array} block
 * @param {number} minLag
 * @param {number} maxLag
 */
function periodicity(block, minLag, maxLag) {
  let energy = 0;
  for (const sample of block) energy += sample * sample;
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < block.length; i++) sum += block[i] * block[i + lag];
    best = Math.max(best, sum / energy);
  }
  return best;
}

/** @param {Float32Array} block */
function zeroCrossingRate(block) {
  let crossings = 0;
  for (let i = 1; i < block.length; i++) if ((block[i - 1] < 0) !== (block[i] < 0)) crossings++;
  return crossings / block.length;
}

test("a lead sheet gives its melody on the beat timeline and its chords as a three-note pad", () => {
  const voices = leadSheetVoices(korobeiniki);
  const melodyCount = korobeiniki.bars.reduce((count, bar) => count + bar.melody.length, 0);
  assert.equal(voices.melody.length, melodyCount);
  assert.deepEqual(voices.melody[0], { pitch: 76, onset: 0, duration: 1 });
  // The first note of bar 1 sits 4 beats later.
  const bar1 = korobeiniki.bars[1].melody[0];
  assert.deepEqual(voices.melody[korobeiniki.bars[0].melody.length], { ...bar1, onset: 4 + bar1.onset });

  // Root, third and fifth, one voice each, from C3 up: E major is E3, G#3, B3.
  assert.equal(voices.others.length, 3);
  assert.deepEqual(voices.others.map((voice) => voice[0]), [
    { pitch: 52, onset: 0, duration: 4 },
    { pitch: 56, onset: 0, duration: 4 },
    { pitch: 59, onset: 0, duration: 4 },
  ]);
  const segments = korobeiniki.bars.reduce((count, bar) => count + bar.chords.length, 0);
  for (const voice of voices.others) {
    assert.equal(voice.length, segments, "each chord segment is one held note");
    assert.ok(voice.every((note) => note.pitch >= PAD_LOWEST_PITCH && note.pitch < PAD_LOWEST_PITCH + 12));
  }
  assert.deepEqual(voices.drums, []);
});

test("a lead sheet render lasts bars × 4 × 60 / tempo seconds", () => {
  const samples = renderLeadSheet(korobeiniki, RATE);
  const seconds = (korobeiniki.bars.length * 4 * 60) / korobeiniki.tempoBpm;
  assert.equal(samples.length, Math.round(seconds * RATE));
  assert.ok(samples instanceof Float32Array);
});

test("a lead sheet render has energy in the melody band and in the chord band", () => {
  // First beat of Korobeiniki: the melody plays E5 (659 Hz) over an E major pad (165-247 Hz).
  const bands = /** @type {Array<[number, number]>} */ ([[120, 270], [280, 4000]]);
  const voices = leadSheetVoices(korobeiniki);
  const full = renderVoices(voices, korobeiniki.tempoBpm, RATE, 4);
  const [chordShare, melodyShare] = bandShares(full, 2000, 4096, bands);
  assert.ok(chordShare > 0.05, `chord band holds ${chordShare} of the power`);
  assert.ok(melodyShare > 0.05, `melody band holds ${melodyShare} of the power`);
  // Without the pad, the chord band is empty: its energy came from the chords.
  const melodyOnly = renderVoices({ ...voices, others: [] }, korobeiniki.tempoBpm, RATE, 4);
  assert.ok(bandShares(melodyOnly, 2000, 4096, bands)[0] < 0.01);
});

test("a MIDI excerpt is read on the lead sheet's grid, shifted to its first bar and cut to it", () => {
  const midi = smallSong();
  // File grid ([file tempo, 0]): beats are ticks / resolution. Bar 1 is the excerpt.
  const voices = midiExcerptVoices(midi, { melodyTrack: trackIndex(midi, "melody"), sourceGrid: [120, 0], bars: [1, 2] });
  assertClose(voices.melody, [
    { pitch: 74, onset: 0, duration: 1 },
    { pitch: 76, onset: 3.5, duration: 0.5 }, // cut at the end of the excerpt
  ]);
  assertClose(voices.others, [[{ pitch: 40, onset: 0, duration: 4 }]]);
  assertClose(voices.drums, [
    { pitch: 36, onset: 0 },
    { pitch: 42, onset: 0.5 },
  ]);

  // An estimated grid [bpm, downbeat]: beats are (seconds − downbeat) × bpm / 60.
  const estimated = midiExcerptVoices(midi, { melodyTrack: trackIndex(midi, "melody"), sourceGrid: [100, 0.3], bars: [0, 2] });
  assertClose(estimated.melody[0], { pitch: 72, onset: 0, duration: (0.5 - 0.3) * (100 / 60) }, 9);
  assertClose(estimated.melody[1], { pitch: 74, onset: (2 - 0.3) * (100 / 60), duration: 0.5 * (100 / 60) }, 9);
});

test("the original of a song with a count-in counts bars on the file's time-signature map", () => {
  // Two 3/4 bars (3 s, 6 beats), then 4/4: bar 2 is the first 4/4 bar and starts at 3 s.
  const midi = readMidiFile(countInSongBytes());
  assert.equal(beatClock(midi, [120, 0])(3), 6);
  assert.equal(beatClock(midi, [120, 0])(5), 10);
  const voices = midiExcerptVoices(midi, { melodyTrack: 0, sourceGrid: [120, 0], bars: [2, 3] });
  // The pickup G4 at 2.5 s is in bar 1, before the excerpt.
  assert.deepEqual(voices.melody, [{ pitch: 72, onset: 0, duration: 2 }]);
  assert.deepEqual(voices.drums.map((hit) => hit.onset), [0, 1, 2, 3]);
  // An estimated grid has its own downbeat: the count-in does not move it.
  assert.equal(beatClock(midi, [100, 0.3])(1.5), 2);
});

test("a MIDI excerpt render lasts the excerpt's beats at the run tempo", () => {
  const midi = smallSong();
  const excerpt = { melodyTrack: trackIndex(midi, "melody"), sourceGrid: /** @type {[number, number]} */ ([120, 0]), bars: /** @type {[number, number]} */ ([1, 3]) };
  assert.equal(renderMidiExcerpt(midi, excerpt, 150, RATE).length, Math.round(((8 * 60) / 150) * RATE));
});

test("drum notes become noise bursts", () => {
  const drumsOnly = (/** @type {number} */ pitch) => renderVoices({ melody: [], others: [], drums: [{ pitch, onset: 0 }] }, 120, RATE, 1);
  const hiHat = drumsOnly(42);
  const kick = drumsOnly(36);
  const burst = Math.round(0.03 * RATE);
  // Noise does not repeat, unlike a pitched note.
  assert.ok(periodicity(hiHat.subarray(0, burst), 20, 400) < 0.5);
  const tone = renderVoices({ melody: [{ pitch: 69, onset: 0, duration: 1 }], others: [], drums: [] }, 120, RATE, 1);
  assert.ok(periodicity(tone.subarray(2000, 2000 + RATE / 10), 20, 400) > 0.9);
  // A burst is short: half a beat later both drums are silent.
  assert.ok(hiHat.subarray(RATE / 4).every((sample) => sample === 0));
  assert.ok(kick.subarray(RATE / 4).every((sample) => sample === 0));
  // The kick is darker than the hi-hat.
  assert.ok(zeroCrossingRate(kick.subarray(0, burst)) < zeroCrossingRate(hiHat.subarray(0, burst)) / 4);
});

test("both renders are deterministic", () => {
  assert.deepEqual(renderLeadSheet(korobeiniki, 22050), renderLeadSheet(korobeiniki, 22050));
  const midi = smallSong();
  const excerpt = { melodyTrack: trackIndex(midi, "melody"), sourceGrid: /** @type {[number, number]} */ ([120, 0]), bars: /** @type {[number, number]} */ ([0, 3]) };
  assert.deepEqual(renderMidiExcerpt(midi, excerpt, 120, RATE), renderMidiExcerpt(midi, excerpt, 120, RATE));
});

test("the documented examples hold", () => {
  assert.equal(PAD_LOWEST_PITCH, 48);
  const midi = smallSong();
  assert.equal(beatClock(midi, [120, 0])(2.25), 4.5);
  assert.equal(beatClock(midi, [100, 0.3])(1.5), 2);

  const sheet = leadSheetFromJson({
    title: "One bar",
    key: "C major",
    tempo_bpm: 120,
    bars: [
      {
        index: 0, label: "A", role: "verse", phrase: 0, phrase_end: true,
        melody: [{ pitch: 72, onset: 0, duration: 4 }],
        chords: [{ symbol: "Am", root: 9, tones: [9, 0, 4], onset: 0, duration: 4 }],
      },
    ],
  });
  const voices = leadSheetVoices(sheet);
  assert.deepEqual(voices.melody, [{ pitch: 72, onset: 0, duration: 4 }]);
  assert.deepEqual(voices.others.map((voice) => voice[0].pitch), [57, 48, 52]);
  assert.equal(renderVoices(voices, 120, 44100, 4).length, 88200);
  assert.equal(renderLeadSheet(sheet, 44100).length, 88200);

  const excerpt = { melodyTrack: trackIndex(midi, "melody"), sourceGrid: /** @type {[number, number]} */ ([120, 0]), bars: /** @type {[number, number]} */ ([1, 2]) };
  assert.equal(midiExcerptVoices(midi, excerpt).melody[0].pitch, 74);
  assert.equal(renderMidiExcerpt(midi, excerpt, 120, 44100).length, 88200);
});

test("a waltz lead sheet plays its bars of three beats one after the other", () => {
  const waltz = leadSheetFromJson(readFixture("leadsheets/waltz.json"));

  const voices = leadSheetVoices(waltz);

  // Bar 2 (index 1) starts on beat 3: its first melody note, E5, sounds there.
  assert.deepEqual(voices.melody.find((note) => note.onset >= 3), { pitch: 76, onset: 3, duration: 2 });
  // 16 bars × 3 beats at 150 BPM last 19.2 s.
  assert.equal(renderLeadSheet(waltz, 1000).length, 19200);
});

test("the original of a waltz excerpt lasts its bars of three beats", () => {
  const midi = readMidiFile(new Uint8Array(readFileSync(new URL("./fixtures/midi-songs/synthetic-waltz.mid", import.meta.url))));
  const excerpt = { melodyTrack: 0, sourceGrid: /** @type {[number, number]} */ ([120, 0]), bars: /** @type {[number, number]} */ ([1, 3]) };

  const voices = midiExcerptVoices(midi, excerpt);

  // Bar 1 starts on beat 3 (1.5 s): its three melody notes fall on beats 0, 1 and 2 of the excerpt.
  assert.deepEqual(voices.melody.slice(0, 3).map((note) => note.onset), [0, 1, 2]);
  assert.equal(renderMidiExcerpt(midi, excerpt, 120, 1000).length, 3000); // 6 beats at 120 BPM
});

// --- Track preview (spec 005 story 2, research R4) ---------------------------------------------

/**
 * Which bars of an excerpt a track plays in, written as text: "x" for a bar where it plays, "."
 * for a silent bar.
 * @param {string} pattern for example "..xx.x"
 * @returns {boolean[]}
 */
function barsPlaying(pattern) {
  return [...pattern].map((bar) => bar === "x");
}

/**
 * A 120 BPM song in 4/4, a bar every 2 s, 16 bars: drums on the first beat, a piano intro over
 * bars 0 to 2 and a melody that enters in bar 3. The melody plays bars 3, 4 and 7, rests in bar 8
 * and plays bars 9 to 15 (one note per bar, from F5 up); bars 5 and 6 are a silent stretch.
 * @returns {import("../src/core/midi-file.js").MidiSong}
 */
function lateEntrySong() {
  const note = (/** @type {number} */ start, /** @type {number} */ end, /** @type {number} */ pitch) => ({ start, end, pitch, velocity: 100 });
  const melody = [note(6, 8, 72), note(8, 10, 74), note(14, 16, 76)];
  for (let bar = 9; bar < 16; bar++) melody.push(note(2 * bar, 2 * bar + 2, 68 + bar));
  const bytes = writeMidiFile({
    tempoBpm: 120,
    tracks: [
      { name: "intro", channel: 0, program: 0, notes: [note(0, 6, 60)] },
      { name: "melody", channel: 1, program: 73, notes: melody },
      { name: "drums", channel: 9, program: 0, notes: [note(0, 0.1, 36)] },
    ],
  });
  return readMidiFile(bytes);
}

/** The bars of `lateEntrySong` where the melody plays, in a preview: bars 3–4, then 7–13. */
const LATE_ENTRY_PREVIEW = [[72, 0], [74, 4], [76, 8], [77, 16], [78, 20], [79, 24], [80, 28], [81, 32]];

test("a track preview starts at the bar of the track's first note", () => {
  assert.deepEqual(previewWindow(barsPlaying("...xx")), [[3, 5]]);
});

test("a track preview jumps over two or more silent bars and keeps a shorter rest", () => {
  // Bar 1 is a one-bar rest inside the phrase; bars 3–4 and 6–8 are silent stretches.
  assert.deepEqual(previewWindow(barsPlaying("x.x..x...x")), [[0, 3], [5, 6], [9, 10]]);
});

test("a track preview leaves out the rest after the track's last note", () => {
  assert.deepEqual(previewWindow(barsPlaying("xx.")), [[0, 2]]);
});

test("a track preview stops once eight playing bars are heard, and the rests it keeps do not count", () => {
  assert.deepEqual(previewWindow(barsPlaying("xxxxxxxxxxxx")), [[0, 8]]);
  assert.deepEqual(previewWindow(barsPlaying("x.xxxxxxxxxx")), [[0, 9]]);
  assert.deepEqual(previewWindow(barsPlaying("xxx...xxxxxxxx")), [[0, 3], [6, 11]]);
});

test("a track preview of a track that never plays is empty", () => {
  assert.deepEqual(previewWindow(barsPlaying("....")), []);
  assert.deepEqual(previewWindow([]), []);
});

test("a track preview takes its number of bars and the silence it jumps over as parameters", () => {
  assert.deepEqual(previewWindow(barsPlaying("x.xxx"), 2, 1), [[0, 1], [2, 3]]);
  assert.deepEqual(previewWindow(barsPlaying("x..x"), 8, 3), [[0, 4]]);
});

test("a bar plays when a note sounds in it, and a note that ends on a bar line does not reach the next bar", () => {
  // Bars of 4/4, 2/4 and 4/4: bar lines on beats 0, 4, 6 and 10.
  const barLines = [0, 4, 6, 10];
  assert.deepEqual(soundingBars([{ pitch: 72, onset: 2, duration: 2 }], barLines), [true, false, false]);
  // A note that ends a hair after the bar line (a rounding error of the beat clock) does not either.
  assert.deepEqual(soundingBars([{ pitch: 72, onset: 0, duration: 4 + 1e-9 }], barLines), [true, false, false]);
  // A note held from beat 3 to beat 7 sounds in all three bars.
  assert.deepEqual(soundingBars([{ pitch: 72, onset: 3, duration: 4 }], barLines), [true, true, true]);
  assert.deepEqual(soundingBars([], barLines), [false, false, false]);
});

test("the bars of a preview play back to back, and a note that crosses the edge of a range keeps only its part inside", () => {
  // Five 4/4 bars; the preview plays bar 1, then bar 3.
  const barLines = [0, 4, 8, 12, 16, 20];
  const voices = {
    melody: [
      { pitch: 72, onset: 5, duration: 2 }, // in bar 1
      { pitch: 74, onset: 9, duration: 2 }, // in bar 2, left out
      { pitch: 76, onset: 12, duration: 6 }, // from bar 3 into bar 4, cut at its bar line
    ],
    others: [[{ pitch: 40, onset: 2, duration: 10 }]], // a bass held from bar 0 to the end of bar 2
    drums: [{ pitch: 36, onset: 4 }, { pitch: 38, onset: 10 }, { pitch: 36, onset: 12 }],
  };

  const { voices: windowed, durationBeats } = windowVoices(voices, [[1, 2], [3, 4]], barLines);

  assert.equal(durationBeats, 8);
  assert.deepEqual(windowed.melody, [{ pitch: 72, onset: 1, duration: 2 }, { pitch: 76, onset: 4, duration: 4 }]);
  assert.deepEqual(windowed.others, [[{ pitch: 40, onset: 0, duration: 4 }]]);
  assert.deepEqual(windowed.drums, [{ pitch: 36, onset: 0 }, { pitch: 36, onset: 4 }]);
  assert.equal(renderVoices(windowed, 120, 1000, durationBeats).length, 4000); // 8 beats at 120 BPM
});

test("a track preview of a MIDI song starts where the track enters and jumps over its long rests", () => {
  const midi = lateEntrySong();
  const excerpt = { melodyTrack: trackIndex(midi, "melody"), sourceGrid: /** @type {[number, number]} */ ([120, 0]), bars: /** @type {[number, number]} */ ([0, 16]) };

  const preview = trackPreview(midi, excerpt);

  assert.ok(preview);
  assert.equal(preview.firstBar, 3);
  assert.equal(preview.inExcerpt, true);
  // Bars 3–4, then bars 7–13 (bar 8 is a one-bar rest): eight playing bars and one rest.
  assert.equal(preview.durationBeats, 36);
  assert.deepEqual(preview.voices.melody.map((note) => [note.pitch, note.onset]), LATE_ENTRY_PREVIEW);
  assert.deepEqual(preview.voices.others, []);
  assert.deepEqual(preview.voices.drums, []);
  // The first note sounds at once, not after the six seconds of intro.
  const samples = renderVoices(preview.voices, 120, 8000, preview.durationBeats);
  assert.equal(samples.length, 144000);
  assert.ok(samples.subarray(0, 800).some((sample) => sample !== 0));
});

test("a track preview counts its first bar from the file's first bar, as the excerpt does", () => {
  const midi = lateEntrySong();
  const excerpt = { melodyTrack: trackIndex(midi, "melody"), sourceGrid: /** @type {[number, number]} */ ([120, 0]), bars: /** @type {[number, number]} */ ([2, 16]) };

  const preview = trackPreview(midi, excerpt);

  assert.ok(preview);
  assert.equal(preview.firstBar, 3);
  assert.deepEqual(preview.voices.melody.map((note) => [note.pitch, note.onset]), LATE_ENTRY_PREVIEW);
});

test("a track that plays nothing in the excerpt is previewed from the bar where it first plays in the whole song", () => {
  const midi = lateEntrySong();
  const excerpt = { melodyTrack: trackIndex(midi, "melody"), sourceGrid: /** @type {[number, number]} */ ([120, 0]), bars: /** @type {[number, number]} */ ([0, 3]) };

  const preview = trackPreview(midi, excerpt);

  assert.ok(preview);
  assert.equal(preview.inExcerpt, false);
  assert.equal(preview.firstBar, 3);
  assert.equal(preview.durationBeats, 36);
  assert.deepEqual(preview.voices.melody.map((note) => [note.pitch, note.onset]), LATE_ENTRY_PREVIEW);
});

test("a track with no notes, or only drums, has no preview", () => {
  const midi = lateEntrySong();
  const empty = { name: "empty", program: 0, isDrum: false, channel: 2, notes: [] };
  const withEmpty = { ...midi, instruments: [...midi.instruments, empty] };
  const excerpt = (/** @type {number} */ track) => ({ melodyTrack: track, sourceGrid: /** @type {[number, number]} */ ([120, 0]), bars: /** @type {[number, number]} */ ([0, 16]) });

  assert.equal(trackPreview(withEmpty, excerpt(withEmpty.instruments.length - 1)), null);
  assert.equal(trackPreview(midi, excerpt(trackIndex(midi, "drums"))), null);
});

test("the track preview's documented examples hold", () => {
  assert.deepEqual(previewWindow([false, true, true, false, true, false, false, true]), [[1, 5], [7, 8]]);
  assert.deepEqual(
    soundingBars([{ pitch: 72, onset: 2, duration: 2 }, { pitch: 74, onset: 7, duration: 1 }], [0, 4, 6, 10]),
    [true, false, true],
  );
  const melody = [{ pitch: 72, onset: 5, duration: 2 }, { pitch: 74, onset: 9, duration: 2 }, { pitch: 76, onset: 12, duration: 6 }];
  assert.deepEqual(windowVoices({ melody, others: [], drums: [] }, [[1, 2], [3, 4]], [0, 4, 8, 12, 16, 20]), {
    voices: { melody: [{ pitch: 72, onset: 1, duration: 2 }, { pitch: 76, onset: 4, duration: 4 }], others: [], drums: [] },
    durationBeats: 8,
  });
  const song = lateEntrySong();
  assert.equal(trackIndex(song, "melody"), 1);
  const preview = trackPreview(song, { melodyTrack: 1, sourceGrid: [120, 0], bars: [0, 16] });
  assert.deepEqual([preview?.firstBar, preview?.inExcerpt, preview?.durationBeats], [3, true, 36]);
});
