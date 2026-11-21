import { readWordTable } from "./word-data.ts";

const MIN_SOURCE = 2;
const MAX_SOURCE = 12;

// Han characters in replies often arrive as compatibility ideographs, so the table
// and lookups are NFKC-normalized while the replaced span keeps its original text.
// Readings already have word-initial dueum applied by scripts/build-lexicons.py.
// 236k entries: one string per source keeps the table near 35 MB of heap instead
// of allocating an array per word. Alternate readings are joined on \u0001.
const SEP = "\u0001";
const SOURCES = new Map<string, string>();
const BY_FIRST = new Map<string, string[]>();
const HEADINGS = new Map<string, string>();
let hanjaLoaded = false;
let headingsLoaded = false;

// Reading 2 MB of dictionary data at startup would delay every reply, so each
// table waits for the first word that needs it. A reply with only a Japanese
// heading never pays for the 236k Hanja words.
function loadHanja() {
  if (hanjaLoaded) return;
  hanjaLoaded = true;
  for (const row of readWordTable("hanja").split("\n")) {
    const [reading, source] = row.split("\t");
    if (!reading || !source || source.length < MIN_SOURCE || source.length > MAX_SOURCE) continue;
    // scripts/build-lexicons.py already writes NFKC sources; normalizing 236k
    // character arrays here cost more than the whole table lookup does.
    const normalized = source;
    const existing = SOURCES.get(normalized);
    if (existing !== undefined) {
      if (!existing.split(SEP).includes(reading)) SOURCES.set(normalized, existing + SEP + reading);
    } else {
      SOURCES.set(normalized, reading);
      const first = normalized[0];
      const bucket = BY_FIRST.get(first);
      if (bucket) bucket.push(normalized);
      else BY_FIRST.set(first, [normalized]);
    }
  }
}

function loadHeadings() {
  if (headingsLoaded) return;
  headingsLoaded = true;
  for (const row of readWordTable("japanese-headings").split("\n")) {
    const [source, reading] = row.split("\t");
    if (source && reading && !HEADINGS.has(source)) HEADINGS.set(source, reading);
  }
}

// shortcut: recognize common complete particles and verbal endings; extend with verified cases.
const SUFFIX = /^(?:[이가을를은는의에도만와과께로]|에게서?|에서는?|으로|까지|부터|처럼|보다|라서|이라|입니다|이다|이고|이라면|하다|합니다|하세요|하고|하면|하는|한|할|해|해서|했다|했습니다|되다|됩니다|되고|되면|되는|된|될|됐다|됐습니다)?$/u;
const BARE_HAN = /[가-힣\p{Script=Han}]/u;
const KANA = /[\u3041-\u30fa]/u;

/**
 * Read a Korean word that mixes Han characters with its own Hangul spelling.
 *
 * Dictionary words of the same length are tried from the first Han character: a
 * position matches when the text keeps the Han character or spells its reading.
 * More than one surviving reading means the word needs context, so it is left
 * alone. Text without Hangul or without a trailing particle is not touched.
 */
export function readMixedHanja(token: string): { source: string; reading: string } | undefined {
  const chars = [...token.normalize("NFC")].map((char) => char.normalize("NFKC"));
  // A bare Han word (파일改名, 改名 후) is a candidate too: what makes a reading
  // safe is the single-surviving-reading rule below, not Hangul in the token.
  if (!BARE_HAN.test(chars.join(""))) return undefined;
  loadHanja();
  const candidates = BY_FIRST.get(chars[0]);
  if (!candidates) return undefined;
  const found = new Set<string>();
  const lengths = new Set<number>();
  let matched = "";
  for (const source of candidates) {
    if (source.length > chars.length) continue;
    const tail = chars.slice(source.length).join("");
    for (const reading of SOURCES.get(source)!.split(SEP)) {
      if (!SUFFIX.test(tail.slice(reading.length - source.length))) continue;
      let ok = true;
      for (let at = 0; at < source.length; at++) {
        if (chars[at] !== source[at] && chars[at] !== reading[at]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      found.add(reading);
      lengths.add(source.length);
      matched = source;
    }
  }
  // One reading and one span length: two different lengths would replace a
  // different number of characters than the word that was matched.
  return found.size === 1 && lengths.size === 1 ? { source: matched, reading: [...found][0] } : undefined;
}

/**
 * Warm the small heading table while Pi starts. The 236k-word Hanja table stays
 * lazy: it costs about 226 ms and 50 MB, which a reply should not pay unless a
 * Hanja word actually appears.
 */
export function preloadWordTables(): void {
  try {
    loadHeadings();
  } catch {
    // Word lookups already fail open; startup must not depend on the tables.
  }
}

/** Known Korean heading written in Japanese, with kana required. */
export function readJapaneseHeading(label: string): string | undefined {
  if (!KANA.test(label)) return undefined;
  loadHeadings();
  return HEADINGS.get(label);
}
