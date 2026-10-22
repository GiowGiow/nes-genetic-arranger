// @ts-check
/**
 * Channel paths: the geometry of the channel view, as pure functions.
 *
 * Each NES channel is drawn as a step line, like the neon lines of the "Bach Vision Test" video:
 * pitch is the height, time runs from right to left as the music plays, a note is a flat
 * segment and a change of pitch is a vertical jump with a slightly rounded corner. The line has
 * a gap where the voice rests and a tiny break where a note repeats, so a repeated note reads as
 * "again" without a dot. Only the head of the line, the note that sounds now, gets a dot.
 *
 * Everything here works in numbers (seconds, MIDI pitches, pixels) and knows nothing about the
 * canvas, so the tests check the shapes directly. The view turns the shapes into strokes.
 */

/** @typedef {{pitch: number, onset: number, duration: number}} Note in seconds; lists are sorted by onset */
/** @typedef {{x: number, y: number}} Point */
/** @typedef {{op: "moveTo" | "lineTo" | "arcTo", args: number[]}} PathCommand a canvas path call */

/**
 * The span of time on screen. The head (now) sits near the right edge, so most of the window
 * shows the notes that just played and a little shows nothing yet.
 *
 * @param {number} t playhead time in seconds
 * @param {number} seconds width of the window
 * @param {number} headFraction where now sits, from 0 (left edge) to 1 (right edge)
 * @returns {{start: number, end: number}}
 * @example
 * timeWindow(10, 8, 0.75) // {start: 4, end: 12}
 */
export function timeWindow(t, seconds, headFraction) {
  const start = t - seconds * headFraction;
  return { start, end: start + seconds };
}

/**
 * The x position of a time in a window drawn `width` pixels wide.
 *
 * @param {number} time
 * @param {{start: number, end: number}} window
 * @param {number} width
 * @example
 * timeToX(10, {start: 4, end: 12}, 800) // 600
 */
export function timeToX(time, window, width) {
  return ((time - window.start) / (window.end - window.start)) * width;
}

/**
 * The range of pitches the canvas shows: every note of every voice plus a margin, and at least
 * `minSpan` semitones so a tune on one or two pitches does not stretch over the whole height.
 *
 * @param {Note[][]} voices
 * @param {number} [margin] semitones of room above the highest and below the lowest note
 * @param {number} [minSpan] narrowest range, in semitones
 * @returns {{low: number, high: number}}
 * @example
 * pitchSpan([[{pitch: 40, onset: 0, duration: 1}], [{pitch: 72, onset: 0, duration: 1}]], 2) // {low: 38, high: 74}
 */
export function pitchSpan(voices, margin = 2, minSpan = 12) {
  let low = Infinity;
  let high = -Infinity;
  for (const notes of voices) {
    for (const { pitch } of notes) {
      if (pitch < low) low = pitch;
      if (pitch > high) high = pitch;
    }
  }
  if (low > high) return { low: 54, high: 54 + Math.max(minSpan, 24) };
  low -= margin;
  high += margin;
  if (high - low < minSpan) {
    const middle = (low + high) / 2;
    low = middle - minSpan / 2;
    high = middle + minSpan / 2;
  }
  return { low, high };
}

/**
 * The height of a pitch: the highest pitch at the top of the lane, the lowest at the bottom.
 *
 * @param {number} pitch MIDI pitch
 * @param {{low: number, high: number}} span from `pitchSpan`
 * @param {{top: number, bottom: number}} lane pixel rows the pitches may use
 * @example
 * pitchToY(60, {low: 40, high: 80}, {top: 10, bottom: 110}) // 60
 */
export function pitchToY(pitch, span, lane) {
  return lane.bottom - ((pitch - span.low) / (span.high - span.low)) * (lane.bottom - lane.top);
}

/**
 * The step line of one voice up to the playhead, as runs of points in pixels.
 *
 * Each run is a connected stretch of the line: a rest, or a repeated pitch, starts a new run, so
 * the canvas leaves a hole there. A note is a flat segment; a note that follows without a rest
 * at another pitch adds a vertical jump at its start. The note sounding at `t` stops at `t`, and
 * a note that starts before the previous one ends cuts it short (a voice plays one pitch at a
 * time, and the later note wins). A repeated pitch trims `gap` pixels off the end of the earlier
 * note; the trim is at most 40% of that note, so very short notes stay visible.
 *
 * @param {Note[]} notes sorted by onset
 * @param {{xOf: (time: number) => number, yOf: (pitch: number) => number, t: number, minX: number, gap: number}} view
 *   `xOf`, `yOf` map seconds and pitches to pixels; notes are cut at the playhead `t` and at the
 *   left edge `minX`; `gap` is the break between two notes of one pitch, in pixels
 * @returns {Point[][]}
 * @example
 * stepPolylines([{pitch: 60, onset: 0, duration: 1}, {pitch: 64, onset: 1, duration: 1}],
 *   {xOf: (s) => s * 100, yOf: (p) => 200 - p, t: 9, minX: -50, gap: 0})
 * // [[{x: 0, y: 140}, {x: 100, y: 140}, {x: 100, y: 136}, {x: 200, y: 136}]]
 */
