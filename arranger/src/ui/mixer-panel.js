// @ts-check
/**
 * Mixer panel: one level control per channel of the arrangement, under the player (spec 005,
 * story 1, FR-001).
 *
 * The first row is the master Volume, over everything that plays (`volume-slider.js`): a
 * percentage from 0 to 100 that the page hands to the player. It belongs to the listener's speakers,
 * not to a sound pack, so Reset leaves it alone.
 *
 * Each row names a channel by its role in the arrangement (Melody P1, Harmony P2, Bass TR, Drums
 * NO), in the channel's color, as the plan grid and the channel view draw it. The slider sets
 * the level in dB relative to the sound pack's own balance, from Off (-60 dB, `MIN_DB`) to
 * +12 dB (`MAX_DB`), in half-dB steps. The value beside it is signed: "+4 dB" is louder than the
 * pack made the channel, "−1 dB" softer. Mute silences a channel and keeps its level for later,
 * and Reset brings back the defaults of the sound pack in use (`defaults`). The panel is small: four
 * vertical faders side by side, under a line that says which pack the levels are for.
 *
 * Each channel strip also has a small analog needle meter, like the VU meters of a hi-fi
 * amplifier, that swings with the channel's loudness while music plays. The panel does not
 * listen to the audio itself: the page gives it a function that returns each channel's current
 * level (`readMeters`), and the panel reads it once per animation frame, only while metering is
 * on (`setMetering`), at most 30 times a second. The needle moves like a real VU meter: it rises
 * fast and falls slowly (`vuBallistics`).
 *
 * The panel only shows and reports levels: `onChange` gets the full levels on every change, and
 * the page hands them to the player and to local storage (`main.js`).
 */

import { CHANNELS, DEFAULT_LEVELS, DEFAULT_VOLUME, MAX_DB, MIN_DB, clampLevels } from "../audio/mixer.js";
import { createVolumeSlider } from "./volume-slider.js";

/** @typedef {import("../audio/mixer.js").Levels} Levels */
/** @typedef {import("../audio/chip-synth.js").ChannelName} ChannelName */

/** What each channel plays, and its color token in `style.css`. */
const ROLES = Object.freeze({
  P1: { name: "Melody", color: "--p1" },
  P2: { name: "Harmony", color: "--p2" },
  TR: { name: "Bass", color: "--tr" },
  NO: { name: "Drums", color: "--no" },
});

/** Slider step, in dB: finer than the ear can tell apart in a mix. */
const STEP_DB = 0.5;

// Counts the panels built, so the sliders of two panels never share an id.
let panelCount = 0;

// --- The needle meters ---------------------------------------------------------------------------

/** The quietest level the dial shows, in dB below full scale: the needle rests here. */
export const METER_FLOOR_DB = -42;

/** The level that pins the needle, in dB below full scale. A chip channel's loud peaks reach it. */
export const METER_CEILING_DB = -6;

/** How far the needle swings from its left stop to its right stop, in degrees. */
export const NEEDLE_RANGE_DEGREES = 90;

/** The slowest the meters redraw, in milliseconds: 30 frames a second is plenty for a needle. */
const MIN_FRAME_MS = 33;

/** Seconds a needle takes to cover 63 % of the way up, and of the way down: fast up, slow down. */
const RISE_SECONDS = 0.06;
const FALL_SECONDS = 0.35;

// The needle's pivot in the dial's 48 × 30 drawing, and its length.
const PIVOT_X = 24;
const PIVOT_Y = 29;
const NEEDLE_LENGTH = 20;

/**
 * Where the needle stands for a signal: 0 at rest on the left stop, 1 pinned on the right.
 * The scale is decibels, as the ear hears loudness: halfway across is halfway between
 * `METER_FLOOR_DB` and `METER_CEILING_DB`.
 *
 * @param {number} amplitude a level from 0 (silence) to 1 (full scale), a linear amplitude
 * @returns {number} a position from 0 to 1
 * @example
 * meterPosition(0); // 0
 * meterPosition(1); // 1: a full-scale wave pins the needle
 * meterPosition(10 ** (-24 / 20)); // 0.5: -24 dB is halfway between -42 and -6
 */
export function meterPosition(amplitude) {
  if (!(amplitude > 0)) return 0;
  const db = 20 * Math.log10(amplitude);
  return Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB)));
}

