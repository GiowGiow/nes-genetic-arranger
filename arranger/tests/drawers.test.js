// @ts-check
// Tests for ui/drawers.js: the settings drawer and the mixer drawer. They read as the rules of
// the two panels that slide in over the page:
// - a button opens and closes each, and says so with aria-expanded;
// - the settings drawer is modal: a scrim covers the page, the page behind it is inert, Tab stays
//   inside, a click on the scrim or Escape closes it, and focus goes in and comes back;
// - the mixer is modal only where it is a sheet over the page (a narrow screen); on a wide screen
//   it sits beside the player, which stays in use while the visitor moves the faders;
// - the mixer never opens by itself: playing only makes the Mix button pulse, once.

import assert from "node:assert/strict";
import { test } from "node:test";

import { backgroundOf, setUpDrawers } from "../src/ui/drawers.js";
import { FakeDocument, FakeElement } from "./fake-dom.js";

/**
 * Put `child` inside `parent`, the way the real DOM links them (the fake keeps `parent` only).
 * @param {FakeElement} parent
 * @param {FakeElement} child
 */
function adopt(parent, child) {
  parent.append(child);
  /** @type {any} */ (child).parentElement = parent;
  return child;
}

/**
 * The page of the real index.html in miniature: a body with a toast region, a scrim and a main,
 * and in main a header, the two drawers and the player, each with the buttons the module wires.
 * @param {{wide?: boolean}} [page]
 */
function setUp({ wide = true } = {}) {
  const document = new FakeDocument();
  const make = (/** @type {string} */ tag, text = "") => {
    const element = new FakeElement(tag, document);
    element.textContent = text;
    return element;
  };
  const body = make("body");
  const elements = {
    body,
    toasts: adopt(body, make("div")),
    main: adopt(body, make("main")),
    scrim: make("div"),
    header: make("header"),
    settings: make("section"),
    settingsTitle: make("h2"),
    settingsToggle: make("button", "Settings"),
    settingsClose: make("button", "Close"),
    settingsInput: make("input"),
    mix: make("aside"),
    mixToggle: make("button", "Mix"),
    mixClose: make("button", "Close"),
    mixSlider: make("input"),
    player: make("section"),
  };
  elements.toasts.classList.add("toast-region");
  adopt(body, elements.scrim);
  adopt(elements.main, elements.header);
  adopt(elements.main, elements.settings);
  adopt(elements.main, elements.mix);
  adopt(elements.main, elements.player);
  adopt(elements.header, elements.settingsToggle);
  adopt(elements.player, elements.mixToggle);
  for (const child of [elements.settingsTitle, elements.settingsInput, elements.settingsClose]) adopt(elements.settings, child);
  for (const child of [elements.mixClose, elements.mixSlider]) adopt(elements.mix, child);

  const state = { wide, mixChanges: /** @type {boolean[]} */ ([]) };
  const drawers = setUpDrawers(/** @type {any} */ ({
    settings: elements.settings,
    settingsTitle: elements.settingsTitle,
    settingsToggle: elements.settingsToggle,
    settingsClose: elements.settingsClose,
    mix: elements.mix,
    mixToggle: elements.mixToggle,
    mixClose: elements.mixClose,
    scrim: elements.scrim,
    document,
    isWide: () => state.wide,
    focusables: (/** @type {FakeElement} */ root) => root.children.filter((child) => child.tagName !== "H2"),
    onMixChange: (/** @type {boolean} */ open) => state.mixChanges.push(open),
  }));
  /**
   * A key press on the page.
   * @param {string} key
   * @param {{shiftKey?: boolean}} [options]
   * @returns {{prevented: boolean}}
   */
  const press = (key, { shiftKey = false } = {}) => {
    const outcome = { prevented: false };
    for (const listener of document.listeners.keydown ?? []) listener({ key, shiftKey, preventDefault: () => (outcome.prevented = true) });
    return outcome;
  };
  return { document, elements, drawers, state, press };
}

/** @param {FakeElement} element */
const isInert = (element) => /** @type {any} */ (element).inert === true;

// --- Settings: open, close, focus ---------------------------------------------------------------

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

test("toggleSettings with no argument flips the drawer, and asking for the state it already has changes nothing", () => {
  const { elements, drawers } = setUp();

  drawers.toggleSettings();
  assert.equal(drawers.isSettingsOpen(), true);
  drawers.toggleSettings(true);
  assert.equal(elements.settingsTitle.focusCount, 1, "no second focus move");
  drawers.toggleSettings();
  assert.equal(drawers.isSettingsOpen(), false);
});

