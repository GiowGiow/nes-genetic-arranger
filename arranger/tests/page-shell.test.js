// @ts-check
// Tests for the page shell's shared pieces: the stylesheets index.html links, the motion tokens
// that every animation uses, and the toast region. They keep the HTML and the CSS in step with
// the modules (notify.js, busy.js, drawers.js) that expect them.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { repoRoot } from "./helpers.js";

const appDir = join(repoRoot, "arranger");
const read = (/** @type {string} */ name) => readFileSync(join(appDir, name), "utf8");
const html = read("index.html");

test("index.html links every stylesheet of the app, the motion tokens first and the drawers after the page shell", () => {
  const linked = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((match) => match[1]);
  const onDisk = readdirSync(appDir).filter((name) => name.endsWith(".css"));

  assert.deepEqual([...linked].sort(), [...onDisk].sort(), "no stylesheet is left unlinked");
  assert.equal(linked[0], "motion.css", "tokens come before the sheets that use them");
  assert.ok(linked.indexOf("drawers.css") > linked.indexOf("style.css"), "the drawers build on the shell's tokens");
});

test("the toast region is one polite live region that notify.js finds by data-toasts", () => {
  const region = html.match(/<div class="toast-region"[^>]*>/);

  assert.ok(region, "index.html has a toast region");
  assert.match(region[0], /role="status"/);
  assert.match(region[0], /aria-live="polite"/);
  assert.match(region[0], /data-toasts/);
});

test("motion.css defines the duration and easing tokens, the three entrance animations and the reduced-motion switch", () => {
  const css = read("motion.css");

  for (const token of ["--dur-1", "--dur-2", "--dur-3", "--ease-out", "--ease-in-out", "--ease-pop"]) {
    assert.match(css, new RegExp(`${token}:`), token);
  }
  for (const name of ["panel-in", "fade-in", "pop", "spin", "shimmer"]) {
    assert.match(css, new RegExp(`@keyframes ${name}\\b`), name);
  }
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration: \.01ms !important/);
  assert.match(css, /transition-duration: \.01ms !important/);
});

test("the entrance animations move only transform and opacity, which the compositor can do alone", () => {
  const css = read("motion.css");
  const keyframes = [...css.matchAll(/@keyframes [\w-]+ \{([\s\S]*?)\n\}/g)].map((match) => match[1]);

  assert.ok(keyframes.length >= 5);
  for (const body of keyframes) {
    const properties = [...body.matchAll(/([a-z-]+)\s*:/g)].map((match) => match[1]);
    for (const property of properties) assert.ok(["opacity", "transform"].includes(property), property);
  }
});

test("the drawers' styles moved out of style.css into drawers.css", () => {
  const shell = read("style.css");
  const drawers = read("drawers.css");

  assert.doesNotMatch(shell, /^#settings \{/m);
  assert.match(drawers, /^#settings \{/m);
  assert.match(drawers, /^\.tip \{/m, "the tooltips went with them");
});

test("the busy spinner and the toast have styles in style.css", () => {
  const shell = read("style.css");

  assert.match(shell, /\.spinner\b/);
  assert.match(shell, /\.button\.is-busy::before/);
  assert.match(shell, /\.toast-region \{/);
  assert.match(shell, /\.toast \{/);
});
