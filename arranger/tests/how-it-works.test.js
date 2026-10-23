// @ts-check
// Tests for ui/how-it-works.js: the method explained in eight steps, each with a figure drawn from
// the real core modules (spec 005, User Story 7, FR-027). The figure data must be what the core
// computes for the song (Korobeiniki here), so the explanation can never drift from the method.

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { DRUM_SOUNDS, PULSE_DUTY, SAMPLE_RATE, noiseWave, pulseWave, triangleWave } from "../src/audio/chip-synth.js";
import { assemble } from "../src/core/arrangement.js";
import { createGAParams, evolve } from "../src/core/evolution.js";
import { CRITERIA, criterionScores, fitness } from "../src/core/fitness.js";
import { P2_TEXTURES, allowedGenes, decode, randomPopulation } from "../src/core/genome.js";
import { leadSheetFromJson } from "../src/core/leadsheet.js";
import { eliteIndices, rouletteSelect } from "../src/core/operators.js";
import { createRandom } from "../src/core/random.js";
import { buildTables } from "../src/core/tables.js";
import {
  EVOLUTION_FIGURE_BARS,
  GENOME_FIGURE_BARS,
  HOW_IT_WORKS_CLOSING,
  HOW_IT_WORKS_LINKS,
  HOW_IT_WORKS_REFERENCES,
  LEAD_SHEET_FIGURE_BARS,
  WAVE_SAMPLES,
  howItWorksSteps,
  initialBestPlan,
  renderHowItWorks,
  renderHowSkeleton,
  revealOnScroll,
} from "../src/ui/how-it-works.js";
import { GENE_NAMES } from "../src/ui/plan-grid.js";
import { assertClose, readFixture, readJson, repoRoot } from "./helpers.js";

const korobeiniki = leadSheetFromJson(readFixture("leadsheets/korobeiniki.json"));
const planFixture = readFixture("plans/korobeiniki-s1.json");
/** The command line's best plan for Korobeiniki, seed 1, as one flat array of genes. */
const plan = Uint8Array.from(planFixture.best_plan.flat());
/** The settings of that run: fidelity weight 0.5 and every gene value allowed. */
const runSettings = { ...planFixture.settings, seed: 1 };
/** The app's defaults: no 32nd-note arpeggio, no held bass root. */
const defaults = { ...readJson(join(repoRoot, "configs", "default.json")), seed: 1 };

const steps = howItWorksSteps({ leadSheet: korobeiniki, plan, settings: runSettings });
/** @param {string} id */
const step = (id) => {
  const found = steps.find((candidate) => candidate.id === id);
  assert.ok(found, `no step ${id}`);
  return found;
};

test("How it works has eight steps in the order of the method, each with a title, plain text and a figure", () => {
  assert.deepEqual(
    steps.map((candidate) => candidate.id),
    ["lead-sheet", "genome", "fitness", "loop", "selection", "evolution", "realization", "sound"],
  );
  for (const candidate of steps) {
    assert.ok(candidate.title.length > 0, `${candidate.id} has no title`);
    assert.ok(candidate.text.length >= 2 && candidate.text.length <= 4, `${candidate.id} has ${candidate.text.length} paragraphs`);
    for (const paragraph of candidate.text) assert.ok(paragraph.trim().length > 0, `${candidate.id} has an empty paragraph`);
    assert.ok(candidate.figure.kind.length > 0);
    assert.ok(candidate.figure.alt.length > 0, `${candidate.id}'s figure has no alt text`);
    assert.ok(candidate.figure.caption.length > 0, `${candidate.id}'s figure has no caption`);
  }
});

test("the steps name the song they draw", () => {
  assert.match(step("lead-sheet").text.join(" "), /Korobeiniki/);
  assert.match(step("lead-sheet").figure.caption, /Korobeiniki/);
});