// --- Settings: modal ----------------------------------------------------------------------------

test("an open settings drawer puts a scrim behind it and makes the rest of the page inert", () => {
  const { elements, drawers } = setUp();

  drawers.toggleSettings(true);

  assert.equal(elements.scrim.classList.contains("open"), true, "the scrim shows");
  assert.equal(isInert(elements.header), true);
  assert.equal(isInert(elements.player), true);
  assert.equal(isInert(elements.mix), true, "the other drawer sits behind the scrim too");
  assert.equal(isInert(elements.settings), false, "the drawer itself stays live");
  assert.equal(isInert(elements.main), false, "main holds the drawer, so it is not inert as a whole");
  assert.equal(isInert(elements.toasts), false, "a message must stay readable and dismissable");
  assert.equal(isInert(elements.scrim), false, "the scrim takes the click that closes the drawer");
});

test("closing the drawer takes the scrim away and gives the page back", () => {
  const { elements, drawers } = setUp();
  drawers.toggleSettings(true);

  drawers.toggleSettings(false);

  assert.equal(elements.scrim.classList.contains("open"), false);
  for (const name of /** @type {const} */ (["header", "player", "mix"])) assert.equal(isInert(elements[name]), false, name);
});

test("focus returns to the Settings button after the page is live again", () => {
  const { document, elements, drawers } = setUp();
  drawers.toggleSettings(true);
  elements.settingsClose.focus();
  /** @type {boolean[]} */
  const inertWhenFocused = [];
  const focus = elements.settingsToggle.focus.bind(elements.settingsToggle);
  elements.settingsToggle.focus = () => {
    // The button sits in the header, which is inert while the drawer is open and cannot take focus.
    inertWhenFocused.push(isInert(elements.header));
    focus();
  };

  drawers.toggleSettings(false);

  assert.deepEqual(inertWhenFocused, [false]);
  assert.equal(document.activeElement, elements.settingsToggle);
});

test("a click on the scrim closes the settings drawer", () => {
  const { elements, drawers } = setUp();
  drawers.toggleSettings(true);

  elements.scrim.click();

  assert.equal(drawers.isSettingsOpen(), false);
});

test("Escape closes the settings drawer wherever the focus is, and other keys do nothing", () => {
  const { document, elements, drawers, press } = setUp();
  drawers.toggleSettings(true);
  new FakeElement("input", document).focus(); // outside the drawer

  press("Enter");
  assert.equal(drawers.isSettingsOpen(), true, "other keys do nothing");
  press("Escape");

  assert.equal(drawers.isSettingsOpen(), false);
  assert.equal(elements.scrim.classList.contains("open"), false);
});

test("Tab stays inside the settings drawer: past the last control it goes to the first, and Shift+Tab from the first to the last", () => {
  const { document, elements, drawers, press } = setUp();
  drawers.toggleSettings(true);

  // The drawer's controls in order: the input, then Close.
  elements.settingsClose.focus();
  const forward = press("Tab");
  assert.equal(forward.prevented, true);
  assert.equal(document.activeElement, elements.settingsInput, "wrapped to the first control");

  const backward = press("Tab", { shiftKey: true });
  assert.equal(backward.prevented, true);
  assert.equal(document.activeElement, elements.settingsClose, "wrapped to the last control");
});

test("Tab in the middle of the drawer is left to the browser", () => {
  const { document, elements, drawers, press } = setUp();
  drawers.toggleSettings(true);
  elements.settingsInput.focus();

  assert.equal(press("Tab").prevented, false);
  assert.equal(document.activeElement, elements.settingsInput, "nothing moved");
});

test("Shift+Tab from the drawer's title, which is not a control, goes to the last control", () => {
  const { document, elements, drawers, press } = setUp();
  drawers.toggleSettings(true); // focus is on the title

  press("Tab", { shiftKey: true });

  assert.equal(document.activeElement, elements.settingsClose);
});

test("Tab does nothing special while no drawer is open", () => {
  const { press } = setUp();

  assert.equal(press("Tab").prevented, false);
});

// --- The mixer ----------------------------------------------------------------------------------

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

test("the mixer takes focus on opening by hand, and gives it back to the Mix button on closing", () => {
  const { document, elements } = setUp();

  elements.mixToggle.click();
  assert.equal(document.activeElement, elements.mix);

  elements.mixClose.focus();
  elements.mixClose.click();
  assert.equal(document.activeElement, elements.mixToggle);
});

