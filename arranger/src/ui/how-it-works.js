// @ts-check
/**
 * How it works: the method in six steps, each with one small figure computed by the real core
 * modules (spec 005, User Story 7, FR-027).
 *
 * The reader knows some music but no genetic algorithm. The steps follow a song through the
 * method: the song becomes a lead sheet, the genetic algorithm (GA) describes an arrangement as a
 * genome of four genes per bar, a fitness function scores it, evolution breeds better genomes,
 * realizers turn the genes into notes, and the chip synthesizer turns the notes into sound.
 *
 * No figure is drawn by hand. Each one shows what the core computes for the loaded song (or for
 * Korobeiniki when none is loaded): the lead sheet's own bars, the plan's own genes, the scores
 * of core/fitness.js, two parents crossed and mutated by core/operators.js with the seeded
 * generator of core/random.js, the notes of core/arrangement.js and the waves of
 * audio/chip-synth.js. So the explanation cannot drift from the method.
 *
 * The module has two halves. `howItWorksSteps` builds plain data and is pure: the same lead
 * sheet, plan and settings give the same steps, which the tests check without a browser.
 * `renderHowItWorks` draws that data as inline SVG; every figure has a text alternative for
 * screen readers and a caption that says what to look at (constitution, principle V).
 */

import { DRUM_SOUNDS, PULSE_DUTY, SAMPLE_RATE, noiseWave, pulseWave, triangleWave } from "../audio/chip-synth.js";
import { assemble } from "../core/arrangement.js";
import { createGAParams, evolve } from "../core/evolution.js";
import { CRITERIA, criterionScores, fitness } from "../core/fitness.js";
import { ALL_ALLOWED, GENES_PER_BAR, allowedGenes, decode, randomPopulation } from "../core/genome.js";
import { barStarts, meterText } from "../core/meter.js";
import { mutate, onePointCrossover } from "../core/operators.js";
import { createRandom } from "../core/random.js";
import { buildTables } from "../core/tables.js";
import { CHANNELS, HIHAT, KICK, SNARE } from "../core/textures.js";
import { noteName } from "./gm-programs.js";
import { GENE_NAMES, cellStrength } from "./plan-grid.js";
import { describeScores } from "./scores-table.js";

/** Bars of the lead sheet that the first figure draws. @type {number} */
export const LEAD_SHEET_FIGURE_BARS = 4;

/** Bars of the plan that the genome figure shows. @type {number} */
export const GENOME_FIGURE_BARS = 8;

/** Bars of the two parents and the child in the evolution figure. @type {number} */
export const EVOLUTION_FIGURE_BARS = 6;

/** Bars of the realized arrangement in the realization figure. @type {number} */
export const REALIZATION_FIGURE_BARS = 2;

/** Samples of each wave in the sound figure: one cycle of each periodic wave. @type {number} */
export const WAVE_SAMPLES = 64;

const REPOSITORY_URL = "https://github.com/GiowGiow/nes-genetic-arranger";

/**
 * Where to read further: the repository, the README's credits for every song source and license,
 * and the article (the ISMIR-format abstract).
 * @type {ReadonlyArray<Readonly<{label: string, href: string, description: string}>>}
 */
export const HOW_IT_WORKS_LINKS = Object.freeze([
  Object.freeze({
    label: "Repository",
    href: REPOSITORY_URL,
    description: "the code, the tests and the command line",
  }),
  Object.freeze({
    label: "Sources and licenses",
    href: `${REPOSITORY_URL}#inputs-sources-and-licenses`,
    description: "where every song and library comes from, and under which license",
  }),
  Object.freeze({
    label: "Article (PDF)",
    href: `${REPOSITORY_URL}/blob/main/paper/tp1.pdf`,
    description: "the abstract that describes the method and evaluates it",
  }),
]);

/** The paragraph that closes the explanation, before the links. @type {string} */
export const HOW_IT_WORKS_CLOSING =
  "That is the whole method: a lead sheet, a genome of four genes per bar, a fitness made of seven " +
  "arranging rules, a genetic algorithm that breeds better plans, fixed realizers and a chip " +
  "synthesizer. The repository holds the code and its tests, and its README credits every song " +
  "source and license; the article explains the design and measures the results.";

/**
 * The articles the method is built on, with the part of the arranger each one informed. The keys
 * are the BibTeX keys of the article's bibliography (`paper/references.bib`).
 * @type {ReadonlyArray<Readonly<{key: string, citation: string, used: string}>>}
 */
export const HOW_IT_WORKS_REFERENCES = Object.freeze(
  [
    {
      key: "donahue2018nes",
      citation:
        "Donahue, C., Mao, H. H., McAuley, J. (2018). The NES Music Database: a multi-instrumental dataset with expressive performance attributes. Proc. ISMIR.",
      used: "The four voices of the chip and the pitch range each one can reach, which bound the genes.",
    },
    {
      key: "driscoll2009endless",
      citation: "Driscoll, K., Diaz, J. (2009). Endless loop: a brief history of chiptunes. Transformative Works and Cultures, 2.",
      used: "The chiptune idioms the fitness rewards: arpeggios over a single chord, noise percussion and fills.",
    },
    {
      key: "collins2007loop",
      citation: "Collins, K. (2007). In the loop: creativity and constraint in 8-bit video game audio. Twentieth-Century Music, 4, 209–227.",
      used: "Why the limits of the chip are treated as part of the style, not only as a restriction.",
    },
    {
      key: "tuohy2006gabased",
      citation: "Tuohy, D. R., Potter, W. D. (2006). GA-based music arranging for guitar. Proc. IEEE Congress on Evolutionary Computation, 1065–1070.",
      used: "Arranging as a search: a genetic algorithm looks for a playable arrangement of a given piece.",
    },
    {
      key: "carpentier2010solving",
      citation:
        "Carpentier, G., Assayag, G., Saint-James, E. (2010). Solving the musical orchestration problem using multiobjective constrained optimization with a genetic local search approach. Journal of Heuristics, 16, 681–714.",
      used: "Arranging under the limits of an ensemble, judged by several criteria at once.",
    },
    {
      key: "biles1994genjam",
      citation: "Biles, J. A. (1994). GenJam: a genetic algorithm for generating jazz solos. Proc. International Computer Music Conference, 131–137.",
      used: "A genome built from musical units (here one choice per bar) instead of single notes.",
    },
    {
      key: "freitas2011melody",
      citation: "Freitas, A. R. R., Guimarães, F. G. (2011). Melody harmonization in evolutionary music using multiobjective genetic algorithms. Proc. Sound and Music Computing Conference.",
      used: "Crossover that cuts only between bars, so no bar is broken in the middle.",
    },
    {
      key: "phonamnuaisuk1999evolving",
      citation: "Phon-Amnuaisuk, S., Tuson, A., Wiggins, G. (1999). Evolving musical harmonisation. Artificial Neural Nets and Genetic Algorithms, 229–234.",
      used: "The weights of the rules, more than the genetic operators, decide how good the result is; the harmony criteria.",
    },
    {
      key: "ozcan2008genetic",
      citation: "Özcan, E., Erçal, T. (2008). A genetic algorithm for generating improvised music. Artificial Evolution, LNCS 4926, 266–277.",
      used: "The fitness as a weighted sum of criteria scored from 0 to 1, and a mutation rate of about one gene per child.",
    },
    {
      key: "scirea2017affective",
      citation: "Scirea, M., Togelius, J., Eklund, P., Risi, S. (2017). Affective evolutionary music composition with MetaCompose. Genetic Programming and Evolvable Machines, 18, 433–465.",
      used: "The mutation rate close to 1 over the genome length.",
    },
    {
      key: "towsey2001towards",
      citation: "Towsey, M., Brown, A., Wright, S., Diederich, J. (2001). Towards melodic extension using genetic algorithms. Educational Technology & Society, 4, 54–65.",
      used: "The note density measured over a bar, one of the criteria of the fitness.",
    },
    {
      key: "donahue2019lakhnes",
      citation: "Donahue, C., Mao, H. H., Li, Y. E., Cottrell, G. W., McAuley, J. (2019). LakhNES: improving multi-instrumental music generation with cross-domain pre-training. Proc. ISMIR.",
      used: "The nearest earlier work: it maps the parts of any MIDI file onto the NES voices; this arranger searches each bar's texture with explicit musical criteria instead.",
    },
    {
      key: "kaliakatsos2012interactive",
      citation:
        "Kaliakatsos-Papakostas, M. A., Epitropakis, M. G., Floros, A., Vrahatis, M. N. (2012). Interactive evolution of 8-bit melodies with genetic programming towards finding aesthetic measures for sound. EvoMUSART, LNCS 7247, 141–152.",
      used: "Evolution has been used for 8-bit music before, for sound formulas judged by people; here the criteria are written down.",
    },
  ].map((reference) => Object.freeze(reference)),
);

