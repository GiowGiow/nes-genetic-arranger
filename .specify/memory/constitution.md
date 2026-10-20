# NES Genetic Arranger Constitution

This project began as the first assignment (TP1) of DCC831 – Generative AI for Music (UFMG,
2026/2). It implements one classic algorithmic composition method end to end, from a symbolic
representation to synthesized audio, and reports it in an ISMIR-format abstract. After the
submission it continues as `nes-genetic-arranger`: the same method, the command line, the
browser arranger and, since spec 005, an optional song server.

The code has two goals of equal weight: produce correct, reproducible music, and teach a human
reader how the method works. Every principle below serves one or both goals.

**Audience.** Primary readers are the student, the course staff and classmates. They know
Python and basic music theory (notes, intervals, scales, meter). They do not know the internals
of the method this project implements. AI coding agents are secondary readers and follow the
same rules.

## Core Principles

### I. Deterministic Reproducibility (NON-NEGOTIABLE)

- Every generation run MUST take an explicit integer seed. The same configuration and seed MUST
  produce the same MIDI content.
- Randomness MUST come from a `numpy.random.Generator` (`np.random.default_rng(seed)`) passed as
  a parameter. Global random state (`random.seed`, `np.random.seed`, module-level generators) is
  forbidden.
- Every generated piece MUST be saved with a `config.json` next to it that records the seed, all
  hyperparameters, the git commit hash and the creation date.
- Every result in the README and in the abstract (MIDI, audio, figures, tables) MUST be
  regenerable with commands documented in the README.
- The web app (see "Web App Constraints") follows the same rule with its own generator: its
  randomness MUST come from a seeded generator object passed as a parameter. `Math.random`,
  module-level generators and any other global random state are forbidden. The same input,
  seed and settings MUST give the same arrangement inside the app.
- The Python command line is the reference implementation for the samples and the abstract.
  The web app need not give the command line's arrangement for the same seed, but it MUST give
  the same fitness and criterion scores to a given plan, and the same lead sheet from a given
  MIDI song and settings. Tests check both against the committed samples.

Rationale: the assignment requires reproducible symbolic output, and MIR results are only
credible when implementation details can be rerun.

### II. Test-First Development (NON-NEGOTIABLE)

- Production code MUST follow red-green-refactor: write a test, run it and see it fail for the
  expected reason, write the minimum code to pass, then refactor with the tests green.
- No production function is written without a failing test that requires it. A bug fix starts
  with a test that reproduces the bug.
- Tests MUST cover the method core (for example: transition rows sum to 1, the grammar derives
  only valid terminals, genetic operators keep genotype length) and one end-to-end path
  (generate, write MIDI, read it back with music21).
- Test names MUST state the behavior in plain language, so the test suite reads as an
  executable specification of the method.
- Scripts that only produce figures or audio are exempt from test-first, but the functions they
  call are not.
- These rules apply to the web app's code too. Its tests run under a JavaScript test runner
  without a browser, except tests that need one.

Rationale: tests written first force a clear definition of each musical rule before the code,
and they double as worked examples for the reader.

### III. Explicit Symbolic Representation and Style Contract

- The method core MUST work on an internal representation with explicit units: pitches as MIDI
  numbers 0–127, durations in quarter-note beats (`quarterLength`), and declared meter, key and
  tempo. Seconds and MIDI ticks appear only in the export layer.
- Export to MIDI (and to MusicXML or audio) MUST live in its own module, separate from the
  method core.
- Every generated piece MUST pass validation before export: pitches inside the instrument
  range, durations greater than zero, and complete bars for the declared meter.
- The chosen stylistic constraint (for example, a 12-bar blues or an AABA form) MUST be encoded
  as checkable rules (bar count, harmonic progression, scale membership) and verified by tests.

Rationale: separating musical meaning from file formats makes the method testable and easy to
explain, and the assignment requires an explicit stylistic constraint.

### IV. Learnable Code

