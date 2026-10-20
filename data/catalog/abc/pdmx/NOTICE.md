# PDMX lead sheets

The lead sheets in this folder are reduced from MIDI files of PDMX:

> Phillip Long, Zachary Novack, Julian McAuley and Taylor Berg-Kirkpatrick. *PDMX: A
> Large-Scale Public Domain MusicXML Dataset for Symbolic Music Processing.* Zenodo record
> 15571083, doi:10.5281/zenodo.15571083 (https://zenodo.org/records/15571083).

PDMX is licensed under the Creative Commons Attribution 4.0 International license (CC BY 4.0,
https://creativecommons.org/licenses/by/4.0/). Each score in it was published on MuseScore under
the Public Domain Mark or CC0, as its `license` field records.

Changes: the project keeps only scores of the `no_license_conflict` subset that are the best
unique arrangement of their song, 8 to 256 bars long, and whose composer died in 1955 or earlier
according to Wikidata (`data/catalog/authors.json`). Each file is reduced to a lead sheet (one
melody, the detected chords, at most 64 bars) and names its source file, its SHA-256 and its
license in its `%` header.

Written by: `uv run src/main.py catalog pdmx --limit 2000`.