test("the lead-sheet figure holds the first bars' melody and chords, as the lead sheet has them", () => {
  const { data } = step("lead-sheet").figure;
  assert.equal(data.bars.length, LEAD_SHEET_FIGURE_BARS);
  data.bars.forEach((/** @type {any} */ bar, /** @type {number} */ index) => {
    const source = korobeiniki.bars[index];
    assert.equal(bar.number, index + 1);
    assert.equal(bar.start, index * 4, "4/4 bars start every 4 beats");
    assert.deepEqual(bar.melody, source.melody.map(({ pitch, onset, duration }) => ({ pitch, onset, duration })));
    assert.deepEqual(bar.chords, source.chords.map(({ symbol, onset, duration }) => ({ symbol, onset, duration })));
    assert.equal(bar.label, source.label);
    assert.equal(bar.phraseEnd, source.phraseEnd);
  });
  assert.deepEqual(data.bars.map((/** @type {any} */ bar) => bar.chords[0].symbol), ["E", "Am", "E", "Am"]);
  assert.deepEqual(data.pitchRange, [69, 76], "A4 to E5");
});

test("the lead-sheet figure lists the song's parts with their roles and bars", () => {
  const { data } = step("lead-sheet").figure;
  assert.deepEqual(data.parts, [
    { label: "A", role: "verse", firstBar: 1, lastBar: 16 },
    { label: "B", role: "chorus", firstBar: 17, lastBar: 24 },
    { label: "A", role: "verse", firstBar: 25, lastBar: 32 },
  ]);
  assert.equal(data.totalBars, 32);
  assert.equal(data.phraseCount, 8);
});

test("the genome figure shows the plan's own gene values, bar by bar", () => {
  const { data } = step("genome").figure;
  assert.equal(data.bars.length, GENOME_FIGURE_BARS);
  const decoded = decode(plan);
  data.bars.forEach((/** @type {any} */ bar, /** @type {number} */ index) => {
    assert.equal(bar.number, index + 1);
    assert.deepEqual(bar.genes, [...plan.subarray(index * 4, index * 4 + 4)]);
    // The names are the plan grid's, so the figure reads like the Evolution tab.
    const [p2, tr, no, octave] = bar.genes;
    assert.deepEqual(bar.names, [GENE_NAMES.p2[p2], GENE_NAMES.tr[tr], GENE_NAMES.no[no], GENE_NAMES.oct[octave]]);
    assert.equal(P2_TEXTURES[p2], decoded[index].p2);
    assert.equal(bar.phraseEnd, korobeiniki.bars[index].phraseEnd);
  });
  assert.deepEqual(data.rows.map((/** @type {any} */ row) => row.label), ["P2", "TR", "NO", "P1 oct"]);
  assert.equal(data.source, "run");
});

test("the genome figure counts the genes and the plans the settings allow", () => {
  const withDefaults = howItWorksSteps({ leadSheet: korobeiniki, plan, settings: { ...defaults } });
  const { data } = withDefaults[1].figure;
  assert.equal(data.totalBars, 32);
  assert.equal(data.totalGenes, 128);
  // The defaults allow 4 P2 textures, 3 TR textures, 5 drum patterns and 3 octaves.
  assert.equal(data.choicesPerBar, 4 * 3 * 5 * 3);
  assert.equal(data.planDigits, Math.floor(32 * Math.log10(180)) + 1);
  assert.deepEqual(data.rows.map((/** @type {any} */ row) => row.allowed), allowedGenes(defaults.allowed));
});

test("the fitness figure lists the seven criteria with the scores of fitness.js and the run's weights", () => {
  const { data } = step("fitness").figure;
  const tables = buildTables(korobeiniki);
  const scores = criterionScores(tables, plan, 32);
  assert.deepEqual(data.criteria.map((/** @type {any} */ row) => row.name), [...CRITERIA]);
  data.criteria.forEach((/** @type {any} */ row) => {
    assert.equal(row.score, scores[row.name][0]);
    assert.equal(row.weight, runSettings.weights[row.name]);
  });
  assert.equal(data.fitness, fitness(tables, plan, 32, runSettings.weights)[0]);
  // The same plan scores the same in the command line (constitution, principle I).
  assertClose(data.fitness, planFixture.fitness);
  assertClose(Object.fromEntries(data.criteria.map((/** @type {any} */ row) => [row.name, row.score])), planFixture.scores);
});

test("a criterion that does not apply to the song has no score in the fitness figure", () => {
  const allVerse = { ...korobeiniki, bars: korobeiniki.bars.map((bar) => ({ ...bar, role: /** @type {const} */ ("verse") })) };
  const verseFitness = howItWorksSteps({ leadSheet: allVerse, plan, settings: runSettings }).find((candidate) => candidate.id === "fitness");
  assert.ok(verseFitness);
  const contrast = verseFitness.figure.data.criteria.find((/** @type {any} */ row) => row.name === "contrast");
  assert.equal(contrast.score, null);
  assert.equal(contrast.share, null, "a criterion that cannot be judged has no share of the mean");
  assert.match(verseFitness.figure.alt, /contrast does not apply/i);
});