export function stepPolylines(notes, { xOf, yOf, t, minX, gap }) {
  /** @type {Point[][]} */
  const runs = [];
  /** @type {Point[] | null} */
  let run = null;
  /** @type {{pitch: number, end: number} | null} */
  let previous = null;
  for (let index = 0; index < notes.length; index += 1) {
    const note = notes[index];
    if (note.onset > t) break;
    const next = notes[index + 1];
    let end = note.onset + note.duration;
    if (next && next.onset < end) end = next.onset;
    end = Math.min(end, t);
    if (end <= note.onset) continue;
    const endX = xOf(end);
    if (endX < minX) {
      run = null;
      previous = null;
      continue;
    }
    const startX = Math.max(xOf(note.onset), minX);
    const y = yOf(note.pitch);
    const touches = run !== null && previous !== null && Math.abs(note.onset - previous.end) < 1e-9;
    if (run && previous && touches && previous.pitch === note.pitch) {
      const last = run[run.length - 1];
      last.x -= Math.min(gap, 0.4 * (last.x - run[run.length - 2].x));
      run = null;
    }
    if (run && touches) {
      run.push({ x: startX, y }, { x: endX, y });
    } else {
      run = [{ x: startX, y }, { x: endX, y }];
      runs.push(run);
    }
    previous = { pitch: note.pitch, end };
  }
  return runs;
}

/**
 * Canvas path commands for a polyline whose corners are rounded.
 *
 * Each interior point becomes an `arcTo`, which draws the line up to the corner and bends it onto
 * the next segment. The radius is capped at half of each neighbouring segment, so two corners of
 * a short step never overlap.
 *
 * @param {Point[]} points
 * @param {number} radius preferred corner radius in pixels
 * @returns {PathCommand[]} call `path[command.op](...command.args)` on a canvas path
 * @example
 * roundedPath([{x: 0, y: 0}, {x: 10, y: 0}, {x: 10, y: 10}], 3)
 * // moveTo(0, 0), arcTo(10, 0, 10, 10, 3), lineTo(10, 10)
 */
export function roundedPath(points, radius) {
  if (points.length === 0) return [];
  /** @type {PathCommand[]} */
  const commands = [{ op: "moveTo", args: [points[0].x, points[0].y] }];
  for (let index = 1; index < points.length - 1; index += 1) {
    const before = points[index - 1];
    const corner = points[index];
    const after = points[index + 1];
    const cornerRadius = Math.min(radius, distance(before, corner) / 2, distance(corner, after) / 2);
    commands.push(
      cornerRadius < 0.25
        ? { op: "lineTo", args: [corner.x, corner.y] }
        : { op: "arcTo", args: [corner.x, corner.y, after.x, after.y, cornerRadius] },
    );
  }
  if (points.length > 1) {
    const last = points[points.length - 1];
    commands.push({ op: "lineTo", args: [last.x, last.y] });
  }
  return commands;
}

/**
 * The note that sounds at time `t` on a voice: the last note started, if it has not ended.
 *
 * @param {Note[]} notes sorted by onset
 * @param {number} t
 * @returns {Note | null} null in a rest, before the first note and after the last
 * @example
 * headNote([{pitch: 60, onset: 0, duration: 1}], 0.5) // {pitch: 60, onset: 0, duration: 1}
 */
export function headNote(notes, t) {
  let low = 0;
  let high = notes.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (notes[middle].onset <= t) low = middle + 1;
    else high = middle;
  }
  const note = notes[low - 1];
  return note && note.onset + note.duration > t ? note : null;
}

/**
 * The notes of a part that may overlap (chords), as flat segments inside a window, cut at its
 * left edge and at now.
 *
 * @param {Note[]} notes sorted by onset
 * @param {number} start left edge of the window, in seconds
 * @param {number} t playhead time
 * @returns {Array<{pitch: number, from: number, to: number}>}
 * @example
 * visibleSegments([{pitch: 60, onset: 0, duration: 2}], 1, 4) // [{pitch: 60, from: 1, to: 2}]
 */
export function visibleSegments(notes, start, t) {
  /** @type {Array<{pitch: number, from: number, to: number}>} */
  const segments = [];
  for (const note of notes) {
    if (note.onset > t) break;
    const to = Math.min(note.onset + note.duration, t);
    if (to < start) continue;
    segments.push({ pitch: note.pitch, from: Math.max(note.onset, start), to });
  }
  return segments;
}

/**
 * The drum hits on screen, each with the brightness it has now: a new hit is bright and an old
 * one dims, down to a floor so it stays faintly visible until it leaves the window.
 *
 * @param {number[]} onsets drum hit times in seconds, sorted
 * @param {number} start left edge of the window
 * @param {number} t playhead time
 * @param {number} fadeSeconds age at which a hit has dimmed to the floor
 * @returns {Array<{onset: number, alpha: number}>}
 * @example
 * drumTicks([5, 9.5], 4, 10, 2) // [{onset: 5, alpha: 0.2}, {onset: 9.5, alpha: 0.75}]
 */
export function drumTicks(onsets, start, t, fadeSeconds) {
  /** @type {Array<{onset: number, alpha: number}>} */
  const ticks = [];
  for (const onset of onsets) {
    if (onset > t) break;
    if (onset < start) continue;
    ticks.push({ onset, alpha: Math.max(0.2, 1 - (t - onset) / fadeSeconds) });
  }
  return ticks;
}

/**
 * @param {Point} a
 * @param {Point} b
 */
function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}
