// @ts-check
// Tests for ui/drawers.js: the settings drawer and the mixer drawer. They read as the rules of
// the two panels that slide in over the page: a button opens and closes each, focus follows the
// settings drawer in and out, Escape closes it, and the mixer opens by itself while music plays
// on a wide screen, unless the visitor closed it by hand.

import assert from "node:assert/strict";
import { test } from "node:test";

import { setUpDrawers } from "../src/ui/drawers.js";
import { FakeDocument, FakeElement } from "./fake-dom.js";

/**
 * The elements of both drawers on a fake page, wired by `setUpDrawers`.
 * @param {{wide?: boolean}} [page]
 */
function setUp({ wide = true } = {}) {
  const document = new FakeDocument();
  const make = (/** @type {string} */ tag, text = "") => {
    const element = new FakeElement(tag, document);
    element.textContent = text;
    return element;
  };
  const elements = {
    settings: make("section"),
    settingsTitle: make("h2"),
    settingsToggle: make("button", "Settings"),
    settingsClose: make("button", "Close"),
    mix: make("aside"),
    mixToggle: make("button", "Mix"),
    mixClose: make("button", "Close"),
  };
  elements.settings.append(elements.settingsTitle, elements.settingsClose);
  const state = { wide };
  const drawers = setUpDrawers(/** @type {any} */ ({
    settings: elements.settings,
    settingsTitle: elements.settingsTitle,
    settingsToggle: elements.settingsToggle,
    settingsClose: elements.settingsClose,
    mix: elements.mix,
    mixToggle: elements.mixToggle,
    mixClose: elements.mixClose,
    document,
    isWide: () => state.wide,
  }));
  return { document, elements, drawers, state };
}

test("the Settings button opens the drawer, says so for assistive technology and moves focus into it", () => {
  const { elements, drawers } = setUp();

  elements.settingsToggle.click();

  assert.equal(elements.settings.classList.contains("open"), true);
  assert.equal(elements.settingsToggle.getAttribute("aria-expanded"), "true");
  assert.equal(elements.settingsToggle.textContent, "Hide settings");
  assert.equal(elements.settingsTitle.focusCount, 1, "focus goes to the drawer's title");
  assert.equal(drawers.isSettingsOpen(), true);
});

test("pressing it again, or Close, closes the drawer and returns focus to the button when focus was inside", () => {
  const { document, elements, drawers } = setUp();
  elements.settingsToggle.click();
  elements.settingsClose.focus();

  elements.settingsClose.click();

  assert.equal(elements.settings.classList.contains("open"), false);
  assert.equal(elements.settingsToggle.getAttribute("aria-expanded"), "false");
  assert.equal(elements.settingsToggle.textContent, "Settings");
  assert.equal(document.activeElement, elements.settingsToggle);
  assert.equal(drawers.isSettingsOpen(), false);
});

test("closing the drawer leaves focus alone when it was somewhere else", () => {
  const { document, elements, drawers } = setUp();
  const elsewhere = new FakeElement("input", document);
  drawers.toggleSettings(true);
  elsewhere.focus();

  drawers.toggleSettings(false);

  assert.equal(document.activeElement, elsewhere);
  assert.equal(elements.settingsToggle.focusCount, 0);
});

test("Escape inside the settings drawer closes it", () => {
  const { elements, drawers } = setUp();
  drawers.toggleSettings(true);

  elements.settings.dispatch("keydown", { key: "Enter" });
  assert.equal(drawers.isSettingsOpen(), true, "other keys do nothing");
  elements.settings.dispatch("keydown", { key: "Escape" });

  assert.equal(drawers.isSettingsOpen(), false);
});

test("toggleSettings with no argument flips the drawer, and asking for the state it already has changes nothing", () => {
  const { elements, drawers } = setUp();

  drawers.toggleSettings();
  assert.equal(drawers.isSettingsOpen(), true);
  drawers.toggleSettings(true);
  assert.equal(elements.settingsTitle.focusCount, 1, "no second focus move");
  drawers.toggleSettings();
  assert.equal(drawers.isSettingsOpen(), false);
});

test("the Mix button and the mixer's Close open and close the drawer, and keep aria-expanded true to it", () => {
  const { elements, drawers } = setUp();

  elements.mixToggle.click();
  assert.equal(elements.mix.classList.contains("open"), true);
  assert.equal(elements.mixToggle.getAttribute("aria-expanded"), "true");
  assert.equal(drawers.isMixOpen(), true);

  elements.mixClose.click();
  assert.equal(elements.mix.classList.contains("open"), false);
  assert.equal(elements.mixToggle.getAttribute("aria-expanded"), "false");
});

test("playing opens the mixer by itself on a wide screen", () => {
  const { drawers } = setUp({ wide: true });

  drawers.autoOpenMix();

  assert.equal(drawers.isMixOpen(), true);
});

test("playing leaves the mixer closed on a narrow screen, where it would cover the page", () => {
  const { drawers } = setUp({ wide: false });

  drawers.autoOpenMix();

  assert.equal(drawers.isMixOpen(), false);
});

test("a mixer the visitor closed by hand stays closed while music plays, until they open it again", () => {
  const { elements, drawers } = setUp();
  elements.mixToggle.click(); // open by hand
  elements.mixToggle.click(); // close by hand

  drawers.autoOpenMix();
  assert.equal(drawers.isMixOpen(), false, "closed by hand: the page respects it");

  elements.mixToggle.click(); // open by hand again
  elements.mixClose.click();
  elements.mixToggle.click();
  assert.equal(drawers.isMixOpen(), true);
});

test("closing the mixer in code (not by hand) does not stop the next play from opening it", () => {
  const { drawers } = setUp();
  drawers.setMixDrawer(true);

  drawers.setMixDrawer(false);
  drawers.autoOpenMix();

  assert.equal(drawers.isMixOpen(), true);
});