test("the evolution figure is the same for the same seed, and another seed draws other parents", () => {
  const again = howItWorksSteps({ leadSheet: korobeiniki, plan, settings: runSettings });
  assert.deepEqual(again.find((candidate) => candidate.id === "evolution")?.figure, step("evolution").figure);
  const seedTwo = howItWorksSteps({ leadSheet: korobeiniki, plan, settings: { ...runSettings, seed: 2 } });
  assert.notDeepEqual(seedTwo.find((candidate) => candidate.id === "evolution")?.figure.data.parentA, step("evolution").figure.data.parentA);
});

test("the evolution figure's child takes parent A's bars before the cut and parent B's after it, with one mutated gene", () => {
  const { data } = step("evolution").figure;
  const length = EVOLUTION_FIGURE_BARS * 4;
  assert.equal(data.parentA.length, length);
  assert.equal(data.parentB.length, length);
  assert.ok(data.cut >= 1 && data.cut < EVOLUTION_FIGURE_BARS, "each parent gives at least one bar");
  const crossed = [...data.parentA.slice(0, data.cut * 4), ...data.parentB.slice(data.cut * 4)];
  assert.deepEqual(data.crossedChild, crossed);
  const { bar, gene, from, to } = data.mutation;
  const changed = data.child.flatMap((/** @type {number} */ value, /** @type {number} */ index) => (value === crossed[index] ? [] : [index]));
  assert.deepEqual(changed, [(bar - 1) * 4 + gene], "exactly the mutated gene differs");
  assert.equal(from, crossed[(bar - 1) * 4 + gene]);
  assert.equal(to, data.child[(bar - 1) * 4 + gene]);
  assert.notEqual(from, to);
});

test("the evolution figure draws only the values the settings allow", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const { data } = howItWorksSteps({ leadSheet: korobeiniki, plan, settings: { ...defaults, seed } }).find((candidate) => candidate.id === "evolution")?.figure ?? { data: null };
    const allowed = allowedGenes(defaults.allowed);
    for (const genes of [data.parentA, data.parentB, data.child]) {
      genes.forEach((/** @type {number} */ value, /** @type {number} */ index) => {
        assert.ok(allowed[index % 4].includes(value), `seed ${seed}: gene ${index} is ${value}`);
      });
    }
  }
});

test("the realization figure holds the notes that assemble gives in its two bars, on all four channels", () => {
  const { data } = step("realization").figure;
  const arrangement = assemble(korobeiniki, plan);
  const first = data.firstBar - 1;
  const start = first * 4;
  const end = start + 8;
  for (const channel of /** @type {const} */ (["P1", "P2", "TR", "NO"])) {
    const expected = arrangement.channels[channel]
      .filter((note) => note.onset >= start && note.onset < end)
      .map((note) => ({ pitch: note.pitch, onset: note.onset - start, duration: note.duration }));
    assert.deepEqual(data.channels[channel], expected, channel);
    assert.ok(expected.length > 0, `${channel} plays in bars ${data.firstBar} and ${data.firstBar + 1}`);
  }
  // Each pitched channel gets its own lane, from its lowest to its highest note in the window.
  for (const channel of ["P1", "P2", "TR"]) {
    const pitches = data.channels[channel].map((/** @type {{pitch: number}} */ note) => note.pitch);
    assert.deepEqual(data.pitchRanges[channel], [Math.min(...pitches), Math.max(...pitches)], channel);
  }
  // This plan leaves the drums out of most bars of the A part, so the first two bars with every
  // channel in both are the fill that closes the A part and the first bar of the B part.
  assert.equal(data.firstBar, 16);
  assert.deepEqual(data.bars.map((/** @type {any} */ bar) => bar.number), [16, 17]);
  assert.deepEqual(data.bars.map((/** @type {any} */ bar) => bar.names), [
    ["third", "walking", "fill", "0"],
    ["arp16", "octave pump", "16th beat", "0"],
  ]);
});

