// @ts-check
/**
 * Mixer panel: one level control per channel of the arrangement, under the player (spec 005,
 * story 1, FR-001).
 *
 * Each row names a channel by its role in the arrangement (Melody P1, Harmony P2, Bass TR, Drums
 * NO), in the channel's color, as the plan grid and the channel view draw it. The slider sets
 * the level in dB relative to the sound pack's own balance, from Off (-60 dB, `MIN_DB`) to
 * +12 dB (`MAX_DB`), in half-dB steps. The value beside it is signed: "+4 dB" is louder than the
 * pack made the channel, "−1 dB" softer. Mute silences a channel and keeps its level for later,
 * and Reset brings back the default levels (`DEFAULT_LEVELS`).
 *
 * The panel only shows and reports levels: `onChange` gets the full levels on every change, and
 * the page hands them to the player and to local storage (`main.js`).
 */

import { CHANNELS, DEFAULT_LEVELS, MAX_DB, MIN_DB, clampLevels } from "../audio/mixer.js";

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
 * @param {{levels?: Levels, onChange: (levels: Levels) => void}} options `levels` to show first
 *   (default DEFAULT_LEVELS); `onChange` gets a copy of the full levels after every slider move,
 *   mute toggle or Reset
 * @returns {{set: (levels: Levels) => void, get: () => Levels}} `set` shows levels without
 *   calling `onChange`; `get` returns a copy of the levels shown
 * @example
 * const mixer = createMixerPanel(card, { levels: readLevels(localStorage), onChange: (levels) => player.setLevels(levels) });
 * mixer.get().TR; // 4, the bass at its default
 */
export function createMixerPanel(container, { levels = DEFAULT_LEVELS, onChange }) {
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
  /** @type {Partial<Record<ChannelName, {slider: HTMLInputElement, value: HTMLOutputElement, mute: HTMLButtonElement}>>} */
  const rows = {};

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

    row.append(label, slider, value, mute);
    root.append(row);
    rows[channel] = { slider, value, mute };
  }

  const footer = element("div", "mixer-footer");
  const note = element("p", "mixer-note", "Levels in dB over the sound pack's own balance.");
  const reset = element("button", "button small mixer-reset", "Reset");
  reset.type = "button";
  reset.title = "Back to the default levels";
  reset.addEventListener("click", () => {
    current = clampLevels(DEFAULT_LEVELS);
    CHANNELS.forEach(show);
    onChange(clampLevels(current));
  });
  footer.append(note, reset);
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

  return {
    set(newLevels) {
      current = clampLevels(newLevels);
      CHANNELS.forEach(show);
    },
    get: () => clampLevels(current),
  };
}
