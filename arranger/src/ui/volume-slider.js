// @ts-check
/**
 * Volume slider: the one control for the master volume, from 0 to 100 percent (`mixer.js`,
 * `volumeToGain`).
 *
 * It sits in two places on the page, the mixer drawer (its first row) and, smaller, next to the
 * Play button, so the sound can be turned down without opening the drawer. Both are built by this
 * function and kept in step by the page, which is why the slider only reports what the visitor
 * does (`onInput`) and shows what it is told (`set`).
 */

import { clampVolume } from "../audio/mixer.js";

/**
 * Build a labeled volume slider.
 *
 * @param {Document} doc the document that owns the elements
 * @param {{
 *   id: string,
 *   volume: number,
 *   onInput: (percent: number) => void,
 *   compact?: boolean,
 * }} options `id` ties the label to the slider and must be unique on the page; `volume` is the
 *   percentage to show first; `onInput` gets the clamped percentage after each move by the
 *   visitor; `compact` is the small version beside Play (short visible label, no percentage)
 * @returns {{root: HTMLElement, set: (percent: number) => void, get: () => number}}
 *   `set` shows a volume without calling `onInput`
 * @example
 * const volume = createVolumeSlider(document, { id: "volume", volume: 80, onInput: (percent) => player.setVolume(percent) });
 * card.append(volume.root);
 */
export function createVolumeSlider(doc, { id, volume, onInput, compact = false }) {
  const root = doc.createElement("div");
  root.className = compact ? "volume-compact" : "mixer-volume";

  const slider = doc.createElement("input");
  slider.type = "range";
  slider.id = id;
  slider.min = "0";
  slider.max = "100";
  slider.step = "1";
  slider.className = "volume-level";

  const label = doc.createElement("label");
  label.className = "volume-label";
  label.htmlFor = id;
  label.textContent = compact ? "Vol" : "Volume";
  // The short visible label is for the eye; the slider is named in full for a screen reader.
  if (compact) slider.setAttribute("aria-label", "Volume");

  // The slider's aria-valuetext already speaks the value, so the visible copy stays silent.
  const value = doc.createElement("output");
  value.className = "mixer-value volume-value";
  value.setAttribute("aria-hidden", "true");

  let current = clampVolume(volume);
  const show = () => {
    slider.value = String(current);
    slider.setAttribute("aria-valuetext", `${current}%`);
    value.textContent = `${current}%`;
  };
  show();

  slider.addEventListener("input", () => {
    current = clampVolume(Number(slider.value));
    show();
    onInput(current);
  });

  root.append(label, slider);
  if (!compact) root.append(value);
  return {
    root,
    set(percent) {
      current = clampVolume(percent);
      show();
    },
    get: () => current,
  };
}
