// @ts-check
// Tests for ui/theme.js: the light and dark themes. The page starts in the theme the visitor
// chose last time, or else the one their system prefers; a button in the header flips it, and the
// choice is remembered in this browser only.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { THEME_COLORS, THEME_KEY, initialTheme, setUpThemeToggle } from "../src/ui/theme.js";
import { repoRoot } from "./helpers.js";
import { FakeDocument, FakeElement } from "./fake-dom.js";

test("a stored choice wins over the system's preference", () => {
  assert.equal(initialTheme("light", false), "light");
  assert.equal(initialTheme("dark", true), "dark");
});

test("without a stored choice the system decides, and the default is dark, the app's own look", () => {
  assert.equal(initialTheme(null, true), "light");
  assert.equal(initialTheme(null, false), "dark");
  assert.equal(initialTheme(undefined, false), "dark");
});

test("anything stored that is not a theme is ignored", () => {
  assert.equal(initialTheme("sepia", false), "dark");
  assert.equal(initialTheme("", true), "light");
  assert.equal(initialTheme("LIGHT", false), "dark", "names are exact: another script wrote this");
});

/**
 * A page with a root element, a theme-color meta and a toggle button, and a storage that keeps
 * what is written to it (or throws, like a private window).
 * @param {{stored?: string | null, prefersLight?: boolean, broken?: boolean}} [options]
 */
function setUp({ stored = null, prefersLight = false, broken = false } = {}) {
  const document = new FakeDocument();
  const root = new FakeElement("html", document);
  const meta = new FakeElement("meta", document);
  meta.setAttribute("content", THEME_COLORS.dark);
  const button = new FakeElement("button", document);
  /** @type {Map<string, string>} */
  const saved = new Map(stored === null ? [] : [[THEME_KEY, stored]]);
  const storage = {
    getItem: (/** @type {string} */ key) => {
      if (broken) throw new Error("storage is blocked");
      return saved.get(key) ?? null;
    },
    setItem: (/** @type {string} */ key, /** @type {string} */ value) => {
      if (broken) throw new Error("storage is blocked");
      saved.set(key, value);
    },
  };
  const toggle = setUpThemeToggle(/** @type {any} */ (button), storage, { root: /** @type {any} */ (root), meta: /** @type {any} */ (meta), prefersLight });
  return { root, meta, button, saved, toggle };
}

test("the page takes the stored theme at once, and the button says what it shows", () => {
  const { root, button, meta } = setUp({ stored: "light" });

  assert.equal(root.getAttribute("data-theme"), "light");
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.match(/** @type {any} */ (button).innerHTML, /data-icon="sun"/);
  assert.equal(meta.getAttribute("content"), THEME_COLORS.light, "the browser's own bars follow the page");
});

test("with nothing stored the button follows the system preference, and nothing is written", () => {
  const dark = setUp({ prefersLight: false });
  assert.equal(dark.root.getAttribute("data-theme"), "dark");
  assert.equal(dark.button.getAttribute("aria-pressed"), "false");
  assert.match(/** @type {any} */ (dark.button).innerHTML, /data-icon="moon"/);
  assert.equal(dark.saved.size, 0, "following the system is not a choice");

  const light = setUp({ prefersLight: true });
  assert.equal(light.root.getAttribute("data-theme"), "light");
});

test("pressing the button flips the theme and remembers the choice", () => {
  const { root, button, saved, meta } = setUp({ prefersLight: false });

  button.click();
  assert.equal(root.getAttribute("data-theme"), "light");
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.equal(saved.get(THEME_KEY), "light");
  assert.equal(meta.getAttribute("content"), THEME_COLORS.light);
  assert.match(/** @type {any} */ (button).innerHTML, /data-icon="sun"/);

  button.click();
  assert.equal(root.getAttribute("data-theme"), "dark");
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.equal(saved.get(THEME_KEY), "dark");
  assert.match(/** @type {any} */ (button).innerHTML, /data-icon="moon"/);
});

test("the button keeps one name for assistive technology and says its state with aria-pressed", () => {
  const { button } = setUp();
  const name = button.getAttribute("aria-label");

  assert.equal(name, "Light theme");
  button.click();
  assert.equal(button.getAttribute("aria-label"), name, "a toggle whose name changes with its state is read twice");
  assert.equal(button.getAttribute("title"), "Switch to the dark theme");
});

