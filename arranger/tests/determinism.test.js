// @ts-check
// End to end, in Node: ABC text -> lead sheet -> GA runner (full pace) -> arrangement -> MIDI bytes.
// The same input, seed and settings must give the same bytes (spec 002, FR-026 and SC-005).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { readLeadSheetAbc } from "../src/core/abc-reader.js";
import { assemble, findViolations } from "../src/core/arrangement.js";
import { arrangementToMidi } from "../src/core/midi-export.js";
import { defaultSettings } from "../src/core/settings.js";
import { createRunner } from "../src/runner.js";
import { loadAbcjs, repoRoot } from "./helpers.js";

const defaultConfig = JSON.parse(readFileSync(join(repoRoot, "configs/default.json"), "utf8"));
const korobeiniki = readFileSync(join(repoRoot, "data/leadsheets/korobeiniki.abc"), "utf8");

// SHA-256 of the MIDI file that Korobeiniki and seed 1 give. A change here means the arrangement
// changed: update a pin only on purpose, after checking why. The first pin uses the settings of
// spec 002 (fidelity 0.5, every value allowed), so it guards the engine across default changes;
// the second pins today's defaults (spec 004: fidelity 1, no arp32, no TR root).
const KOROBEINIKI_SEED_1_SHA256 = "766657a732c1cac8a283566cd27968b2a130097c60fcd1c5ff1d507ccd0ad8ff";
const KOROBEINIKI_SEED_1_DEFAULTS_SHA256 = "2970a544d26217fbdaf7038adae40a4c3b18059e0113962875a11db3da69b3a9";

/** The settings of spec 002, before the defaults of spec 004. */
const SPEC_002_SETTINGS = {
  weights: { ...defaultConfig.weights, fidelity: 0.5 },
  allowed: {
    p2: ["hold", "arp16", "arp32", "echo", "third"],
    tr: ["root", "octave_pump", "root_fifth", "walking"],
    no: ["none", "half_time", "eighth_beat", "sixteenth_beat", "fill"],
    p1_octave: [0, 12, -12],
  },
};

/**
 * Run the whole pipeline once and return the MIDI bytes.
 *
 * @param {number} seed
 * @param {"watch" | "full"} pace
 * @param {Record<string, unknown>} [overrides] settings that replace the defaults
 */
async function arrangeKorobeiniki(seed, pace = "full", overrides = {}) {
  const leadSheet = readLeadSheetAbc(loadAbcjs(), korobeiniki);
  /** @type {any[]} */
  const messages = [];
  let clock = 0;
  const runner = createRunner({
    post: (message) => messages.push(message),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  const settings = { ...defaultSettings(defaultConfig), ...overrides, seed };
  await runner.handle({ type: "run", runId: "k", leadSheet, settings, pace });
  const done = messages.find((message) => message.type === "done");
  assert.ok(done, JSON.stringify(messages.find((message) => message.type === "error")));
  const arrangement = assemble(leadSheet, done.bestPlan);
  assert.deepEqual(findViolations(arrangement, leadSheet), []);
  return { bytes: arrangementToMidi(arrangement), done };
}

test("the same song, seed and settings give the same MIDI bytes, whatever the pace", async () => {
  const first = await arrangeKorobeiniki(1, "full");
  const second = await arrangeKorobeiniki(1, "full");
  const watched = await arrangeKorobeiniki(1, "watch");
  assert.deepEqual(second.bytes, first.bytes);
  assert.deepEqual(watched.bytes, first.bytes);
  assert.equal(watched.done.generations, first.done.generations);
});

test("another seed gives another arrangement", async () => {
  const one = await arrangeKorobeiniki(1);
  const two = await arrangeKorobeiniki(2);
  assert.notDeepEqual(two.bytes, one.bytes);
});

test("Korobeiniki with seed 1 and the spec 002 settings keeps its pinned MIDI hash", async () => {
  const { bytes } = await arrangeKorobeiniki(1, "full", SPEC_002_SETTINGS);
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(digest, KOROBEINIKI_SEED_1_SHA256);
});

test("Korobeiniki with seed 1 and the default settings keeps its pinned MIDI hash", async () => {
  const { bytes } = await arrangeKorobeiniki(1);
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(digest, KOROBEINIKI_SEED_1_DEFAULTS_SHA256);
});