// The gene rows in gene order (genome.js), with the plan grid's labels and channel colors.
const GENE_ROWS = /** @type {const} */ ([
  { key: "p2", label: "P2", channel: "p2" },
  { key: "tr", label: "TR", channel: "tr" },
  { key: "no", label: "NO", channel: "no" },
  { key: "oct", label: "P1 oct", channel: "p1" },
]);

/** @typedef {import("../core/leadsheet.js").LeadSheet} LeadSheet */
/** @typedef {import("../core/settings.js").Settings} Settings */

/**
 * One step of the explanation.
 * @typedef {object} HowStep
 * @property {"lead-sheet" | "genome" | "fitness" | "evolution" | "realization" | "sound"} id
 * @property {string} title
 * @property {string[]} text short paragraphs in plain words.
 * @property {{kind: string, data: any, alt: string, caption: string}} figure what to draw
 *   (`kind` picks the drawing), its text alternative and its caption.
 */

/**
 * Build the six steps for a song, a plan and the settings.
 *
 * The figures use the given plan, for example the best plan of the visitor's latest run of this
 * lead sheet. Without one, they use the plan a run with these settings and seed starts from, the
 * best of generation 0 (`initialBestPlan`), and the text says so: running the GA itself would
 * hold the page for up to a second.
 *
 * @param {object} input
 * @param {LeadSheet} input.leadSheet the song as a lead sheet (at least one bar).
 * @param {ArrayLike<number> | number[][] | null} [input.plan] its arrangement plan: nBars × 4
 *   genes, flat (as the GA stores it) or one array of 4 genes per bar (as the fixtures do).
 * @param {Settings} input.settings valid settings (`validateSettings` finds no problem): the
 *   seed, the GA hyperparameters, the weights and the allowed values.
 * @returns {HowStep[]} the steps lead-sheet, genome, fitness, evolution, realization, sound.
 * @throws {RangeError} when the plan does not hold 4 valid genes per bar of the lead sheet.
 * @example
 * howItWorksSteps({ leadSheet: korobeiniki, plan, settings }).map((step) => step.id);
 * // ["lead-sheet", "genome", "fitness", "evolution", "realization", "sound"]
 */
export function howItWorksSteps({ leadSheet, plan = null, settings }) {
  const nBars = leadSheet.bars.length;
  const tables = buildTables(leadSheet);
  const fromRun = plan !== null && plan !== undefined;
  const genes = fromRun ? planGenes(plan, nBars) : initialBestPlan(leadSheet, settings, tables);
  const song = leadSheet.title.trim() || "the song";
  const allowed = allowedOf(settings);
  return [
    leadSheetStep(leadSheet, song),
    genomeStep(leadSheet, genes, allowed, settings, fromRun, song),
    fitnessStep(tables, genes, settings.weights, fromRun, song),
    evolutionStep(nBars, allowed, settings),
    realizationStep(leadSheet, genes, song),
    soundStep(),
  ];
}

/**
 * The best plan of generation 0: the best of the random plans that a run with these settings and
 * seed starts from (the `initialBestPlan` of core/evolution.js).
 *
 * It stands in for the visitor's own run until there is one. It costs one generation, so it is
 * computed on the page's thread, and it is a fair "before" picture: the figures show what the
 * fitness of a random plan looks like, and a run then shows how far evolution lifts it.
 *
 * @param {LeadSheet} leadSheet the song.
 * @param {Settings} settings valid settings: seed, population size, weights and allowed values.
 * @param {import("../core/tables.js").ScoreTables} [tables] the song's score tables, when the
 *   caller has them already.
 * @returns {Uint8Array} the plan, nBars × 4 genes.
 * @example
 * initialBestPlan(korobeiniki, settings).length; // → 128 (32 bars × 4 genes)
 */
export function initialBestPlan(leadSheet, settings, tables = buildTables(leadSheet)) {
  const params = createGAParams({
    populationSize: settings.population_size,
    maxGenerations: 0, // generation 0 only: the random population, scored
    stagnationWindow: settings.stagnation_window,
    mutationRate: settings.mutation_rate,
    eliteCount: settings.elite_count,
    allowed: allowedOf(settings),
  });
  /** @type {import("../core/evolution.js").EvolutionResult} */
  const result = /** @type {any} */ ({});
  const run = evolve(createRandom(settings.seed), tables, tables.nBars, params, settings.weights, result);
  for (let step = run.next(); !step.done; step = run.next());
  return result.initialBestPlan;
}

/**
 * The gene values the settings allow; every value for a record written before `allowed` existed.
 * @param {Settings} settings
 * @returns {number[][]}
 */
function allowedOf(settings) {
  return settings.allowed ? allowedGenes(settings.allowed) : ALL_ALLOWED.map((values) => [...values]);
}

/**
 * A plan as flat genes, checked against the lead sheet.
 * @param {ArrayLike<number> | number[][]} plan
 * @param {number} nBars
 * @returns {Uint8Array}
 */
function planGenes(plan, nBars) {
  const flat = Array.isArray(plan) && Array.isArray(plan[0]) ? /** @type {number[][]} */ (plan).flat() : Array.from(/** @type {ArrayLike<number>} */ (plan));
  if (flat.length !== nBars * GENES_PER_BAR) {
    throw new RangeError(`the plan has ${flat.length} genes, but ${nBars} bars need ${nBars * GENES_PER_BAR}`);
  }
  decode(flat); // throws a RangeError naming a gene outside its values
  return Uint8Array.from(flat);
}

// --- Step 1: the lead sheet ---------------------------------------------------------------------

/**
 * @param {LeadSheet} leadSheet
 * @param {string} song
 * @returns {HowStep}
 */
