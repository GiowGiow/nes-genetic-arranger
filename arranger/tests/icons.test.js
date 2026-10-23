// @ts-check
// Tests for ui/icons.js: the small inline icons of the page. They are SVG strings, drawn in the
// text color so they follow the theme, and hidden from assistive technology (the label beside
// them carries the meaning). Never emoji.

import assert from "node:assert/strict";
import { test } from "node:test";

import { ICONS, downloadIcon, iconMarkup } from "../src/ui/icons.js";

test("every icon is an inline SVG in the current text color, hidden from assistive technology", () => {
  for (const [name, icon] of Object.entries(ICONS)) {
    const markup = iconMarkup(name);
    assert.match(markup, /^<svg /, name);
    assert.match(markup, /aria-hidden="true"/, name);
    assert.match(markup, /viewBox="0 0 24 24"/, name);
    assert.match(markup, /stroke="currentColor"/, name);
    assert.doesNotMatch(markup, /\p{Extended_Pictographic}/u, name);
    assert.ok(icon.length > 20, name);
  }
});

test("the file types get their era's objects: a cassette for the WAV, a floppy disk for the MIDI", () => {
  assert.equal(downloadIcon("tune.wav"), "cassette");
  assert.equal(downloadIcon("tune.mid"), "floppy");
  assert.equal(downloadIcon("tune.midi"), "floppy");
  assert.equal(downloadIcon("tune.config.json"), "cartridge");
  assert.equal(downloadIcon("tune.abc"), "sheet");
  assert.equal(downloadIcon("tune.xyz"), "sheet", "an unknown file is a plain sheet");
  assert.ok(ICONS.cassette && ICONS.floppy && ICONS.cartridge && ICONS.sheet);
});

test("asking for an icon that does not exist gives nothing, not an error", () => {
  assert.equal(iconMarkup("nope"), "");
});
