import { readWordTable } from "./word-data.ts";

const MIN_SOURCE = 2;
const MAX_SOURCE = 12;

// Han characters in replies often arrive as compatibility ideographs, so the table
// and lookups are NFKC-normalized while the replaced span keeps its original text.
// Readings already have word-initial dueum applied by scripts/build-lexicons.py.
const SOURCES = new Map<string, string[]>();
const BY_FIRST = new Map<string, string[]>();
const HEADINGS = new Map<string, string>();
let loaded = false;

// Reading 2 MB of dictionary data at startup would delay every reply, so it waits
// for the first word that needs it.
function load() {
  if (loaded) return;
  loaded = true;
  for (const row of readWordTable("hanja").split("\n")) {
    const [reading, source] = row.split("\t");
    if (!reading || !source || source.length < MIN_SOURCE || source.length > MAX_SOURCE) continue;
    const normalized = [...source].map((char) => char.normalize("NFKC")).join("");
    const readings = SOURCES.get(normalized);
    if (readings) readings.push(reading);
    else {
      SOURCES.set(normalized, [reading]);
      const first = normalized[0];
      const bucket = BY_FIRST.get(first);
      if (bucket) bucket.push(normalized);
      else BY_FIRST.set(first, [normalized]);
    }
  }
  for (const row of readWordTable("japanese-headings").split("\n")) {
    const [source, reading] = row.split("\t");
    if (source && reading && !HEADINGS.has(source)) HEADINGS.set(source, reading);
  }
}

// shortcut: recognize common complete particles and verbal endings; extend with verified cases.
const SUFFIX = /^(?:[이가을를은는의에도만와과께로]|에게서?|에서는?|으로|까지|부터|처럼|보다|라서|이라|입니다|이다|이고|이라면|하다|합니다|하세요|하고|하면|하는|한|할|해|해서|했다|했습니다|되다|됩니다|되고|되면|되는|된|될|됐다|됐습니다)?$/u;
const HANGUL = /[가-힣]/u;
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
  if (!HANGUL.test(chars.join(""))) return undefined;
  load();
  const candidates = BY_FIRST.get(chars[0]);
  if (!candidates) return undefined;
  const found = new Set<string>();
  let matched = "";
  for (const source of candidates) {
    if (source.length > chars.length) continue;
    const tail = chars.slice(source.length).join("");
    for (const reading of SOURCES.get(source)!) {
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
      matched = source;
    }
  }
  return found.size === 1 ? { source: matched, reading: [...found][0] } : undefined;
}

/** Warm the word tables while Pi is still starting, not during a reply. */
export function preloadWordTables(): void {
  try {
    load();
  } catch {
    // Word lookups already fail open; startup must not depend on the tables.
  }
}

/** Known Korean heading written in Japanese, with kana required. */
export function readJapaneseHeading(label: string): string | undefined {
  if (!KANA.test(label)) return undefined;
  load();
  return HEADINGS.get(label);
}