- Every module in `src/` MUST open with a docstring that explains the musical or algorithmic
  idea it implements, in plain language, before any implementation detail.
- Every public function MUST have type hints and a docstring. Functions in the method core MUST
  include a small worked example in the docstring (doctest format) that runs under pytest.
- In the web app, every module MUST open with a comment that explains its musical or
  algorithmic idea. Every exported function MUST have a doc comment with parameter and return
  types (JSDoc or TypeScript). Method-core functions MUST show a small worked example in that
  comment, and a test MUST check the same example.
- Names MUST use domain vocabulary (`transition_matrix`, `bar`, `chord_progression`), not
  generic names (`data`, `tmp`, `arr`).
- Comments explain the why: a trade-off, a boundary condition, a musical rule, or a link to the
  literature. They MUST NOT restate what the code does. Use 1 to 3 lines before a non-trivial
  block; do not flood the code with comments.
- Every music-theory or method term MUST be defined on first use in the documentation and
  collected in `docs/glossary.md`.
- Documentation follows the Diátaxis split: a tutorial (the walkthrough notebook), how-to
  guides (README commands), reference (docstrings and `--help`), and explanation
  (`docs/explanation.md`: why this method and how it works).

Rationale: the course is about understanding generative methods; code that a classmate cannot
follow fails half of the project's goal.

### V. Visual and Explorable Explanations

- Each core concept MUST have a visual that a human can inspect: a piano roll for every
  generated piece, plus the method's own structure (transition matrix heatmap for Markov,
  fitness-per-generation curve for genetic algorithms, derivation tree for grammars).
- A walkthrough notebook in `notebooks/` MUST take the reader from the input (corpus or rules)
  to a generated piece step by step, with visuals, rendered score and audio playback, and with
  controls for at least one hyperparameter. Notebooks MUST be marimo notebooks (stored as plain
  Python, reactive, runnable as scripts), not `.ipynb` files.
- The README and `docs/explanation.md` MUST include a pipeline diagram written in Mermaid so it
  renders on GitHub and stays diffable.
- A visual MUST NOT be the only source of meaning: every figure or diagram has a caption or a
  short text that states what the reader should see in it.
- Figures MUST be generated by scripts, never edited by hand, and use a colorblind-safe palette
  (`tableau-colorblind10`, as the ISMIR template recommends). Figures for the abstract are
  saved as vector PDF in `paper/figures/`.

Rationale: generated music is hard to judge from code alone; seeing and hearing intermediate
steps is how humans (and reviewers) build intuition about the method.

### VI. Measurable Evaluation

- Every experiment MUST report simple objective metrics: pitch-class histogram, interval
  distribution, note density and pitch entropy. When a corpus is used, compare the generated
  pieces against it.
- Every experiment MUST state what was varied (seed or hyperparameter) and what stayed fixed.
- Listening notes (qualitative observations) complement the metrics and are recorded next to
  each piece.

Rationale: the abstract needs a results section that goes beyond "it sounds good", and metrics
make the effect of each hyperparameter visible.

### VII. Simplicity

- Write only the code that the assignment, the abstract and principles IV–V require. No
  speculative abstractions, plugin systems or configuration layers.
- Keep the method core made of pure functions; file and network I/O happen only at the edges
  (command line, export, notebooks).
- Add a dependency only when the code uses it, and prefer the libraries already in the project.

Rationale: a small, direct codebase is easier to test, explain and grade.

## Technology and Assignment Constraints

- Stack: Python 3.12, uv for every environment and dependency operation, ruff for lint and
  format, pytest for tests, music21 and pretty_midi for symbolic music, numpy for numerics,
  matplotlib for plots, marimo for notebooks.
- Type hints are required on public functions. Pyright runs in the editor; it is not a commit
  gate.
- Layout: code lives directly in `src/`, in subfolders by responsibility, with `src/main.py` as
  the argparse entry point (`uv run src/main.py`). Tests live in `tests/`, the abstract in
  `paper/`, notebooks in `notebooks/`, long-form docs in `docs/`, and curated pieces in
  `samples/`. The web app lives in one top-level folder of its own (named in its plan), with
  its tests inside that folder. The song server lives in `server/`, with its tests in
  `tests/server/`.