test("the realization figure falls back to the first bars when no two bars play on every channel", () => {
  const noDrums = Uint8Array.from(plan, (gene, index) => (index % 4 === 2 ? 0 : gene));
  const { data } = howItWorksSteps({ leadSheet: korobeiniki, plan: noDrums, settings: runSettings }).find((candidate) => candidate.id === "realization")?.figure ?? { data: null };
  assert.equal(data.firstBar, 1);
  assert.deepEqual(data.channels.NO, []);
});

test("the sound figure holds one cycle of each pulse width and of the triangle, and noise, from the chip synthesizer", () => {
  const { data } = step("sound").figure;
  assert.deepEqual(
    data.waves.map((/** @type {any} */ wave) => wave.id),
    ["pulse-12.5", "pulse-25", "pulse-50", "triangle", "noise"],
  );
  const frequency = SAMPLE_RATE / WAVE_SAMPLES;
  for (const wave of data.waves) {
    assert.equal(wave.values.length, WAVE_SAMPLES, wave.id);
    assert.ok(wave.values.every((/** @type {number} */ value) => value >= -1 && value <= 1), wave.id);
  }
  const [narrow, quarter, square, triangle, noise] = data.waves;
  assert.deepEqual(narrow.values, [...pulseWave(frequency, WAVE_SAMPLES, 0.125)]);
  assert.deepEqual(quarter.values, [...pulseWave(frequency, WAVE_SAMPLES, 0.25)]);
  assert.deepEqual(square.values, [...pulseWave(frequency, WAVE_SAMPLES, 0.5)]);
  assert.equal(narrow.values.filter((/** @type {number} */ value) => value === 1).length, WAVE_SAMPLES / 8);
  assert.equal(narrow.channel, "P2", "P2 plays the 12.5% pulse");
  assert.equal(quarter.channel, "P1", "P1 plays the 25% pulse");
  assert.deepEqual([PULSE_DUTY.P2, PULSE_DUTY.P1], [narrow.duty, quarter.duty]);
  assert.deepEqual(triangle.values, [...triangleWave(frequency, WAVE_SAMPLES)]);
  assert.deepEqual([Math.min(...triangle.values), Math.max(...triangle.values)], [-1, 1]);
  assert.equal(new Set(triangle.values).size, 16, "the chip's triangle has 16 levels");
  // The hi-hat's bright, short-mode noise: the register starts at 1, so the darker kick and snare
  // settings stay flat for most of 64 samples.
  const hiHat = DRUM_SOUNDS[42];
  assert.deepEqual(noise.values, [...noiseWave(WAVE_SAMPLES, hiHat.period, hiHat.shortMode)]);
  assert.deepEqual(new Set(noise.values), new Set([1, -1]));
  const signChanges = noise.values.filter((/** @type {number} */ value, /** @type {number} */ index) => index > 0 && value !== noise.values[index - 1]).length;
  assert.ok(signChanges >= 10, `the noise row should look like noise, it changes sign ${signChanges} times`);
});

test("without a plan, the figures use the best plan of generation 0, where a run with the same seed starts", () => {
  const first = howItWorksSteps({ leadSheet: korobeiniki, settings: defaults });
  const second = howItWorksSteps({ leadSheet: korobeiniki, plan: null, settings: defaults });
  assert.deepEqual(first, second);
  const start = initialBestPlan(korobeiniki, defaults);
  assert.equal(start.length, 32 * 4);
  // The GA's own generation 0 for these settings and seed (core/evolution.js `initialBestPlan`).
  const params = createGAParams({
    populationSize: defaults.population_size,
    maxGenerations: 1,
    stagnationWindow: defaults.stagnation_window,
    mutationRate: defaults.mutation_rate,
    eliteCount: defaults.elite_count,
    allowed: allowedGenes(defaults.allowed),
  });
  /** @type {any} */
  const result = {};
  const run = evolve(createRandom(defaults.seed), buildTables(korobeiniki), 32, params, defaults.weights, result);
  for (let next = run.next(); !next.done; next = run.next());
  assert.deepEqual(start, result.initialBestPlan);
  assert.deepEqual(first[1].figure.data.bars[0].genes, [...start.subarray(0, 4)]);
  assert.equal(first[1].figure.data.source, "generation-0");
  assert.match(first[1].text.join(" "), /No run yet/);
  assert.match(first[1].text.join(" "), /60 random plans/);
});