test("on a wide screen the mixer is not modal: no scrim, the page stays live and a click elsewhere leaves it open", () => {
  const { elements, drawers } = setUp({ wide: true });

  elements.mixToggle.click();

  assert.equal(elements.scrim.classList.contains("open"), false);
  assert.equal(isInert(elements.player), false);
  elements.scrim.click();
  assert.equal(drawers.isMixOpen(), true);
});

test("on a narrow screen the mixer is a sheet over the page: it has the scrim, the page is inert, and the scrim closes it", () => {
  const { elements, drawers } = setUp({ wide: false });

  elements.mixToggle.click();

  assert.equal(elements.scrim.classList.contains("open"), true);
  assert.equal(isInert(elements.header), true);
  assert.equal(isInert(elements.mix), false);

  elements.scrim.click();
  assert.equal(drawers.isMixOpen(), false);
  assert.equal(elements.scrim.classList.contains("open"), false);
  assert.equal(isInert(elements.header), false);
});

test("Escape closes a modal mixer anywhere, and a wide one only when the focus is inside it", () => {
  const wide = setUp({ wide: true });
  wide.elements.mixToggle.click();
  new FakeElement("button", wide.document).focus(); // the player, outside the mixer
  wide.press("Escape");
  assert.equal(wide.drawers.isMixOpen(), true, "the player's own keys are not hijacked");
  wide.elements.mixSlider.focus();
  wide.press("Escape");
  assert.equal(wide.drawers.isMixOpen(), false);

  const narrow = setUp({ wide: false });
  narrow.elements.mixToggle.click();
  new FakeElement("button", narrow.document).focus();
  narrow.press("Escape");
  assert.equal(narrow.drawers.isMixOpen(), false);
});

test("Escape closes the settings drawer first when both are open, and the mixer on the next press", () => {
  const { drawers, elements, press } = setUp({ wide: true });
  elements.mixToggle.click();
  drawers.toggleSettings(true);

  press("Escape");
  assert.equal(drawers.isSettingsOpen(), false);
  assert.equal(drawers.isMixOpen(), true, "a wide mixer is not modal and the focus left it");
});

test("the mixer reports each change of its state, so the meters can run only while it shows", () => {
  const { elements, state, drawers } = setUp();

  elements.mixToggle.click();
  elements.mixClose.click();
  drawers.setMixDrawer(true);

  assert.deepEqual(state.mixChanges, [true, false, true]);
});

// --- Playing does not open the mixer -----------------------------------------------------------

test("playing never opens the mixer, on a wide screen or a narrow one", () => {
  for (const wide of [true, false]) {
    const { drawers } = setUp({ wide });
    drawers.hintMix();
    assert.equal(drawers.isMixOpen(), false, wide ? "wide" : "narrow");
  }
});

test("the first play makes the Mix button pulse once, and the pulse ends with its animation", () => {
  const { elements, drawers } = setUp();

  drawers.hintMix();
  assert.equal(elements.mixToggle.classList.contains("nudge"), true);

  elements.mixToggle.dispatch("animationend");
  assert.equal(elements.mixToggle.classList.contains("nudge"), false);

  drawers.hintMix();
  assert.equal(elements.mixToggle.classList.contains("nudge"), false, "once per visit is enough");
});

test("no pulse when the mixer is already open, and pressing the button ends a pulse", () => {
  const open = setUp();
  open.elements.mixToggle.click();
  open.drawers.hintMix();
  assert.equal(open.elements.mixToggle.classList.contains("nudge"), false);

  const pulsing = setUp();
  pulsing.drawers.hintMix();
  pulsing.elements.mixToggle.click();
  assert.equal(pulsing.elements.mixToggle.classList.contains("nudge"), false);
});

test("a page that still calls autoOpenMix gets the pulse, not an open drawer", () => {
  const { drawers, elements } = setUp({ wide: true });

  drawers.autoOpenMix();

  assert.equal(drawers.isMixOpen(), false);
  assert.equal(elements.mixToggle.classList.contains("nudge"), true);
});

// --- The inert background -----------------------------------------------------------------------

test("backgroundOf lists what is next to the drawer on its way up to the body, and keeps the scrim and the toasts out", () => {
  const { elements } = setUp();

  const background = backgroundOf(
    /** @type {any} */ (elements.settings),
    (/** @type {any} */ element) => element === elements.scrim || element.classList.contains("toast-region"),
  );

  assert.deepEqual(new Set(background), new Set([elements.header, elements.mix, elements.player]));
});