function leadSheetStep(leadSheet, song) {
  const shown = leadSheet.bars.slice(0, LEAD_SHEET_FIGURE_BARS);
  const starts = barStarts(shown);
  const bars = shown.map((bar, position) => ({
    number: position + 1,
    start: starts[position],
    beats: bar.meter.barBeats,
    meter: meterText(bar.meter),
    label: bar.label,
    role: bar.role,
    phrase: bar.phrase,
    phraseEnd: bar.phraseEnd,
    melody: bar.melody.map(({ pitch, onset, duration }) => ({ pitch, onset, duration })),
    chords: bar.chords.map(({ symbol, onset, duration }) => ({ symbol, onset, duration })),
  }));
  const pitches = bars.flatMap((bar) => bar.melody.map((note) => note.pitch));
  const pitchRange = pitches.length > 0 ? [Math.min(...pitches), Math.max(...pitches)] : [60, 72];
  const parts = partRuns(leadSheet.bars);
  const phraseCount = new Set(leadSheet.bars.map((bar) => bar.phrase)).size;
  const nBars = leadSheet.bars.length;
  const chordNames = withoutRepeats(bars.flatMap((bar) => bar.chords.map((chord) => chord.symbol)));
  const range = barRange(1, bars.length);
  return {
    id: "lead-sheet",
    title: "From song to lead sheet",
    text: [
      "The arranger starts from a lead sheet: the melody, the chord in effect at every moment, " +
        "and the parts of the song, such as a verse and a chorus.",
      `${song[0].toUpperCase()}${song.slice(1)} has ${count(nBars, "bar")} in ${count(phraseCount, "phrase")}: ` +
        `${partsSentence(parts)}.`,
      "A MIDI song is first reduced to the same shape: one track gives the melody, and the chords " +
        "are detected from the other tracks.",
    ],
    figure: {
      kind: "lead-sheet",
      data: { title: song, bars, pitchRange, parts, totalBars: nBars, phraseCount },
      alt:
        `Piano roll of ${range.toLowerCase()} of ${song}: the melody moves between ` +
        `${noteName(pitchRange[0])} and ${noteName(pitchRange[1])} over the chords ${chordNames.join(", ")}.`,
      caption: `${range} of ${song}. Each melody note is a block at its pitch and length, under the chord in effect.`,
    },
  };
}

/**
 * The parts of the form: runs of consecutive bars with the same label.
 * @param {LeadSheet["bars"]} bars
 * @returns {Array<{label: string, role: string, firstBar: number, lastBar: number}>} bars from 1.
 */
function partRuns(bars) {
  /** @type {Array<{label: string, role: string, firstBar: number, lastBar: number}>} */
  const parts = [];
  bars.forEach((bar, position) => {
    const last = parts[parts.length - 1];
    if (last !== undefined && last.label === bar.label) last.lastBar = position + 1;
    else parts.push({ label: bar.label, role: bar.role, firstBar: position + 1, lastBar: position + 1 });
  });
  return parts;
}

/**
 * "part A (verse) is bars 1–16, part B (chorus) bars 17–24 and part A bars 25–32".
 * @param {ReturnType<typeof partRuns>} parts
 */
function partsSentence(parts) {
  if (parts.length === 1) return `all in part ${parts[0].label} (${parts[0].role})`;
  const named = new Set();
  const phrases = parts.slice(0, 4).map((part, index) => {
    // A part's role is said once, the first time the part comes.
    const role = named.has(part.label) ? "" : ` (${part.role})`;
    named.add(part.label);
    const bars = barRange(part.firstBar, part.lastBar).toLowerCase();
    return index === 0 ? `part ${part.label}${role} is ${bars}` : `part ${part.label}${role} ${bars}`;
  });
  if (parts.length > 4) return `${phrases.join(", ")} and ${count(parts.length - 4, "more part")}`;
  return `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;
}

// --- Step 2: the genome -------------------------------------------------------------------------

/**
 * @param {LeadSheet} leadSheet
 * @param {Uint8Array} genes
 * @param {number[][]} allowed
 * @param {Settings} settings
 * @param {boolean} fromRun
 * @param {string} song
 * @returns {HowStep}
 */
function genomeStep(leadSheet, genes, allowed, settings, fromRun, song) {
  const nBars = leadSheet.bars.length;
  const shown = Math.min(GENOME_FIGURE_BARS, nBars);
  const bars = Array.from({ length: shown }, (_, bar) => {
    const barGenes = [...genes.subarray(bar * GENES_PER_BAR, (bar + 1) * GENES_PER_BAR)];
    return {
      number: bar + 1,
      genes: barGenes,
      names: barGenes.map((value, gene) => GENE_NAMES[GENE_ROWS[gene].key][value]),
      phraseEnd: leadSheet.bars[bar].phraseEnd,
    };
  });
  const rows = GENE_ROWS.map((row, gene) => ({ ...row, values: [...GENE_NAMES[row.key]], allowed: [...allowed[gene]] }));
  const choicesPerBar = allowed.reduce((product, values) => product * values.length, 1);
  const planDigits = Math.floor(nBars * Math.log10(choicesPerBar)) + 1;
  const plans = planDigits <= 15 ? count(choicesPerBar ** nBars, "plan") : `a number of plans with ${planDigits} digits`;
  const source = fromRun
    ? "The strip shows the first bars of the best plan of your latest run."
    : `No run yet, so the strip shows the best of the ${settings.population_size} random plans that a run ` +
      `with seed ${settings.seed} starts from. After Arrange, it shows the run's best plan.`;
  const rowNames = (/** @type {number} */ gene) =>
    describeRuns(bars.map((bar) => bar.names[gene]));
  return {
    id: "genome",
    title: "The genome: four genes per bar",
    text: [
      "The genetic algorithm never writes notes. For every bar it picks four whole numbers, called " +
        "genes: a harmony texture for the second pulse channel (P2), a bass texture for the triangle " +
        "(TR), a drum pattern for the noise channel (NO) and an octave for the melody on the first " +
        "pulse channel (P1).",
      `A plan for the ${count(nBars, "bar")} of ${song} is ${GENES_PER_BAR * nBars} genes. The settings allow ` +
        `${choicesPerBar} choices per bar, so there are ${plans}: far too many to try one by one.`,
      source,
    ],
    figure: {
      kind: "genome",
      data: { bars, rows, totalBars: nBars, totalGenes: GENES_PER_BAR * nBars, choicesPerBar, planDigits, source: fromRun ? "run" : "generation-0" },
      alt:
        `Genes of ${barRange(1, shown).toLowerCase()}, one column per bar and one row per gene. ` +
        `P2: ${rowNames(0)}. TR: ${rowNames(1)}. NO: ${rowNames(2)}. P1 octave: ${rowNames(3)}.`,
      caption:
        `${barRange(1, shown)} of the plan: each column is a bar, each row a gene, and each number is ` +
        "the gene's value, named in the legend.",
    },
  };
}

// --- Step 3: the fitness ------------------------------------------------------------------------

/**
 * @param {import("../core/tables.js").ScoreTables} tables
 * @param {Uint8Array} genes
 * @param {Record<string, number>} weights
 * @param {boolean} fromRun
 * @param {string} song
 * @returns {HowStep}
 */