test("the plan may be given flat or as one array of four genes per bar", () => {
  const nested = howItWorksSteps({ leadSheet: korobeiniki, plan: planFixture.best_plan, settings: runSettings });
  assert.deepEqual(nested, steps);
});

test("a plan for another number of bars is refused", () => {
  assert.throws(
    () => howItWorksSteps({ leadSheet: korobeiniki, plan: plan.subarray(0, 16), settings: runSettings }),
    RangeError,
  );
});

test("the closing links lead to the repository, its sources and licenses, and the article", () => {
  const hrefs = HOW_IT_WORKS_LINKS.map((link) => link.href);
  assert.deepEqual(hrefs, [
    "https://github.com/GiowGiow/nes-genetic-arranger",
    "https://github.com/GiowGiow/nes-genetic-arranger#inputs-sources-and-licenses",
    "https://github.com/GiowGiow/nes-genetic-arranger/blob/main/paper/tp1.pdf",
  ]);
  for (const link of HOW_IT_WORKS_LINKS) assert.ok(link.label.length > 0);
});

// --- The genetic algorithm, step by step (loop, selection, fitness shares) ---------------------

/** @param {string} id @param {any} [settings] */
const stepWith = (id, settings = defaults) => {
  const found = howItWorksSteps({ leadSheet: korobeiniki, plan, settings }).find((candidate) => candidate.id === id);
  assert.ok(found, `no step ${id}`);
  return found;
};

test("the fitness step counts the seven criteria and gives each its share of the weighted mean", () => {
  const { data } = step("fitness").figure;
  const judged = data.criteria.filter((/** @type {any} */ row) => row.score !== null);
  const total = judged.reduce((/** @type {number} */ sum, /** @type {any} */ row) => sum + row.weight, 0);
  assert.equal(data.criteria.length, 7);
  for (const row of judged) assertClose(row.share, row.weight / total);
  assertClose(judged.reduce((/** @type {number} */ sum, /** @type {any} */ row) => sum + row.share, 0), 1);
  assert.match(step("fitness").text.join(" "), /seven/);
  assert.match(step("fitness").figure.alt, /share/);
});

test("with every weight at 1 the fitness step says each criterion counts the same share", () => {
  const equal = stepWith("fitness");
  const each = Math.round(100 / equal.figure.data.criteria.filter((/** @type {any} */ row) => row.score !== null).length);
  assert.match(equal.text.join(" "), new RegExp(`each criterion counts for ${each}%`));
  const uneven = stepWith("fitness", { ...defaults, weights: { ...defaults.weights, fidelity: 3 } });
  assert.match(uneven.text.join(" "), /Fidelity counts for \d+%/);
});

test("the loop step counts one generation from the settings: survivors, parents, crossovers and mutations", () => {
  const { data } = stepWith("loop").figure;

  assert.deepEqual(
    {
      populationSize: data.populationSize,
      eliteCount: data.eliteCount,
      children: data.children,
      pairs: data.pairs,
      parents: data.parents,
      genesPerPlan: data.genesPerPlan,
      mutationRate: data.mutationRate,
      maxGenerations: data.maxGenerations,
      stagnationWindow: data.stagnationWindow,
    },
    { populationSize: 60, eliteCount: 2, children: 58, pairs: 29, parents: 58, genesPerPlan: 128, mutationRate: 0.01, maxGenerations: 4000, stagnationWindow: 300 },
  );
  assertClose(data.mutationsPerChild, 1.28);
  assert.deepEqual(data.stages.map((/** @type {any} */ stage) => stage.id), ["score", "elitism", "selection", "crossover", "mutation", "replace"]);
});

test("an odd number of free places drops the second child of the last pair, as the GA does", () => {
  const { data } = stepWith("loop", { ...defaults, population_size: 61 }).figure;

  assert.equal(data.children, 59);
  assert.equal(data.pairs, 30);
  assert.equal(data.parents, 60, "30 pairs of parents are drawn");
});

test("without elitism the loop says that no plan survives unchanged", () => {
  const loop = stepWith("loop", { ...defaults, elite_count: 0 });

  assert.equal(loop.figure.data.children, 60);
  assert.match(loop.text.join(" "), /no plan is kept/i);
});