- Language: all repository text is in English: code, identifiers, docstrings, comments, Spec
  Kit artifacts, README, glossary, explanation document, notebook narrative and the abstract.
  Every Markdown code block carries a language tag.
- Method fidelity: the project uses exactly one method (generative grammar, genetic algorithm
  or Markov chain), as the assignment requires, and exposes that method's required elements
  (Markov order; GA genotype, operators and fitness log; formal probabilistic grammar).
  Hyperparameters come from the command line or a config file, never from constants in code.
- Outputs: each run writes `outputs/<run-id>/` with `piece.mid`, `piece.mp3`, `pianoroll.png`
  and `config.json`. `outputs/` is not versioned. The pieces chosen for the deliverables are
  copied, with all four files, to `samples/<name>/` by a documented command, and only
  `samples/` is versioned.
- Audio is rendered only from MIDI files written by the code, never edited by hand, and each
  audio file stays under 5 MB. Two renderers are allowed:
  - FluidSynth with a General MIDI soundfont (`piece.mp3`);
  - the project's own NES chip synthesizer, which builds pulse, triangle and noise waveforms
    with numpy (`piece-chip.mp3`).
- A run may also write `input.mid` and `input.mp3`: the input made audible for comparison. For
  an ABC lead sheet, this is the lead sheet played plainly. For a MIDI song, it is the original
  excerpt.
- Data: if a corpus is used, its source and license are recorded in the README; large corpora
  stay out of git in `data/raw/` and are downloaded by a documented command. Inputs are ABC lead
  sheets or multi-track MIDI songs that the code reduces to lead sheets. Third-party MIDI files
  stay out of git in `data/raw/`; the README says where they come from, and a documented command
  downloads the ones that are on the web and checks their hashes. The lead sheet that the code
  reduces from each MIDI song may be committed as ABC in `data/leadsheets/` (the project's own
  reduction: one melody track, detected chords and part labels, no accompaniment or lyrics), so
  that the runs can be reproduced without the MIDI files.