function fitnessStep(tables, genes, weights, fromRun, song) {
  const scores = criterionScores(tables, genes, tables.nBars);
  const fitnessValue = fitness(tables, genes, tables.nBars, weights)[0];
  /** @type {Record<string, number | null>} */
  const scoreOf = Object.fromEntries(
    CRITERIA.map((name) => [name, Number.isNaN(scores[name][0]) ? null : scores[name][0]]),
  );
  const labels = describeScores(scoreOf, fitnessValue, weights).rows.map((row) => row.label);
  const criteria = CRITERIA.map((name, index) => ({
    name,
    label: labels[index],
    weight: Object.hasOwn(weights, name) ? weights[name] : 0,
    score: scoreOf[name],
  }));
  const judged = criteria.filter((row) => row.score !== null && row.weight > 0);
  const weakest = judged.reduce((low, row) => (/** @type {number} */ (row.score) < /** @type {number} */ (low.score) ? row : low), judged[0]);
  const lift = fromRun ? "" : " Evolution's job is to raise it.";
  const missing = criteria.filter((row) => row.score === null).map((row) => row.label.toLowerCase());
  const leftOut =
    missing.length > 0
      ? `On ${song}, ${missing.join(" and ")} cannot be judged, so the mean leaves ${missing.length === 1 ? "it" : "them"} out.`
      : "A criterion that cannot be judged on a song, such as contrast in a song without a chorus, is left out of the mean.";
  return {
    id: "fitness",
    title: "Fitness: a score for every plan",
    text: [
      "A fitness function gives every plan a score from 0 to 1: the weighted mean of seven criteria. " +
        "Each criterion is a rule of thumb of arranging, for example: the bass moves by small leaps, " +
        "the chorus is busier than the verse, and the harmony calms down when the melody is busy.",
      `${leftOut} The weights, in the settings, say how much each criterion counts.`,
      (weakest === undefined
        ? `This plan scores ${fitnessValue.toFixed(2)}.`
        : `This plan scores ${fitnessValue.toFixed(2)}; its weakest criterion is ${weakest.label.toLowerCase()} ` +
          `(${/** @type {number} */ (weakest.score).toFixed(2)}).`) + lift,
    ],
    figure: {
      kind: "fitness",
      data: { criteria, fitness: fitnessValue },
      alt:
        "Horizontal bars of the seven criterion scores of this plan: " +
        criteria
          .map((row) => (row.score === null ? `${row.label} does not apply` : `${row.label} ${row.score.toFixed(2)} (weight ${row.weight})`))
          .join(", ") +
        `; fitness ${fitnessValue.toFixed(2)}.`,
      caption: "Each bar is one criterion's score, from 0 to 1, with its weight; the fitness is their weighted mean.",
    },
  };
}

// --- Step 4: evolution --------------------------------------------------------------------------

/**
 * Two random parents, one-point crossover and one mutation, with the run's seeded generator.
 *
 * Draws, in this order: the two parents (`randomPopulation`), the cut (`onePointCrossover`), the
 * bar and the gene to mutate (`rng.integer` each), then `mutate` on that bar at rate 1 with every
 * other gene held to its value. A real run mutates each gene with probability `mutation_rate`, so
 * a child of a few bars rarely shows a mutation; the figure forces one to show what it does.
 *
 * @param {number} nBars
 * @param {number[][]} allowed
 * @param {Settings} settings
 * @returns {HowStep}
 */
function evolutionStep(nBars, allowed, settings) {
  const rng = createRandom(settings.seed);
  const figureBars = Math.min(EVOLUTION_FIGURE_BARS, nBars);
  const length = figureBars * GENES_PER_BAR;
  const parents = randomPopulation(rng, 2, figureBars, allowed);
  const parentA = parents.subarray(0, length);
  const parentB = parents.subarray(length);
  const child = new Uint8Array(length);
  const cut = onePointCrossover(rng, parentA, parentB, child, new Uint8Array(length));
  const crossedChild = [...child];

  /** @type {null | {bar: number, gene: number, row: string, from: number, to: number, fromName: string, toName: string}} */
  let mutation = null;
  const movable = GENE_ROWS.map((_, gene) => gene).filter((gene) => allowed[gene].length >= 2);
  if (movable.length > 0) {
    const bar = rng.integer(0, figureBars);
    const gene = movable[rng.integer(0, movable.length)];
    const barGenes = child.subarray(bar * GENES_PER_BAR, (bar + 1) * GENES_PER_BAR);
    // One allowed value leaves a gene nowhere to go (operators.js), so only `gene` can change.
    const onlyThisGene = allowed.map((values, column) => (column === gene ? values : [barGenes[column]]));
    mutate(rng, barGenes, 1, onlyThisGene);
    const key = GENE_ROWS[gene].key;
    const from = crossedChild[bar * GENES_PER_BAR + gene];
    const to = barGenes[gene];
    mutation = { bar: bar + 1, gene, row: GENE_ROWS[gene].label, from, to, fromName: GENE_NAMES[key][from], toName: GENE_NAMES[key][to] };
  }

  const elite = settings.elite_count;
  const keeps =
    elite > 0
      ? `keeps the ${elite === 1 ? "best plan" : `${elite} best plans`} unchanged and fills the other places with children`
      : "is made of children only";
  const rate = `${Number((settings.mutation_rate * 100).toFixed(2))}%`;
  const crossing =
    cut < figureBars
      ? `cut after bar ${cut}: the child takes ${barRange(1, cut).toLowerCase()} from parent A and ` +
        `${barRange(cut + 1, figureBars).toLowerCase()} from parent B`
      : "not cut, since a one-bar plan has no bar line inside: the child copies parent A";
  const mutated =
    mutation === null ? "" : `; then its ${mutation.row} gene in bar ${mutation.bar} mutates from ${mutation.fromName} to ${mutation.toName}`;
  return {
    id: "evolution",
    title: "Evolution: selection, crossover and mutation",
    text: [
      `The search starts from ${settings.population_size} random plans, the first generation. Each new ` +
        `generation ${keeps}.`,
      "For each child, roulette selection picks two parents, and a better plan has a better chance. " +
        "One-point crossover cuts both parents at the same bar line and joins the head of one to the " +
        `tail of the other. Then mutation gives each gene, with a small probability (${rate}), another allowed value.`,
      `Generation after generation the best fitness climbs. The run stops after ${settings.max_generations} ` +
        `generations, or sooner when the best plan has not improved for ${settings.stagnation_window} generations.`,
    ],
    figure: {
      kind: "evolution",
      data: {
        seed: settings.seed,
        figureBars,
        parentA: [...parentA],
        parentB: [...parentB],
        cut,
        crossedChild,
        child: [...child],
        mutation,
      },
      alt: `Two random parent plans of ${count(figureBars, "bar")}, ${crossing}${mutated}.`,
      caption:
        `Seed ${settings.seed}: two random parents, cut at a bar line (dashed); the child joins A's head to ` +
        "B's tail, and one gene mutates (outlined).",
    },
  };
}

// --- Step 5: realization ------------------------------------------------------------------------

/**
 * @param {LeadSheet} leadSheet
 * @param {Uint8Array} genes
 * @param {string} song
 * @returns {HowStep}
 */