test("the selection step spins the wheel of the real generation 0: the same random plans and the same first two parents", () => {
  const { data } = stepWith("selection").figure;
  const tables = buildTables(korobeiniki);
  const allowed = allowedGenes(defaults.allowed);
  const rng = createRandom(defaults.seed);
  const population = randomPopulation(rng, defaults.population_size, 32, allowed);
  const values = fitness(tables, population, 32, defaults.weights);

  assert.deepEqual(data.slices.map((/** @type {any} */ slice) => slice.fitness), [...values]);
  assert.deepEqual(data.parents, [...rouletteSelect(rng, values, 2)], "the first two spins of generation 1");
  assert.deepEqual(data.elite, [...eliteIndices(values, defaults.elite_count)]);
  assert.equal(data.populationSize, 60);
});

test("the wheel's slices are the fitness above the generation's lowest, and the worst plan has none", () => {
  const { data } = stepWith("selection").figure;
  const fitnesses = data.slices.map((/** @type {any} */ slice) => slice.fitness);
  const lowest = Math.min(...fitnesses);
  const windowTotal = fitnesses.reduce((/** @type {number} */ sum, /** @type {number} */ value) => sum + value - lowest, 0);

  assertClose(data.lowest, lowest);
  assertClose(data.highest, Math.max(...fitnesses));
  data.slices.forEach((/** @type {any} */ slice) => assertClose(slice.share, (slice.fitness - lowest) / windowTotal));
  assertClose(data.slices.reduce((/** @type {number} */ sum, /** @type {any} */ slice) => sum + slice.share, 0), 1);
  assert.equal(data.worst.share, 0);
  assert.ok(data.best.share > data.best.plainShare, "windowing widens the best plan's slice");
  assert.ok(data.best.plainShare < 2 / data.populationSize, "a plain wheel would give a good plan hardly more than an average one");
  assert.ok(data.best.fitness >= data.median.fitness && data.median.fitness >= data.worst.fitness);
});

test("the selection step explains elitism and windowing in plain words, with the numbers", () => {
  const text = stepWith("selection").text.join(" ");

  assert.match(text, /2 best plans/);
  assert.match(text, /copied unchanged/);
  assert.match(text, /lowest fitness/);
  assert.match(text, /\d+(\.\d)?% on a plain wheel/);
});

test("when every plan has the same fitness the wheel gives each an equal slice, as roulette selection does", () => {
  const oneBar = { ...korobeiniki, bars: korobeiniki.bars.slice(0, 1) };
  const onlyFidelity = { ...defaults, weights: { complementarity: 0, register: 0, coherence: 0, contrast: 0, bass_smoothness: 0, idiom: 0, fidelity: 1 }, allowed: { ...defaults.allowed, p1_octave: [0] } };
  const { data } = howItWorksSteps({ leadSheet: oneBar, plan: null, settings: onlyFidelity }).find((candidate) => candidate.id === "selection")?.figure ?? { data: null };

  assert.equal(data.tied, true);
  data.slices.forEach((/** @type {any} */ slice) => assertClose(slice.share, 1 / data.populationSize));
});

test("the crossover and mutation step keeps the cut at a bar line and says that a mutation changes one gene of one bar", () => {
  const text = step("evolution").text.join(" ");

  assert.match(step("evolution").title, /Crossover and mutation/);
  assert.match(text, /bar line/);
  assert.match(text, /one bar/);
});

test("the closing paragraph counts seven rules, as the fitness does", () => {
  assert.match(HOW_IT_WORKS_CLOSING, /seven/);
  assert.equal(CRITERIA.length, 7);
});

// --- Skeleton and reveal -----------------------------------------------------------------------

test("the skeleton stands in for the steps while they are computed: busy, with a box per step and no text to read", () => {
  const container = new FakeDocument().createElement("div");

  renderHowSkeleton(/** @type {any} */ (container));

  assert.equal(container.getAttribute("aria-busy"), "true");
  const boxes = findAll(container, (element) => hasClass(element, "how-skeleton-step"));
  assert.equal(boxes.length, 6);
  assert.equal(container.textContent, "", "a placeholder says nothing: the live status does");
});

test("drawing the steps takes the busy mark away", () => {
  const container = new FakeDocument().createElement("div");
  renderHowSkeleton(/** @type {any} */ (container));

  renderHowItWorks(/** @type {any} */ (container), steps);

  assert.equal(container.getAttribute("aria-busy"), null);
  assert.equal(findAll(container, (element) => hasClass(element, "how-skeleton-step")).length, 0);
});

