// @ts-check
// Write melody-ranking.json: the app's melody-track ranking of the project's MIDI songs.
//
// The catalog command (src/catalog/analysis.py) picks the melody track of thousands of MIDI files
// with a Python port of `describeTracks` and `rankMelodyTracks` (core/midi-song.js, research
// R13). Its parity test (tests/catalog/test_analysis.py) compares the port with what the app
// itself computes, which this script records for:
//
// - the synthetic songs committed in fixtures/midi-songs/ (always present);
// - the MIDI songs of data/sources.json, when their file is in data/raw/ (not committed; the
//   Python test skips a file that is missing or whose SHA-256 differs).
//
// The fixture holds track summaries and rankings only, never notes. Rerun it after a change to
// the ranking, from the repository root:
//
//   node arranger/tests/fixtures/make-melody-ranking.mjs

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readMidiFile } from "../../src/core/midi-file.js";
import { describeTracks, rankMelodyTracks } from "../../src/core/midi-song.js";

const fixturesDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(fixturesDir, "..", "..", "..");

/**
 * The MIDI files to rank, as repository-relative paths in a stable order.
 * @returns {string[]}
 */
function songPaths() {
  const synthetic = readdirSync(join(fixturesDir, "midi-songs"))
    .filter((name) => name.endsWith(".mid"))
    .sort()
    .map((name) => `arranger/tests/fixtures/midi-songs/${name}`);
  const manifest = JSON.parse(readFileSync(join(repoRoot, "data", "sources.json"), "utf8"));
  const raw = manifest.songs.map((/** @type {{path: string}} */ song) => song.path);
  return [...synthetic, ...raw];
}

/**
 * One fixture record: the file's hash, its track summaries and the app's ranking.
 * @param {string} path repository-relative path of a MIDI file that exists.
 */
function record(path) {
  const bytes = readFileSync(join(repoRoot, path));
  const midi = readMidiFile(new Uint8Array(bytes));
  const tracks = describeTracks(midi).map((track) => ({
    index: track.index,
    name: track.name,
    program: track.program,
    is_drum: track.isDrum,
    note_count: track.noteCount,
    mean_pitch: Number.isFinite(track.meanPitch) ? track.meanPitch : null,
    polyphony: track.polyphony,
  }));
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    tracks,
    ranking: rankMelodyTracks(describeTracks(midi)),
  };
}

const songs = songPaths()
  .filter((path) => existsSync(join(repoRoot, path)))
  .map(record);
const fixture = {
  about:
    "The app's melody-track ranking (core/midi-song.js describeTracks + rankMelodyTracks) of the " +
    "project's MIDI songs, written by node arranger/tests/fixtures/make-melody-ranking.mjs. " +
    "tests/catalog/test_analysis.py checks the Python port against it. No notes are stored.",
  songs,
};
const target = join(fixturesDir, "melody-ranking.json");
writeFileSync(target, `${JSON.stringify(fixture, null, 1)}\n`);
console.log(`${relative(repoRoot, target)}: ${songs.length} songs`);