/**
 * The needle's rotation for a position, in degrees from straight up: negative leans left.
 * @param {number} position from 0 to 1 (a value outside is held at the stop)
 * @returns {number}
 * @example
 * needleAngle(0); // -45
 * needleAngle(0.5); // 0
 * needleAngle(1); // 45
 */
export function needleAngle(position) {
  const held = Math.min(1, Math.max(0, position));
  return (held - 0.5) * NEEDLE_RANGE_DEGREES;
}

/**
 * Move a needle toward its target the way a VU meter's coil does: quickly up, slowly down. Each
 * step covers a share of the remaining distance that depends on the time passed, so a slow
 * frame and two fast ones end in the same place, and the needle never overshoots.
 *
 * @param {number} previous the needle's position now, from 0 to 1
 * @param {number} target the position the signal asks for, from 0 to 1
 * @param {number} seconds time since the last step
 * @returns {number} the needle's new position
 * @example
 * vuBallistics(0, 1, 0.06); // 0.63: a jump to full scale is 63 % there after 60 ms
 * vuBallistics(1, 0, 0.06); // 0.84: and a drop to silence has only fallen 16 %
 */
export function vuBallistics(previous, target, seconds) {
  const tau = target > previous ? RISE_SECONDS : FALL_SECONDS;
  return previous + (target - previous) * (1 - Math.exp(-Math.max(0, seconds) / tau));
}

/** @param {number} value @param {number} decimals */
const round = (value, decimals) => Math.round(value * 10 ** decimals) / 10 ** decimals;

/** The transform that leans the needle to a position. @param {number} position */
const needleTransform = (position) => `rotate(${round(needleAngle(position), 1)} ${PIVOT_X} ${PIVOT_Y})`;

/**
 * Draw a meter's dial: a scale arc with a red zone at the loud end, ticks, and a needle at rest.
 * The needle is returned so the panel can lean it.
 *
 * @param {Document} doc
 * @returns {{meter: Element, needle: Element}}
 */