test("each step is revealed once, the first time it scrolls into view", () => {
  const container = new FakeDocument().createElement("div");
  renderHowItWorks(/** @type {any} */ (container), steps);
  /** @type {Array<(entries: Array<{target: any, isIntersecting: boolean}>) => void>} */
  const callbacks = [];
  /** @type {any[]} */
  const watched = [];
  /** @type {any[]} */
  const released = [];
  class FakeObserver {
    /** @param {(entries: Array<{target: any, isIntersecting: boolean}>) => void} callback */
    constructor(callback) {
      callbacks.push(callback);
    }
    /** @param {any} target */
    observe(target) {
      watched.push(target);
    }
    /** @param {any} target */
    unobserve(target) {
      released.push(target);
    }
  }

  revealOnScroll(/** @type {any} */ (container), /** @type {any} */ (FakeObserver));

  const items = findAll(container, (element) => hasClass(element, "how-step"));
  assert.deepEqual(watched, items);
  assert.ok(items.every((item) => hasClass(item, "reveal") && !hasClass(item, "in")));
  callbacks[0]([{ target: items[2], isIntersecting: true }, { target: items[3], isIntersecting: false }]);
  assert.ok(hasClass(items[2], "in"));
  assert.ok(!hasClass(items[3], "in"));
  assert.deepEqual(released, [items[2]], "a revealed step is not watched again");
});

test("without an observer nothing is hidden: the steps simply show", () => {
  const container = new FakeDocument().createElement("div");
  renderHowItWorks(/** @type {any} */ (container), steps);

  revealOnScroll(/** @type {any} */ (container), undefined);

  const items = findAll(container, (element) => hasClass(element, "how-step"));
  assert.ok(items.every((item) => !hasClass(item, "reveal")));
});

// --- Renderer ----------------------------------------------------------------------------------

/**
 * A minimal stand-in for the DOM: elements with attributes, children and text, enough for the
 * renderer, which builds its tree with createElement, createElementNS, setAttribute, append,
 * textContent and replaceChildren.
 */
class FakeElement {
  /** @param {FakeDocument} ownerDocument @param {string} tagName @param {string | null} namespaceURI */
  constructor(ownerDocument, tagName, namespaceURI) {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName;
    this.namespaceURI = namespaceURI;
    /** @type {Map<string, string>} */
    this.attributes = new Map();
    /** @type {Array<FakeElement | string>} */
    this.childNodes = [];
  }

  /** @param {string} name @param {unknown} value */
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  /** @param {string} name */
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  /** @param {string} name */
  removeAttribute(name) {
    this.attributes.delete(name);
  }