test("the icon is drawn inline, hidden from screen readers, and takes the text color", () => {
  const { button } = setUp();
  const icon = /** @type {any} */ (button).innerHTML;

  assert.match(icon, /^<svg /);
  assert.match(icon, /aria-hidden="true"/);
  assert.match(icon, /currentColor/);
  assert.doesNotMatch(icon, /<image|href=/, "nothing is loaded from elsewhere");
});

test("blocked storage does not stop the toggle: the theme still changes for this visit", () => {
  const { root, button, toggle } = setUp({ broken: true, prefersLight: true });

  assert.equal(root.getAttribute("data-theme"), "light", "read failed: the system preference");
  assert.doesNotThrow(() => button.click());
  assert.equal(root.getAttribute("data-theme"), "dark");
  assert.equal(toggle.current(), "dark");
});

test("no storage at all (the page could not reach localStorage) is the same as blocked storage", () => {
  const document = new FakeDocument();
  const root = new FakeElement("html", document);
  const button = new FakeElement("button", document);

  assert.doesNotThrow(() => setUpThemeToggle(/** @type {any} */ (button), /** @type {any} */ (null), { root: /** @type {any} */ (root), meta: null, prefersLight: true }));
  assert.equal(root.getAttribute("data-theme"), "light");
  assert.doesNotThrow(() => button.click());
  assert.equal(root.getAttribute("data-theme"), "dark");
});

test("set applies a theme without remembering it, for the page's own use", () => {
  const { root, saved, toggle } = setUp();

  toggle.set("light");

  assert.equal(root.getAttribute("data-theme"), "light");
  assert.equal(saved.size, 0);
});

test("every change is announced on the document, so canvases can draw their colors again", () => {
  const document = new FakeDocument();
  /** @type {string[]} */
  const heard = [];
  /** @type {any} */ (document).dispatchEvent = (/** @type {CustomEvent} */ event) => heard.push(`${event.type}:${event.detail.theme}`);
  const root = new FakeElement("html", document);
  const button = new FakeElement("button", document);
  const storage = { getItem: () => null, setItem: () => {} };

  setUpThemeToggle(/** @type {any} */ (button), storage, { root: /** @type {any} */ (root), meta: null, prefersLight: false });
  button.click();

  assert.deepEqual(heard, ["themechange:dark", "themechange:light"]);
});

// --- The stylesheet -----------------------------------------------------------------------------

/** @param {string} hex */
function luminance(hex) {
  const [red, green, blue] = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** @param {string} foreground @param {string} background */
function contrast(foreground, background) {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

const css = readFileSync(join(repoRoot, "arranger", "theme.css"), "utf8");
const lightBlock = /:root\[data-theme="light"\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
/** @param {string} name */
const lightToken = (name) => {
  const value = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(lightBlock)?.[1];
  assert.ok(value, `theme.css sets ${name} for the light theme`);
  return value;
};

test("the light theme is warm beige console plastic with dark ink", () => {
  assert.equal(lightToken("--bg").toLowerCase(), "#ede6d6");
  assert.equal(lightToken("--text").toLowerCase(), "#22201c");
  assert.equal(lightToken("--muted").toLowerCase(), "#6e6656");
  assert.equal(THEME_COLORS.light.toLowerCase(), "#ede6d6", "the browser bar matches the ground");
});

test("in the light theme every text color reaches 4.5:1 on the ground and on the cards", () => {
  const card = "#F7F2E6";
  for (const name of ["--text", "--muted", "--p1", "--p2", "--tr", "--no"]) {
    for (const [surface, background] of /** @type {const} */ ([["ground", lightToken("--bg")], ["card", card]])) {
      const ratio = contrast(lightToken(name), background);
      assert.ok(ratio >= 4.5, `${name} on the ${surface} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test("the primary button's label stays readable on the light theme's blue", () => {
  assert.ok(contrast("#ffffff", lightToken("--p1")) >= 4.5);
});

test("theme.css only changes colors under the light theme, apart from the theme button's own rules", () => {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").split("}").map((rule) => rule.trim()).filter((rule) => rule.includes("{"));
  const outside = rules.filter((rule) => !/data-theme="light"/.test(rule) && !rule.startsWith(".theme-toggle"));
  assert.deepEqual(outside, [], "every other rule is scoped to the light theme");
});
