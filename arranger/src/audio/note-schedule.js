// @ts-check
// When the notes of a channel sound, for the sound packs that draw notes themselves.
//
// A channel of the arrangement is monophonic, like a chip voice: it plays one note at a time, so
// a note stops when the next one starts. The arrangement gives notes in beats; the packs need
// seconds. This module turns one into the other, and a MIDI pitch into a frequency, so that the
// packs agree on the timeline of the NES chip render.

/**
 * The frequency of a MIDI note in Hz, with A4 (69) at 440 Hz and 12 equal steps per octave.
 * @param {number} pitch MIDI note number
 * @returns {number}
 * @example
 * noteFrequency(69); // 440
 * noteFrequency(60); // ≈ 261.63, middle C
 */
export function noteFrequency(pitch) {
  return 440 * 2 ** ((pitch - 69) / 12);
}

/**
 * The notes of one channel with the seconds each one sounds: a channel plays one note at a time,
 * so a note stops when the next one starts. At equal onsets the lowest pitch comes last and
 * survives the cut, so a kick wins over a snare and a snare over a hi-hat.
 * @param {Array<{pitch: number, onset: number, duration: number, velocity: number}>} notes
 * @param {number} secondsPerBeat
 * @returns {Array<{start: number, end: number, note: {pitch: number, onset: number, duration: number, velocity: number}}>}
 * @example
 * sounding([{ pitch: 60, onset: 0, duration: 4, velocity: 100 }, { pitch: 62, onset: 1, duration: 1, velocity: 100 }], 0.5)
 * // [{ start: 0, end: 0.5, ... }, { start: 0.5, end: 1, ... }]: the first note is cut by the second
 */
export function sounding(notes, secondsPerBeat) {
  const ordered = [...notes].sort((a, b) => a.onset - b.onset || b.pitch - a.pitch);
  return ordered.map((note, index) => {
    const start = note.onset * secondsPerBeat;
    const next = index + 1 < ordered.length ? ordered[index + 1].onset * secondsPerBeat : Infinity;
    return { start, end: Math.min((note.onset + note.duration) * secondsPerBeat, next), note };
  });
}
