"""The song server (spec 005): search external music sites and load their songs on demand.

The browser arranger is a static page, and a page on one site cannot read files on another
(CORS). This small service does it for the page: it searches a few allow-listed music sites,
loads a song from them when a visitor asks for it, and, for the MPB catalog, reduces the MIDI file
to an ABC lead sheet with the facts recorded in the catalog. It keeps no permanent copy of any
song (constitution, "Song Server Constraints").

Modules:
- `fetcher`: the only way out to the internet (allow-list, size and time caps, sniffing, polite
  spacing, temporary cache).
- `limits`: per-visitor rate limits.
- `sources`: one module per site (MPB catalog, Mutopia, BitMidi, IMSLP).
- `app`: the HTTP routes.

The reductions reuse the command line's reader in `src/leadsheet`, so the server's lead sheet
equals the command line's by construction. `src/` is not an installed package (the project sets
`package = false`), so importing `server` puts `src/` on the import path.
"""

import sys
from pathlib import Path

SOURCE_DIR = Path(__file__).resolve().parents[1] / "src"
if str(SOURCE_DIR) not in sys.path:
    sys.path.append(str(SOURCE_DIR))
