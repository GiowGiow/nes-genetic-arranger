"""The song browser's catalogs: which songs the app offers, and how each one opens.

The browser shows one memory card per source. This package writes their files, offline, with
the `catalog` command (contracts/cli.md):

- `crawl` and `pages` walk Beatriz Kauffmann's Web Site (https://www.beakauffmann.com/), a list
  of about 3,700 Brazilian songs (MPB) with fan-made MIDI files, for titles, composers and links.
- `analysis` measures each MPB MIDI file of a local study copy (melody track, bars, key, tempo,
  meter) and writes `arranger/data/catalog/mpb.json`: metadata, links and facts, never notes,
  because the site says "All Rights Reserved". A visitor who opens a song downloads its MIDI
  file from the site and drops it on the page.
- `authors` looks up the authors' death years on Wikidata, for the public-domain rule.
- `collections` writes the lead sheets the repository may redistribute (public-domain MPB songs,
  the Nottingham folk tunes, a PDMX subset) and the Examples card.
- `cards` holds what every catalog file shares: the envelope, the sort order, the sprite seed.
- `popularity` adds `pop` (how well known each song is: Wikipedia page views, PDMX counters or
  a curated list) to every entry, and gives MPB entries their download route.
"""