- Third-party material:
  - A catalog of third-party songs MAY be committed as metadata, links and analysis facts:
    title, composers, performer, page and file URLs, and facts the code measured (melody
    track, bar range, sections, key, tempo, meter, the file's SHA-256). It MUST NOT hold notes
    of copyrighted songs, and it credits its source.
  - Copyrighted songs, including sources marked "All Rights Reserved", are loaded on demand
    from their source: the song server fetches a song when a visitor asks for it and keeps at
    most a temporary, size-capped cache. No permanent copy is kept, neither in git nor on the
    server.
  - ABC lead sheets MAY be committed only when the composition is in the public domain or the
    collection's license allows redistribution:
    - Public domain means every listed author died 70 or more full years ago, checked against a
      recorded source such as Wikidata. An unknown or ambiguous author counts as not public
      domain.
    - A licensed collection keeps its license file next to its files, and the app shows its
      attribution.
  - The academic reductions already in `data/leadsheets/` stay as they are.
  - Sources whose terms forbid processing by language models (for example The Session's data
    dump) are accessed only by the app, at the visitor's request. AI agents working on the
    repository never read their data; tests use synthetic data shaped like theirs.
- Deliverables: public GitHub repository with README (install, reproduce, pieces, AI usage
  statement) and `requirements.txt`; at least 3 synthesized pieces in the repository; an ISMIR
  abstract of at most 3 pages of content (postgraduate rule) with at least 4 references, 3 of
  them on the chosen method applied to music.

## Web App Constraints

These rules govern the browser arranger (spec `002-browser-arranger`), a static page that
reimplements the lead-sheet reader, the GA and the NES chip synthesizer in the visitor's browser.
Principles I–VII apply to it as well.

- Hosting: static files on the project's GitHub Pages site. The app MAY use one optional
  companion song server (see "Song Server Constraints") for search across external music sites
  and for loading songs from them. The app MUST keep working without it: local sources,
  uploads, the GA and playback. When the server does not answer, the app says so. No accounts
  and no analytics, on either side.
- Privacy: files and settings the visitor gives MUST stay on the visitor's device. Only search
  queries and song identifiers go to the song server. Apart from that, the app fetches only its
  own files, the APIs of sources that allow browser access, and the links the visitor clicks.
- Build: no build step when feasible. When one is needed, it stays minimal, and the committed
  output can be served as it is.
- Dependencies: few, pinned to exact versions, loaded from the repository or a pinned CDN URL.
  Prefer the browser's own APIs (for example, Web Audio for sound).
- Separation: the method core (reader, genome, fitness, operators, realizers) MUST be pure
  functions with no DOM, audio or network access, so that the JavaScript test runner can test it
  without a browser. Page code, audio and file I/O stay at the edges.
- Responsiveness: a GA run MUST NOT block the page. It runs off the main thread or in short
  slices, and it can be stopped at any time.
- Outputs: the app downloads the arrangement as MIDI, its settings as a JSON file that the
  command line accepts with `--config`, and the lead sheet as ABC. The settings file records the
  seed, every hyperparameter, the input's SHA-256, the app version (git commit) and the date.

## Song Server Constraints

These rules govern the song server (spec `005`), a small Python service in `server/` that the
student deploys. Principles I–VII apply to it as well.

- Purpose: search allow-listed external music sites, and load songs from them on demand. For
  catalog songs it reduces the MIDI file to an ABC lead sheet with the recorded analysis facts.
- Reference code: reductions reuse `src/leadsheet`, so the server's lead sheet equals the
  command line's for the same file and options, by construction.
- Upstreams:
  - Only allow-listed hosts are contacted, and a redirect to a host off the list is refused.
  - Every fetch has a size cap and a timeout, and the content is sniffed (MIDI or ABC) before
    use.
  - Requests to each upstream are spaced politely and carry the project User-Agent.
  - The server has no network route to private address ranges (LAN, cluster).
  - A takedown denylist lists songs the server refuses to serve.
- Visitors:
  - Rate limits apply per IP.
  - CORS allows only the Pages origin, plus localhost during development.
  - The server logs no visitor data beyond what rate limiting keeps in memory.
- Tests run against mocked upstreams; no test touches the network.

## Development Workflow and Quality Gates

- pre-commit runs on every commit: file hygiene, ruff check and format, `uv.lock` sync and
  `requirements.txt` export. pytest, including doctests, runs before every push, and so do the
  web app's tests once the app exists.
- The TP1 submission is preserved in the original repository (`chiptune-ga-arranger`, tag
  `v1.0-submission`). In this repository the student commits directly to `main`, which GitHub
  Pages serves; feature branches are optional.
- Each commit is small and leaves the test suite green. Under principle II, the failing test
  and the code that makes it pass may land in the same commit, but the test is written first.
- Before a feature is done, its docstrings, glossary entries, visuals and README commands are
  updated in the same change (principles IV and V).
- Spec Kit flow for new work: `/speckit-specify`, `/speckit-plan`, `/speckit-tasks`,
  `/speckit-implement`. Every plan includes a constitution check against this document.

## Governance

- This constitution supersedes other practices and Spec Kit artifacts. When a spec, plan or
  task conflicts with it, the constitution wins or is amended first.
- Amendments go through `/speckit-constitution`, need the student's approval, and update the
  version: MAJOR for removing or redefining a principle, MINOR for adding a principle or
  section, PATCH for wording.
- Every plan and review checks compliance with principles I–VII. A deviation is allowed only
  when it is written down in the plan with its reason.
- Agent guidance files in the repository (such as `CLAUDE.md`) must not contradict this
  document.

**Version**: 2.0.0 | **Ratified**: 2026-10-11 | **Last Amended**: 2026-10-20