function createMeter(doc) {
  const namespace = "http://www.w3.org/2000/svg";
  /**
   * @param {string} tag
   * @param {Record<string, string | number>} attributes
   */
  const part = (tag, attributes) => {
    const node = doc.createElementNS(namespace, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    return node;
  };
  /** A point on the dial at a position, `radius` from the pivot. @param {number} position @param {number} radius */
  const at = (position, radius) => {
    const radians = (needleAngle(position) * Math.PI) / 180;
    return [round(PIVOT_X + radius * Math.sin(radians), 2), round(PIVOT_Y - radius * Math.cos(radians), 2)];
  };
  /** @param {number} from @param {number} to @param {number} radius */
  const arc = (from, to, radius) => {
    const [x1, y1] = at(from, radius);
    const [x2, y2] = at(to, radius);
    return `M${x1} ${y1} A${radius} ${radius} 0 0 1 ${x2} ${y2}`;
  };

  const meter = part("svg", { class: "mixer-vu", viewBox: "0 9 48 24", "aria-hidden": "true", focusable: "false" });
  meter.append(part("path", { class: "vu-dial", d: arc(0, 1, 22) }));
  // The last fifth of the scale is the red zone: above -13 dB a channel is working hard.
  meter.append(part("path", { class: "vu-hot", d: arc(0.8, 1, 22) }));
  for (let tick = 0; tick <= 5; tick++) {
    const [x1, y1] = at(tick / 5, 22);
    const [x2, y2] = at(tick / 5, 18.5);
    meter.append(part("line", { class: tick === 5 ? "vu-tick vu-hot" : "vu-tick", x1, y1, x2, y2 }));
  }
  const needle = part("g", { class: "vu-needle", transform: needleTransform(0) });
  needle.append(part("line", { class: "vu-hand", x1: PIVOT_X, y1: PIVOT_Y, x2: PIVOT_X, y2: PIVOT_Y - NEEDLE_LENGTH }));
  meter.append(needle, part("circle", { class: "vu-cap", cx: PIVOT_X, cy: PIVOT_Y, r: 2.2 }));
  return { meter, needle };
}

/**
 * A level as the panel shows it: signed dB with a real minus sign, or "Off" at the bottom.
 * @param {number} db a level from MIN_DB to MAX_DB
 * @returns {string}
 * @example
 * formatLevel(4); // "+4 dB"
 * formatLevel(-1.5); // "−1.5 dB"
 * formatLevel(-60); // "Off"
 */
export function formatLevel(db) {
  if (db <= MIN_DB) return "Off";
  const magnitude = Math.round(Math.abs(db) * 10) / 10;
  if (magnitude === 0) return "0 dB";
  return `${db > 0 ? "+" : "−"}${magnitude} dB`;
}

/**
 * Build the panel at the end of `container`.
 *
 * @param {HTMLElement} container
 * @param {{
 *   levels?: Levels, defaults?: () => Levels, onChange: (levels: Levels) => void,
 *   volume?: number, onVolume?: (percent: number) => void,
 *   readMeters?: () => Partial<Record<ChannelName, number>> | null,
 *   requestFrame?: (run: (now: number) => void) => number, cancelFrame?: (id: number) => void,
 *   reducedMotion?: boolean,
 * }} options
 *   `levels` to show first (default DEFAULT_LEVELS); `defaults` gives the levels Reset goes back
 *   to (default DEFAULT_LEVELS); `onChange` gets a copy of the full levels after every slider
 *   move, mute toggle or Reset; `volume` is the master volume to show first, in percent (default
 *   DEFAULT_VOLUME) and `onVolume` gets it after every move of the Volume slider; `readMeters`
 *   returns each channel's current loudness as a linear amplitude from 0 to 1 (the player's
 *   `channelLevels`), or null when nothing plays; `requestFrame` and `cancelFrame` default to the
 *   browser's animation frames; `reducedMotion` (default: the visitor's system setting) keeps the
 *   needles still
 * @returns {{
 *   set: (levels: Levels) => void, get: () => Levels, setTitle: (text: string) => void,
 *   setVolume: (percent: number) => void, getVolume: () => number,
 *   setMetering: (on: boolean) => void,
 * }}
 *   `set` shows levels without calling `onChange`; `get` returns a copy of the levels shown;
 *   `setTitle` names the sound pack the levels are for; `setVolume` shows a volume without
 *   calling `onVolume`; `setMetering(true)` starts the needles, and `setMetering(false)` lets
 *   them fall back to rest and stops the frames
 * @example
 * const mixer = createMixerPanel(card, { levels: readLevels(localStorage), onChange: (levels) => player.setLevels(levels) });
 * mixer.get().TR; // 4, the bass at its default
 */
export function createMixerPanel(
  container,
  {
    levels = DEFAULT_LEVELS,
    defaults = () => DEFAULT_LEVELS,
    onChange,
    volume = DEFAULT_VOLUME,
    onVolume = () => {},
    readMeters,
    requestFrame = (run) => globalThis.requestAnimationFrame(run),
    cancelFrame = (id) => globalThis.cancelAnimationFrame(id),
    reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false,
  },
) {
  const doc = container.ownerDocument;
  const idPrefix = `mixer-${++panelCount}`;
  let current = clampLevels(levels);

  /**
   * @template {keyof HTMLElementTagNameMap} K
   * @param {K} tag
   * @param {string} className
   * @param {string} [text]
   * @returns {HTMLElementTagNameMap[K]}
   */
  const element = (tag, className, text) => {
    const node = doc.createElement(tag);
    node.className = className;
    if (text) node.textContent = text;
    return node;
  };

  const root = element("div", "mixer");
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "Channel levels");
  const title = element("p", "mixer-title", "Mix");
  root.append(title);
  const master = createVolumeSlider(doc, { id: `${idPrefix}-volume`, volume, onInput: onVolume });
  root.append(master.root);
  /** @type {Partial<Record<ChannelName, {slider: HTMLInputElement, value: HTMLOutputElement, mute: HTMLButtonElement}>>} */
  const rows = {};
  /** @type {Partial<Record<ChannelName, Element>>} */
  const needles = {};

  for (const channel of CHANNELS) {
    const { name, color } = ROLES[channel];
    const row = element("div", "mixer-row");
    row.setAttribute("data-channel", channel);
    row.style.setProperty("--c", `var(${color})`);

    const slider = element("input", "mixer-level");
    slider.type = "range";
    slider.id = `${idPrefix}-${channel}`;
    slider.min = String(MIN_DB);
    slider.max = String(MAX_DB);
    slider.step = String(STEP_DB);

    const label = element("label", "mixer-name");
    label.htmlFor = slider.id;
    const swatch = element("span", "mixer-swatch");
    swatch.setAttribute("aria-hidden", "true");
    // The channel code is for the eye, next to the plan grid's; a screen reader hears the role.
    const code = element("span", "mixer-code", channel);
    code.setAttribute("aria-hidden", "true");
    label.append(swatch, element("span", "mixer-role", name), code);

    // The slider's aria-valuetext already speaks the value, so the visible copy stays silent.
    const value = element("output", "mixer-value");
    value.setAttribute("aria-hidden", "true");

    const mute = element("button", "button small mixer-mute", "Mute");
    mute.type = "button";
    mute.setAttribute("aria-label", `Mute ${name}`);

    slider.addEventListener("input", () => {
      current = clampLevels({ ...current, [channel]: Number(slider.value) });
      show(channel);
      onChange(clampLevels(current));
    });
    mute.addEventListener("click", () => {
      current = clampLevels({ ...current, muted: { ...current.muted, [channel]: !current.muted[channel] } });
      show(channel);
      onChange(clampLevels(current));
    });

    const { meter, needle } = createMeter(doc);
    row.append(label, slider, value, mute, meter);
    root.append(row);
    rows[channel] = { slider, value, mute };
    needles[channel] = needle;
  }

  const footer = element("div", "mixer-footer");
  const reset = element("button", "button small mixer-reset", "Reset");
  reset.type = "button";
  reset.title = "Back to this sound pack's default levels, in dB over its own balance";
  reset.addEventListener("click", () => {
    current = clampLevels(defaults());
    CHANNELS.forEach(show);
    onChange(clampLevels(current));
  });
  footer.append(reset);
  root.append(footer);
  container.append(root);

  /** @param {ChannelName} channel */
  function show(channel) {
    const { slider, value, mute } = /** @type {NonNullable<typeof rows[ChannelName]>} */ (rows[channel]);
    const text = formatLevel(current[channel]);
    slider.value = String(current[channel]);
    slider.setAttribute("aria-valuetext", text);
    value.textContent = text;
    mute.setAttribute("aria-pressed", String(current.muted[channel]));
  }
  CHANNELS.forEach(show);

  // The needle loop. Each frame reads the levels and moves every needle with `vuBallistics`.
  // After `setMetering(false)` it keeps running with a target of silence until the needles are
  // at rest, then stops asking for frames, so an idle mixer costs nothing.
  let wanted = false;
  let frame = /** @type {number | null} */ (null);
  let lastFrameTime = /** @type {number | null} */ (null);
  /** @type {Record<ChannelName, number>} */
  const positions = { P1: 0, P2: 0, TR: 0, NO: 0 };

  /** @param {number} now */
  function tick(now) {
    frame = null;
    if (lastFrameTime !== null && now - lastFrameTime < MIN_FRAME_MS) {
      frame = requestFrame(tick);
      return;
    }
    const seconds = lastFrameTime === null ? 0 : (now - lastFrameTime) / 1000;
    lastFrameTime = now;
    const heard = wanted ? readMeters?.() : null;
    let moving = false;
    for (const channel of CHANNELS) {
      let next = vuBallistics(positions[channel], meterPosition(heard?.[channel] ?? 0), seconds);
      if (!wanted && next < 0.003) next = 0; // close enough to rest
      positions[channel] = next;
      moving ||= next > 0;
      /** @type {Element} */ (needles[channel]).setAttribute("transform", needleTransform(next));
    }
    if (wanted || moving) frame = requestFrame(tick);
    else lastFrameTime = null;
  }

  /** @param {boolean} on */
  function setMetering(on) {
    if (!readMeters || reducedMotion) return;
    wanted = on;
    if (frame === null && (on || CHANNELS.some((channel) => positions[channel] > 0))) frame = requestFrame(tick);
  }

  return {
    setMetering,
    set(newLevels) {
      current = clampLevels(newLevels);
      CHANNELS.forEach(show);
    },
    get: () => clampLevels(current),
    setTitle(text) {
      title.textContent = text;
    },
    setVolume: (percent) => master.set(percent),
    getVolume: () => master.get(),
  };
}