function realizationStep(leadSheet, genes, song) {
  const arrangement = assemble(leadSheet, genes);
  const starts = barStarts(leadSheet.bars);
  const nBars = leadSheet.bars.length;
  const windowBars = Math.min(REALIZATION_FIGURE_BARS, nBars);
  // The first bars in which all four channels sound in every bar show every realizer at work
  // (many plans leave the drums out of the opening phrase).
  /** @param {number} bar */
  const fullBar = (bar) => {
    const start = starts[bar];
    const end = start + leadSheet.bars[bar].meter.barBeats;
    return CHANNELS.every((channel) => arrangement.channels[channel].some((note) => note.onset >= start && note.onset < end));
  };
  let first = 0;
  for (let candidate = 0; candidate + windowBars <= nBars; candidate++) {
    if (Array.from({ length: windowBars }, (_, offset) => fullBar(candidate + offset)).every(Boolean)) {
      first = candidate;
      break;
    }
  }
  const last = first + windowBars - 1;
  const start = starts[first];
  const end = starts[last] + leadSheet.bars[last].meter.barBeats;
  /** @type {Record<string, Array<{pitch: number, onset: number, duration: number}>>} onsets from the window start */
  const channels = Object.fromEntries(
    CHANNELS.map((channel) => [
      channel,
      arrangement.channels[channel]
        .filter((note) => note.onset >= start && note.onset < end)
        .map((note) => ({ pitch: note.pitch, onset: note.onset - start, duration: note.duration })),
    ]),
  );
  const bars = Array.from({ length: windowBars }, (_, offset) => {
    const bar = first + offset;
    const barGenes = [...genes.subarray(bar * GENES_PER_BAR, (bar + 1) * GENES_PER_BAR)];
    return {
      number: bar + 1,
      start: starts[bar] - start,
      beats: leadSheet.bars[bar].meter.barBeats,
      genes: barGenes,
      names: barGenes.map((value, gene) => GENE_NAMES[GENE_ROWS[gene].key][value]),
    };
  });
  // Each pitched channel gets a lane of its own range: the bass sits two or three octaves below
  // the melody, and one shared axis would flatten every line.
  const pitchRanges = Object.fromEntries(
    ["P1", "P2", "TR"].map((channel) => {
      const pitches = channels[channel].map((note) => note.pitch);
      return [channel, pitches.length > 0 ? [Math.min(...pitches), Math.max(...pitches)] : [60, 60]];
    }),
  );
  const choices = (/** @type {number} */ gene) => withoutRepeats(bars.map((bar) => bar.names[gene])).join(" then ");
  const octave = choices(3);
  const range = barRange(first + 1, first + windowBars);
  return {
    id: "realization",
    title: "Realization: from genes to notes",
    text: [
      "Fixed rules, the realizers, turn each gene into the notes of its channel, reading the bar's " +
        "melody and chords. The same bar and gene always give the same notes.",
      "P1 plays the melody, P2 the harmony texture, TR the bass line and NO the drums. Each channel " +
        "plays one note at a time, as on the NES chip, so a chord becomes a fast arpeggio.",
      "Before export the arrangement is checked: one note at a time per channel, pitches inside each " +
        "channel's range, chord tones on strong beats and complete bars.",
    ],
    figure: {
      kind: "realization",
      data: { firstBar: first + 1, bars, channels, pitchRanges, totalBeats: end - start },
      alt:
        `Piano roll of the four channels in ${range.toLowerCase()} of ${song}, one lane per channel: P1 (blue) ` +
        `plays the melody${octave === "0" ? "" : ` shifted ${octave}`}, P2 (orange) ${choices(0)}, TR (gray) ` +
        `${choices(1)}, and NO plays ${choices(2)} drums in three lanes, hi-hat, snare and kick.`,
      caption:
        `${range} of ${song}, where all four channels play: one lane per channel, each note a block at its ` +
        "pitch and length.",
    },
  };
}

// --- Step 6: sound ------------------------------------------------------------------------------

/** @returns {HowStep} */
function soundStep() {
  const frequency = SAMPLE_RATE / WAVE_SAMPLES; // one cycle in WAVE_SAMPLES samples
  const pulseChannels = /** @type {Array<[number, string | null]>} */ ([
    [PULSE_DUTY.P2, "P2"],
    [PULSE_DUTY.P1, "P1"],
    [0.5, null],
  ]).sort((a, b) => a[0] - b[0]);
  // The hi-hat's bright, short-mode setting: the register starts at 1, and the darker kick and
  // snare settings would stay flat for most of the row.
  const hiHat = DRUM_SOUNDS[HIHAT];
  const waves = [
    ...pulseChannels.map(([duty, channel]) => ({
      id: `pulse-${duty * 100}`,
      label: `Pulse ${duty * 100}%`,
      channel,
      duty,
      values: [...pulseWave(frequency, WAVE_SAMPLES, duty)],
    })),
    { id: "triangle", label: "Triangle", channel: "TR", values: [...triangleWave(frequency, WAVE_SAMPLES)] },
    {
      id: "noise",
      label: "Noise",
      channel: "NO",
      period: hiHat.period,
      shortMode: hiHat.shortMode,
      values: [...noiseWave(WAVE_SAMPLES, hiHat.period, hiHat.shortMode)],
    },
  ];
  const percent = (/** @type {number} */ duty) => `${duty * 100}%`;
  return {
    id: "sound",
    title: "Sound: the chip's waves",
    text: [
      "Each channel of the chip has its own wave. The pulse channels play a square wave that stays high " +
        `for only part of each cycle, the duty cycle: P1 uses ${percent(PULSE_DUTY.P1)} and P2 ` +
        `${percent(PULSE_DUTY.P2)}, which sounds thinner, so the two stay apart.`,
      "The triangle (TR) climbs and falls in 16 steps, which gives the bass a slight buzz. The noise " +
        "channel (NO) plays pseudo-random bits from a shift register, darker or brighter for the kick, " +
        "the snare and the hi-hat.",
      "The page computes these waves sample by sample from the arrangement's notes, so what you hear " +
        "is the plan played on a model of the chip. The figure shows the raw chip; the sound menu's " +
        "NES chip gives P2 a rounder 50% pulse and filters the sound like a small TV speaker.",
      "The same plan can be voiced by other machines: the Mega Drive uses FM synthesis (sine " +
        "operators that bend each other's phase) for a brass lead, an electric piano and a slap bass; " +
        "the Super Nintendo plays short synthesized samples through its soft Gaussian filter and its " +
        "echo; the Game Boy, the Commodore 64, a soft synth and the original's plain instruments " +
        "complete the menu. Only the sound changes, never the notes.",
    ],
    figure: {
      kind: "sound",
      data: { sampleRate: SAMPLE_RATE, samples: WAVE_SAMPLES, waves },
      alt:
        `Five waveforms, one per row: pulse waves with duty cycles ${percent(pulseChannels[0][0])}, ` +
        `${percent(pulseChannels[1][0])} and ${percent(pulseChannels[2][0])}, one cycle each; the triangle's ` +
        `16-level staircase; and ${WAVE_SAMPLES} samples of noise with the hi-hat's setting.`,
      caption:
        "One cycle of each wave, as the chip synthesizer computes it. Noise has no cycle, so its row shows " +
        `${WAVE_SAMPLES} samples of the hi-hat's setting.`,
    },
  };
}

// --- Words --------------------------------------------------------------------------------------

/**
 * "1 bar", "32 bars".
 * @param {number} n
 * @param {string} noun
 */
