# Contract: catalog commands

| Command | Writes |
|---|---|
| `uv run src/main.py catalog analyze --dataset <dir>` | `arranger/data/catalog/mpb.json` (facts + server routes) from the local MPB study copy and its `metadata.csv` |
| `uv run src/main.py catalog authors` | `data/catalog/authors.json` (Wikidata, cached in `data/raw/wikidata/`) |
| `uv run src/main.py catalog public-domain --dataset <dir>` | `data/catalog/abc/public-domain/*.abc` + `public-domain.json` |
| `uv run src/main.py catalog nottingham [--source data/raw/nottingham]` | `data/catalog/abc/nottingham/*.abc` + `LICENSE.md` + `nottingham.json` |
| `uv run src/main.py catalog pdmx [--source data/raw/pdmx] [--limit 2000]` | `data/catalog/abc/pdmx/*.abc` + `NOTICE.md` + `pdmx.json` |
| `uv run src/main.py catalog examples` | `arranger/data/catalog/examples.json` from `data/sources.json` |

Each command is deterministic for the same inputs and prints what it wrote. The existing crawl
(`catalog crawl`, formerly `catalog`) stays for refreshing the MPB links.