  /** @param {string} selector a class selector, ".how-step": all the renderer asks for */
  querySelectorAll(selector) {
    const name = selector.slice(1);
    /** @type {FakeElement[]} */
    const found = [];
    const visit = (/** @type {FakeElement} */ element) => {
      for (const child of element.children) {
        if ((child.getAttribute("class") ?? "").split(" ").includes(name)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  /** @param {...(FakeElement | string)} nodes */
  append(...nodes) {
    this.childNodes.push(...nodes);
  }

  /** @param {...(FakeElement | string)} nodes */
  replaceChildren(...nodes) {
    this.childNodes = [...nodes];
  }

  get children() {
    return /** @type {FakeElement[]} */ (this.childNodes.filter((node) => typeof node !== "string"));
  }

  /** @returns {string} */
  get textContent() {
    return this.childNodes.map((node) => (typeof node === "string" ? node : node.textContent)).join("");
  }

  set textContent(text) {
    this.childNodes = [String(text)];
  }
}

class FakeDocument {
  /** @param {string} tagName */
  createElement(tagName) {
    return new FakeElement(this, tagName, null);
  }

  /** @param {string} namespaceURI @param {string} tagName */
  createElementNS(namespaceURI, tagName) {
    return new FakeElement(this, tagName, namespaceURI);
  }
}

/**
 * Every element under `root` (depth first) that `matches` accepts.
 * @param {FakeElement} root
 * @param {(element: FakeElement) => boolean} matches
 * @returns {FakeElement[]}
 */
function findAll(root, matches) {
  return root.children.flatMap((child) => [...(matches(child) ? [child] : []), ...findAll(child, matches)]);
}

/** @param {FakeElement} element @param {string} name */
const hasClass = (element, name) => (element.getAttribute("class") ?? "").split(" ").includes(name);

test("the renderer draws one figure per step, each a labeled image with a caption", () => {
  const container = new FakeDocument().createElement("div");
  renderHowItWorks(/** @type {any} */ (container), steps);
  const figures = findAll(container, (element) => element.tagName === "figure");
  assert.equal(figures.length, steps.length);
  figures.forEach((figure, index) => {
    const images = findAll(figure, (element) => element.getAttribute("role") === "img");
    assert.equal(images.length, 1, `step ${index + 1} has one image`);
    assert.equal(images[0].tagName, "svg");
    assert.equal(images[0].namespaceURI, "http://www.w3.org/2000/svg");
    assert.equal(images[0].getAttribute("aria-label"), steps[index].figure.alt);
    assert.ok(images[0].children.length > 1, `step ${index + 1}'s image draws something`);
    const captions = findAll(figure, (element) => element.tagName === "figcaption");
    assert.equal(captions.length, 1);
    assert.equal(captions[0].textContent, steps[index].figure.caption);
  });
});

test("the renderer gives each step a numbered heading and its paragraphs", () => {
  const container = new FakeDocument().createElement("div");
  renderHowItWorks(/** @type {any} */ (container), steps);
  const items = findAll(container, (element) => hasClass(element, "how-step"));
  const headings = items.flatMap((item) => findAll(item, (element) => element.tagName === "h3"));
  assert.deepEqual(
    headings.map((heading) => heading.textContent),
    steps.map((candidate, index) => `${String(index + 1).padStart(2, "0")}${candidate.title}`),
  );
  assert.equal(items.length, steps.length);
  items.forEach((item, index) => {
    const paragraphs = findAll(item, (element) => element.tagName === "p").map((paragraph) => paragraph.textContent);
    assert.deepEqual(paragraphs, steps[index].text);
  });
});

test("the renderer ends with the links to the repository and the article, and replaces what it drew before", () => {
  const container = new FakeDocument().createElement("div");
  renderHowItWorks(/** @type {any} */ (container), steps);
  renderHowItWorks(/** @type {any} */ (container), steps);
  assert.equal(findAll(container, (element) => element.tagName === "figure").length, steps.length);
  const links = findAll(container, (element) => element.tagName === "a");
  assert.deepEqual(
    links.map((link) => link.getAttribute("href")),
    HOW_IT_WORKS_LINKS.map((link) => link.href),
  );
});

test("a lead sheet without a title is called the song", () => {
  const untitled = howItWorksSteps({ leadSheet: { ...korobeiniki, title: "" }, plan, settings: runSettings });
  assert.match(untitled[0].text[1], /^The song has 32 bars/);
  assert.match(untitled[0].figure.caption, /of the song\./);
});

test("the references name the articles the method is built on, each with the part it was used for", () => {
  assert.ok(HOW_IT_WORKS_REFERENCES.length >= 10);
  const keys = HOW_IT_WORKS_REFERENCES.map((reference) => reference.key);
  assert.equal(new Set(keys).size, keys.length, "no article twice");
  for (const key of ["donahue2018nes", "ozcan2008genetic", "biles1994genjam", "tuohy2006gabased", "phonamnuaisuk1999evolving"]) {
    assert.ok(keys.includes(key), key);
  }
  for (const reference of HOW_IT_WORKS_REFERENCES) {
    assert.match(reference.citation, /\((19|20)\d\d\)/, `${reference.key} has a year`);
    assert.ok(reference.used.length > 20, `${reference.key} says what it was used for`);
  }
});

test("the renderer lists the references, as plain text, after the closing links", () => {
  const container = new FakeDocument().createElement("div");
  renderHowItWorks(/** @type {any} */ (container), steps);
  const items = findAll(container, (element) => element.getAttribute("class") === "how-reference");
  assert.equal(items.length, HOW_IT_WORKS_REFERENCES.length);
  assert.ok(items[0].textContent.includes(HOW_IT_WORKS_REFERENCES[0].citation));
  assert.ok(items[0].textContent.includes(HOW_IT_WORKS_REFERENCES[0].used));
  const heading = findAll(container, (element) => element.tagName === "h3").map((element) => element.textContent);
  assert.ok(heading.includes("References"));
});
