# Contract: catalog files

- Location: `arranger/data/catalog/<source>.json`, one per card; UTF-8, one entry per line inside
  `entries`, sorted by normalized title then id (stable diffs).
- Envelope: `{ "source": "<id>", "name": "<card name>", "home": "<url>", "license": "<summary>",
  "credit": "<attribution text>", "note": "<what is and is not stored>", "generated": "<command>",
  "entries": [ ... ] }`.
- Entries follow [data-model.md](../data-model.md) "Catalog entry".
- `mpb.json` holds analysis facts and server routes only (no notes). `public-domain.json`,
  `nottingham.json` and `pdmx.json` hold `abc` routes into `data/catalog/abc/<source>/`, whose
  folder keeps the collection's `LICENSE` or `NOTICE`.
- Every committed ABC file starts with `%` provenance lines: source URL or dataset path, license,
  authors and death years (public domain), SHA-256 of the source, the command that wrote it.