function count(n, noun) {
  return `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * "Bar 5", "Bars 1–4".
 * @param {number} first
 * @param {number} last
 */
function barRange(first, last) {
  return first === last ? `Bar ${first}` : `Bars ${first}–${last}`;
}

/**
 * The values with consecutive repeats dropped: [E, E, Am] gives [E, Am].
 * @param {string[]} values
 */
function withoutRepeats(values) {
  return values.filter((value, index) => index === 0 || value !== values[index - 1]);
}

/**
 * Runs of equal values, one per bar from bar 1: "arp32 in bars 1–4, arp16 in bars 5–8".
 * @param {string[]} values
 */
function describeRuns(values) {
  /** @type {string[]} */
  const runs = [];
  let first = 0;
  values.forEach((value, index) => {
    if (index + 1 === values.length || values[index + 1] !== value) {
      runs.push(`${value} in ${barRange(first + 1, index + 1).toLowerCase()}`);
      first = index + 1;
    }
  });
  return runs.join(", ");
}

// --- Drawing ------------------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

// Every figure is drawn in a box this many units wide; the page scales it to the card.
const WIDTH = 300;

/**
 * Draw the steps inside `container`, replacing what was there: one list item per step, with its
 * heading, its paragraphs and its figure, then the closing paragraph and links.
 *
 * Each figure is an inline SVG image with `role="img"` and the step's text alternative as its
 * `aria-label`, followed by a legend where it needs one and a caption.
 *
 * @param {HTMLElement} container the element that holds the explanation (empty or drawn before).
 * @param {HowStep[]} steps from `howItWorksSteps`.
 * @returns {void}
 * @example
 * renderHowItWorks(document.querySelector("[data-how]"), howItWorksSteps({ leadSheet, settings }));
 */
export function renderHowItWorks(container, steps) {
  const doc = container.ownerDocument;
  const list = html(doc, "ol", { class: "how-steps" });
  steps.forEach((step, index) => list.append(stepItem(doc, step, index + 1)));
  const closing = html(doc, "div", { class: "how-closing" });
  closing.append(html(doc, "p", {}, HOW_IT_WORKS_CLOSING));
  const links = html(doc, "ul", { class: "how-links" });
  for (const link of HOW_IT_WORKS_LINKS) {
    const item = html(doc, "li");
    item.append(html(doc, "a", { href: link.href }, link.label), html(doc, "span", { class: "hint" }, link.description));
    links.append(item);
  }
  closing.append(links);
  const references = html(doc, "section", { class: "how-references" });
  references.append(
    html(doc, "h3", {}, "References"),
    html(doc, "p", { class: "hint" }, "The articles the method is built on, and what each one was used for."),
  );
  const cited = html(doc, "ol", { class: "how-refs" });
  for (const reference of HOW_IT_WORKS_REFERENCES) {
    const item = html(doc, "li", { class: "how-reference" });
    item.append(html(doc, "span", { class: "how-citation" }, reference.citation), html(doc, "span", { class: "hint how-used" }, reference.used));
    cited.append(item);
  }
  references.append(cited);
  container.replaceChildren(list, closing, references);
}

/**
 * @param {Document} doc
 * @param {HowStep} step
 * @param {number} number
 */
function stepItem(doc, step, number) {
  const headingId = `how-step-${step.id}-title`;
  const item = html(doc, "li", { class: "how-step", id: `how-step-${step.id}`, "aria-labelledby": headingId });
  const heading = html(doc, "h3", { id: headingId });
  // The list already numbers the steps for screen readers, so the visible number is decoration.
  heading.append(html(doc, "span", { class: "how-number", "aria-hidden": "true" }, String(number)), step.title);
  item.append(heading);
  for (const paragraph of step.text) item.append(html(doc, "p", {}, paragraph));

  const figure = html(doc, "figure", { class: `how-figure how-${step.figure.kind}` });
  const { image, legend } = DRAWINGS[step.figure.kind](doc, step.figure.data);
  image.setAttribute("role", "img");
  image.setAttribute("aria-label", step.figure.alt);
  figure.append(image);
  if (legend) figure.append(legend);
  figure.append(html(doc, "figcaption", {}, step.figure.caption));
  item.append(figure);
  return item;
}

/**
 * @typedef {(doc: Document, data: any) => {image: SVGSVGElement, legend?: HTMLElement}} Drawing
 */

/** @type {Record<string, Drawing>} */
const DRAWINGS = {
  "lead-sheet": drawLeadSheet,
  genome: drawGenome,
  fitness: drawFitness,
  evolution: drawEvolution,
  realization: drawRealization,
  sound: drawSound,
};

/**
 * An HTML element with attributes and, optionally, text.
 * @param {Document} doc
 * @param {string} tag
 * @param {Record<string, string | number>} [attributes]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function html(doc, tag, attributes = {}, text) {
  const node = doc.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * An SVG element with attributes and, optionally, text. Numbers are rounded to 0.01 units.
 * @param {Document} doc
 * @param {string} tag
 * @param {Record<string, string | number>} [attributes]
 * @param {string} [text]
 * @returns {any}
 */
function svg(doc, tag, attributes = {}, text) {
  const node = doc.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, typeof value === "number" ? String(Math.round(value * 100) / 100) : value);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The figure's SVG box: `height` units tall, scaled to the card's width.
 * @param {Document} doc
 * @param {number} height
 * @returns {SVGSVGElement}
 */
function svgImage(doc, height) {
  return svg(doc, "svg", { class: "how-svg", viewBox: `0 0 ${WIDTH} ${height}`, preserveAspectRatio: "xMidYMid meet" });
}

/**
 * Vertical pitch scale of a piano roll: the pitches low…high fill [top, bottom], highest on top.
 * @param {[number, number]} pitchRange
 * @param {number} top
 * @param {number} bottom
 */
function pitchScale([low, high], top, bottom) {
  const lowest = low - 1;
  const highest = high + 1;
  const row = (bottom - top) / (highest - lowest + 1);
  return { row, y: (/** @type {number} */ pitch) => top + (highest - pitch) * row };
}

/**
 * Beat and bar lines of a piano roll, and the beat → x scale.
 * @param {Document} doc
 * @param {any} image
 * @param {Array<{start: number, beats: number}>} bars
 * @param {number} left
 * @param {number} right
 * @param {number} top
 * @param {number} bottom
 */
function beatGrid(doc, image, bars, left, right, top, bottom) {
  const last = bars[bars.length - 1];
  const totalBeats = last.start + last.beats;
  const x = (/** @type {number} */ beat) => left + (beat * (right - left)) / totalBeats;
  image.append(svg(doc, "rect", { class: "how-roll", x: left, y: top, width: right - left, height: bottom - top, rx: 4 }));
  for (const bar of bars) {
    for (let beat = 1; beat < bar.beats; beat++) {
      image.append(svg(doc, "line", { class: "how-beatline", x1: x(bar.start + beat), x2: x(bar.start + beat), y1: top, y2: bottom }));
    }
    if (bar.start > 0) image.append(svg(doc, "line", { class: "how-barline", x1: x(bar.start), x2: x(bar.start), y1: top, y2: bottom }));
  }
  return x;
}

/** @type {Drawing} */
function drawLeadSheet(doc, data) {
  const image = svgImage(doc, 148);
  const left = 28;
  const right = WIDTH - 4;
  const top = 38;
  const bottom = 112;
  const x = beatGrid(doc, image, data.bars, left, right, top, bottom);
  const { row, y } = pitchScale(data.pitchRange, top, bottom);
  data.bars.forEach((/** @type {any} */ bar, /** @type {number} */ index) => {
    const previous = data.bars[index - 1];
    if (previous === undefined || previous.label !== bar.label) {
      image.append(svg(doc, "text", { class: "how-part", x: x(bar.start) + 2, y: 11 }, `Part ${bar.label} (${bar.role})`));
    }
    for (const chord of bar.chords) {
      image.append(svg(doc, "text", { class: "how-chord", x: x(bar.start + chord.onset) + 2, y: 30 }, chord.symbol));
    }
    for (const note of bar.melody) {
      image.append(
        svg(doc, "rect", {
          class: "how-note c-p1",
          x: x(bar.start + note.onset) + 0.5,
          y: y(note.pitch) - row / 2,
          width: Math.max(1.5, x(note.duration) - left - 1.5),
          height: Math.max(2.5, row - 0.5),
          rx: 1.5,
        }),
      );
    }
    image.append(svg(doc, "text", { class: "how-axis", x: x(bar.start) + 2, y: 124 }, `bar ${bar.number}`));
  });
  for (const pitch of data.pitchRange) {
    image.append(svg(doc, "text", { class: "how-axis how-end", x: left - 4, y: y(pitch) + 3 }, noteName(pitch)));
  }
  // Phrase brackets under the bars: the unit the coherence criterion and the drum fills follow.
  let first = 0;
  data.bars.forEach((/** @type {any} */ bar, /** @type {number} */ index) => {
    const next = data.bars[index + 1];
    if (next !== undefined && next.phrase === bar.phrase) return;
    const from = x(data.bars[first].start) + 2;
    const to = x(bar.start + bar.beats) - 2;
    image.append(svg(doc, "path", { class: "how-bracket", d: `M${r(from)} 130 V134 H${r(to)}${bar.phraseEnd ? " V130" : ""}` }));
    image.append(
      svg(doc, "text", { class: "how-axis how-middle", x: (from + to) / 2, y: 145 }, `phrase ${bar.phrase + 1}${bar.phraseEnd ? " ends" : ""}`),
    );
    first = index + 1;
  });
  return { image };
}

/**
 * Round a coordinate written inside a path.
 * @param {number} value
 */
function r(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Cells of a plan: one column per bar, one row per gene, the value written in the cell.
 * @param {Document} doc
 * @param {any} image
 * @param {number[]} genes nBars × 4 genes.
 * @param {{left: number, top: number, cellWidth: number, cellHeight: number, gap: number}} layout
 * @param {(bar: number, gene: number) => string} [extraClass] another class for a cell.
 */
function geneCells(doc, image, genes, layout, extraClass = () => "") {
  const { left, top, cellWidth, cellHeight, gap } = layout;
  for (let index = 0; index < genes.length; index++) {
    const bar = Math.floor(index / GENES_PER_BAR);
    const gene = index % GENES_PER_BAR;
    const row = GENE_ROWS[gene];
    const value = genes[index];
    const strength = cellStrength(row.key, value);
    const cellX = left + bar * cellWidth;
    const cellY = top + gene * (cellHeight + gap);
    const cell = svg(doc, "g", { class: `c-${row.channel} ${extraClass(bar, gene)}`.trim() });
    cell.append(svg(doc, "title", {}, `Bar ${bar + 1}, ${row.label}: ${GENE_NAMES[row.key][value]} (gene value ${value})`));
    cell.append(svg(doc, "rect", { class: "how-cell", x: cellX, y: cellY, width: cellWidth - gap, height: cellHeight, rx: 3, "fill-opacity": strength }));
    cell.append(
      svg(
        doc,
        "text",
        { class: `how-cell-value${strength >= 0.6 ? " on-light" : ""}`, x: cellX + (cellWidth - gap) / 2, y: cellY + cellHeight / 2 + 3.5 },
        String(value),
      ),
    );
    image.append(cell);
  }
}

/** @type {Drawing} */
function drawGenome(doc, data) {
  const left = 44;
  const top = 16;
  const cellHeight = 22;
  const gap = 3;
  const cellWidth = Math.min(36, (WIDTH - left) / data.bars.length);
  const image = svgImage(doc, top + GENES_PER_BAR * (cellHeight + gap) + 2);
  data.bars.forEach((/** @type {any} */ bar, /** @type {number} */ index) => {
    image.append(svg(doc, "text", { class: "how-axis how-middle", x: left + index * cellWidth + (cellWidth - gap) / 2, y: 11 }, String(bar.number)));
  });
  image.append(svg(doc, "text", { class: "how-axis", x: 0, y: 11 }, "bar"));
  GENE_ROWS.forEach((row, gene) => {
    image.append(
      svg(doc, "text", { class: `how-row-label c-${row.channel}`, x: 0, y: top + gene * (cellHeight + gap) + cellHeight / 2 + 4 }, row.label),
    );
  });
  geneCells(doc, image, data.bars.flatMap((/** @type {any} */ bar) => bar.genes), { left, top, cellWidth, cellHeight, gap });
  // A thin line after each phrase: plans that keep a phrase's genes alike score better on coherence.
  data.bars.forEach((/** @type {any} */ bar, /** @type {number} */ index) => {
    if (!bar.phraseEnd || index + 1 === data.bars.length) return;
    const lineX = left + (index + 1) * cellWidth - gap / 2;
    image.append(svg(doc, "line", { class: "how-phrase-line", x1: lineX, x2: lineX, y1: top - 2, y2: top + GENES_PER_BAR * (cellHeight + gap) }));
  });

  const legend = html(doc, "dl", { class: "how-legend" });
  for (const row of data.rows) {
    const entry = html(doc, "div", { class: `c-${row.channel}` });
    const values = html(doc, "dd");
    row.values.forEach((/** @type {string} */ name, /** @type {number} */ value) => {
      const allowed = row.allowed.includes(value);
      const item = html(doc, "span", allowed ? { class: "how-value" } : { class: "how-value off", title: "not allowed by the settings" });
      item.append(html(doc, "b", { class: "mono" }, String(value)), ` ${name}`);
      values.append(item);
    });
    entry.append(html(doc, "dt", { class: "mono" }, row.label), values);
    legend.append(entry);
  }
  return { image, legend };
}

/** @type {Drawing} */
function drawFitness(doc, data) {
  const rowHeight = 19;
  const top = 16;
  const trackLeft = 106;
  const trackWidth = 120;
  const scoreX = 232;
  const weightX = WIDTH;
  const fitnessY = top + data.criteria.length * rowHeight + 10;
  const image = svgImage(doc, fitnessY + rowHeight);
  image.append(svg(doc, "text", { class: "how-axis", x: trackLeft, y: 10 }, "0"));
  image.append(svg(doc, "text", { class: "how-axis how-end", x: trackLeft + trackWidth, y: 10 }, "1"));
  image.append(svg(doc, "text", { class: "how-axis", x: scoreX, y: 10 }, "score"));
  image.append(svg(doc, "text", { class: "how-axis how-end", x: weightX, y: 10 }, "weight"));
  /**
   * @param {string} label @param {number | null} score @param {string} weight @param {number} rowY
   * @param {string} kind
   */
  const scoreRow = (label, score, weight, rowY, kind) => {
    image.append(svg(doc, "text", { class: `how-label${kind === "total" ? " strong" : ""}`, x: 0, y: rowY + 12 }, label));
    image.append(svg(doc, "rect", { class: `how-track${score === null ? " none" : ""}`, x: trackLeft, y: rowY + 4, width: trackWidth, height: 9, rx: 2 }));
    if (score !== null) {
      image.append(svg(doc, "rect", { class: `how-score ${kind}`, x: trackLeft, y: rowY + 4, width: Math.max(0.5, score * trackWidth), height: 9, rx: 2 }));
    }
    image.append(svg(doc, "text", { class: `how-value-text${score === null ? " none" : ""}`, x: scoreX, y: rowY + 12 }, score === null ? "n/a" : score.toFixed(2)));
    if (weight !== "") image.append(svg(doc, "text", { class: "how-value-text muted how-end", x: weightX, y: rowY + 12 }, weight));
  };
  data.criteria.forEach((/** @type {any} */ row, /** @type {number} */ index) => {
    scoreRow(row.label, row.score, String(row.weight), top + index * rowHeight, "criterion");
  });
  image.append(svg(doc, "line", { class: "how-divider", x1: 0, x2: WIDTH, y1: fitnessY - 3, y2: fitnessY - 3 }));
  scoreRow("Fitness", data.fitness, "", fitnessY, "total");
  return { image };
}

/** @type {Drawing} */
function drawEvolution(doc, data) {
  const left = 40;
  const cellHeight = 12;
  const gap = 2;
  const stripHeight = GENES_PER_BAR * (cellHeight + gap);
  const titleHeight = 15;
  const stripGap = 8;
  const cellWidth = Math.min(40, (WIDTH - left) / data.figureBars);
  const stripTop = (/** @type {number} */ strip) => strip * (titleHeight + stripHeight + stripGap) + titleHeight;
  const childBottom = stripTop(2) + stripHeight;
  const image = svgImage(doc, childBottom + 34);
  const mutatedIndex = data.mutation === null ? -1 : (data.mutation.bar - 1) * GENES_PER_BAR + data.mutation.gene;
  /** @type {Array<[string, number[]]>} */
  const strips = [
    ["Parent A", data.parentA],
    ["Parent B", data.parentB],
    ["Child", data.child],
  ];
  strips.forEach(([title, genes], strip) => {
    const top = stripTop(strip);
    image.append(svg(doc, "text", { class: "how-strip-title", x: 0, y: top - 4 }, title));
    GENE_ROWS.forEach((row, gene) => {
      image.append(svg(doc, "text", { class: `how-row-label small c-${row.channel}`, x: 0, y: top + gene * (cellHeight + gap) + 9.5 }, row.label === "P1 oct" ? "P1" : row.label));
    });
    geneCells(doc, image, genes, { left, top, cellWidth, cellHeight, gap }, (bar, gene) =>
      strip === 2 && bar * GENES_PER_BAR + gene === mutatedIndex ? "how-mutated" : "",
    );
  });
  // The cut, through the three strips, and where each part of the child comes from.
  const cutX = left + data.cut * cellWidth - gap / 2;
  if (data.cut < data.figureBars) {
    image.append(svg(doc, "line", { class: "how-cut", x1: cutX, x2: cutX, y1: stripTop(0) - 4, y2: childBottom + 4 }));
  }
  const bracketY = childBottom + 6;
  /** @param {number} from @param {number} to @param {string} label */
  const bracket = (from, to, label) => {
    image.append(svg(doc, "path", { class: "how-bracket", d: `M${r(from + 1)} ${bracketY - 3} V${bracketY} H${r(to - 1)} V${bracketY - 3}` }));
    image.append(svg(doc, "text", { class: "how-axis how-middle", x: (from + to) / 2, y: bracketY + 11 }, label));
  };
  bracket(left, cutX, "from A");
  if (data.cut < data.figureBars) bracket(cutX, left + data.figureBars * cellWidth - gap, "from B");
  if (data.mutation !== null) {
    const { bar, row, fromName, toName } = data.mutation;
    image.append(svg(doc, "text", { class: "how-axis how-accent", x: 0, y: bracketY + 25 }, `mutation: bar ${bar}, ${row} ${fromName} → ${toName}`));
  }
  return { image };
}

// Lanes of the drum band, top to bottom.
const DRUM_LANES = /** @type {const} */ ([
  [HIHAT, "hi-hat"],
  [SNARE, "snare"],
  [KICK, "kick"],
]);

/** @type {Drawing} */
function drawRealization(doc, data) {
  const left = 34;
  const right = WIDTH - 4;
  const top = 16;
  const laneGap = 3;
  const drumLaneHeight = 9;
  /** @type {Array<[string, number]>} pitched lanes, top to bottom, with their heights */
  const lanes = [
    ["P1", 44],
    ["P2", 44],
    ["TR", 34],
  ];
  const drumTop = top + lanes.reduce((height, [, laneHeight]) => height + laneHeight + laneGap, 0);
  const bottom = drumTop + DRUM_LANES.length * drumLaneHeight;
  const image = svgImage(doc, bottom + 2);
  const x = beatGrid(doc, image, data.bars, left, right, top, bottom);
  for (const bar of data.bars) {
    image.append(svg(doc, "text", { class: "how-axis", x: x(bar.start) + 2, y: 11 }, `bar ${bar.number}`));
  }
  let laneTop = top;
  for (const [channel, laneHeight] of lanes) {
    const { row, y } = pitchScale(data.pitchRanges[channel], laneTop + 1, laneTop + laneHeight - 1);
    const color = `c-${channel.toLowerCase()}`;
    image.append(svg(doc, "text", { class: `how-row-label how-end ${color}`, x: left - 5, y: laneTop + laneHeight / 2 + 4 }, channel));
    for (const note of data.channels[channel]) {
      image.append(
        svg(doc, "rect", {
          class: `how-note ${color}`,
          x: x(note.onset) + 0.4,
          y: y(note.pitch) - row / 2,
          width: Math.max(1.2, x(note.duration) - left - 0.8),
          height: Math.max(3.5, row - 0.4),
          rx: 1,
        }),
      );
    }
    laneTop += laneHeight + laneGap;
    image.append(svg(doc, "line", { class: "how-lane-line", x1: left, x2: right, y1: laneTop - laneGap / 2, y2: laneTop - laneGap / 2 }));
  }
  DRUM_LANES.forEach(([pitch, name], lane) => {
    const drumLaneTop = drumTop + lane * drumLaneHeight;
    image.append(svg(doc, "text", { class: "how-axis small how-end c-no colored", x: left - 5, y: drumLaneTop + 7 }, name));
    for (const hit of data.channels.NO.filter((/** @type {{pitch: number}} */ note) => note.pitch === pitch)) {
      image.append(
        svg(doc, "rect", {
          class: "how-note c-no",
          x: x(hit.onset) + 0.5,
          y: drumLaneTop + 1.5,
          width: Math.max(1.5, x(hit.duration) - left - 1.5),
          height: drumLaneHeight - 3,
          rx: 1,
        }),
      );
    }
  });

  const choices = (/** @type {number} */ gene) => withoutRepeats(data.bars.map((/** @type {any} */ bar) => bar.names[gene])).join(" then ");
  const legend = html(doc, "ul", { class: "how-legend how-channels" });
  /** @type {Array<[string, string, string]>} */
  const entries = [
    ["p1", "P1", `melody, octave ${choices(3)}`],
    ["p2", "P2", choices(0)],
    ["tr", "TR", choices(1)],
    ["no", "NO", choices(2)],
  ];
  for (const [color, channel, played] of entries) {
    const item = html(doc, "li", { class: `c-${color}` });
    item.append(html(doc, "span", { class: "how-swatch", "aria-hidden": "true" }), html(doc, "b", { class: "mono" }, channel), ` ${played}`);
    legend.append(item);
  }
  return { image, legend };
}

/** @type {Drawing} */
function drawSound(doc, data) {
  const rowHeight = 36;
  const left = 92;
  const right = WIDTH - 2;
  const amplitude = 12;
  const image = svgImage(doc, data.waves.length * rowHeight);
  data.waves.forEach((/** @type {any} */ wave, /** @type {number} */ index) => {
    const middle = index * rowHeight + rowHeight / 2;
    const color = wave.channel === null ? "none" : wave.channel.toLowerCase();
    image.append(svg(doc, "text", { class: "how-label", x: 0, y: middle - 1 }, wave.label));
    const role = wave.channel === null ? "not used here" : wave.id === "noise" ? "NO, hi-hat" : wave.channel;
    image.append(svg(doc, "text", { class: `how-axis c-${color} colored`, x: 0, y: middle + 11 }, role));
    image.append(svg(doc, "line", { class: "how-midline", x1: left, x2: right, y1: middle, y2: middle }));
    // Each sample holds its level until the next one: the chip's waves are steps, not curves.
    const step = (right - left) / wave.values.length;
    const points = wave.values.flatMap((/** @type {number} */ value, /** @type {number} */ sample) => {
      const level = r(middle - value * amplitude);
      return [`${r(left + sample * step)},${level}`, `${r(left + (sample + 1) * step)},${level}`];
    });
    image.append(svg(doc, "polyline", { class: `how-wave c-${color}`, points: points.join(" ") }));
  });
  return { image };
}
