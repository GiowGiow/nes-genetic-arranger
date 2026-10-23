// Reading the search pages of two sites that have no search API.
//
// midis101.com and the Mutopia Project publish a search page as plain HTML. The song app cannot
// read another site's page (no CORS header), so the Worker fetches the page once per search at
// the visitor's request, picks the songs out of it and answers with a short JSON list. This file
// holds the pure part: building the search address, and reading the HTML into results. The
// network is in index.js, so these functions are tested on small hand-written pages that have
// the same structure as the sites' (test/fixtures/).
//
// A result carries the address of its MIDI file so the app can open it in one click through
// `/midi`. The Worker only ever lists addresses on the site it just searched: a link that points
// elsewhere is dropped, so a changed or hostile page cannot make the app ask for a stranger's file.

/** Most results one search returns. A page lists about ten to twenty; the app shows them as a short list. */
export const MAX_RESULTS = 20;

/** Longest query accepted, in characters. */
export const MAX_QUERY_LENGTH = 80;

const MIDIS101 = "https://www.midis101.com";
const MUTOPIA = "https://www.mutopiaproject.org";

/**
 * The visitor's words as the Worker uses them: trimmed, inner spaces squeezed to one. A query
 * under two characters is not worth a request to someone else's site, and a very long one is
 * not a song title.
 *
 * @param {string | null | undefined} raw the `q` parameter
 * @returns {string | null} null when the query is refused
 * @example
 * cleanQuery("  arctic   monkeys "); // "arctic monkeys"
 * cleanQuery("a"); // null
 */
export function cleanQuery(raw) {
  if (typeof raw !== "string") return null;
  const query = raw.trim().replace(/\s+/g, " ");
  return query.length >= 2 && query.length <= MAX_QUERY_LENGTH ? query : null;
}

/**
 * Where midis101.com searches for some words.
 *
 * @param {string} query already cleaned
 * @returns {URL}
 * @example
 * midis101SearchUrl("arctic monkeys").href; // "https://www.midis101.com/search/arctic%20monkeys"
 */
export function midis101SearchUrl(query) {
  return new URL(`${MIDIS101}/search/${encodeURIComponent(query)}`);
}

/**
 * Where the Mutopia Project searches for some words.
 *
 * @param {string} query already cleaned
 * @returns {URL}
 * @example
 * mutopiaSearchUrl("bach").searchParams.get("searchingfor"); // "bach"
 */
export function mutopiaSearchUrl(query) {
  const url = new URL(`${MUTOPIA}/cgibin/make-table.cgi`);
  url.searchParams.set("searchingfor", query);
  return url;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘" };

/**
 * Text from a piece of HTML: tags dropped, the common entities decoded, spaces squeezed.
 *
 * @param {string} html
 * @returns {string}
 * @example
 * plainText("Rock &amp; <i>Roll</i>"); // "Rock & Roll"
 */
function plainText(html) {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, decimal, hex, name) => {
      if (decimal) return String.fromCodePoint(Number(decimal));
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Read midis101.com's search page. Each song is a table cell with a link to its page,
 * `/free-midi/<number>-<slug>`; its file is at `/download/<number>-<slug>`, which sends the MIDI
 * bytes directly (checked by hand on one song, 2026-10-23).
 *
 * @param {string} html the search page
 * @returns {Array<{id: string, title: string, url: string, midi: string}>} at most `MAX_RESULTS`, in page order
 * @example
 * parseMidis101('<td><a href="/free-midi/7-a-b">A B</a></td>')[0].midi;
 * // "https://www.midis101.com/download/7-a-b"
 */
export function parseMidis101(html) {
  const results = [];
  const seen = new Set();
  for (const match of html.matchAll(/<td>\s*<a href="\/free-midi\/(\d+)-([a-z0-9-]+)">([^<]*)<\/a>\s*<\/td>/gi)) {
    const [, id, slug, rawTitle] = match;
    const title = plainText(rawTitle);
    if (title === "" || seen.has(id)) continue;
    seen.add(id);
    results.push({ id, title, url: `${MIDIS101}/free-midi/${id}-${slug}`, midi: `${MIDIS101}/download/${id}-${slug}` });
    if (results.length === MAX_RESULTS) break;
  }
  return results;
}

/**
 * Read the Mutopia Project's result list. Each piece is a `result-table`: its first cell is the
 * title and the next the composer; "for Organ" opens the second row; the third row holds the
 * license link and "More Information" (`piece-info.cgi?id=N`); the fourth holds the downloads. A
 * piece whose MIDI files come only as a zip has no `.mid file` link and is left out, as is a
 * link that is not on the project's own file area (`/ftp/`).
 *
 * @param {string} html the result page
 * @returns {Array<{id: string, title: string, composer: string, instrument: string, license: string, url: string, midi: string}>}
 *   at most `MAX_RESULTS`, in page order
 * @example
 * parseMutopia(page)[0].license; // "Public Domain"
 */
export function parseMutopia(html) {
  const results = [];
  for (const block of html.split(/<table[^>]*class="[^"]*result-table[^"]*"[^>]*>/i).slice(1)) {
    const cells = [...block.split(/<\/table>/i)[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cell[1]);
    const id = /piece-info\.cgi\?id=(\d+)/.exec(block)?.[1];
    const midi = /<a href="(https:\/\/www\.mutopiaproject\.org\/ftp\/[^"]+\.mid)">\s*\.mid file\s*<\/a>/i.exec(block)?.[1];
    const title = plainText(cells[0] ?? "");
    if (!id || !midi || title === "") continue;
    const license = /<a href="[^"]*legal\.html#[^"]*">([^<]*)<\/a>/i.exec(block)?.[1];
    results.push({
      id,
      title,
      composer: plainText(cells[1] ?? "").replace(/^by\s+/i, ""),
      instrument: plainText(cells[4] ?? "").replace(/^for\s+/i, ""),
      license: plainText(license ?? ""),
      url: `${MUTOPIA}/cgibin/piece-info.cgi?id=${id}`,
      midi,
    });
    if (results.length === MAX_RESULTS) break;
  }
  return results;
}
