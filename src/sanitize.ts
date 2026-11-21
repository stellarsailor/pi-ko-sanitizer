import { readJapaneseHeading, readMixedHanja } from "./hanja.ts";
import { LEXICON, JAPANESE_LEAKS, KANA_READINGS, SHINJITAI } from "./lexicon.ts";

const KANA = /[\u3040-\u30ff]/u;
const HANGUL = /[가-힣]/u;
const HAN = /\p{Script=Han}/u;
const KANA_ALL = /[\u3040-\u30ff]/gu;
const HANGUL_ALL = /[가-힣]/gu;
// shortcut: no Markdown container state; use a parser for fences nested in lists or block quotes.
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/gm;
const INLINE_OR_URL = /(?<!`)(`+)(?!`)(?:(?!\r?\n[ \t]*\r?\n)[\s\S])*?(?<!`)\1(?!`)|https?:\/\/[^\s<>}"`]+/gi;

function* inlineRanges(text: string, offset: number): Generator<[number, number]> {
  const pattern = new RegExp(INLINE_OR_URL);
  for (let match; (match = pattern.exec(text)); ) {
    let end = pattern.lastIndex;
    if (!match[1]) {
      let depth = 0;
      // Parentheses inside the destination are literal; an unmatched close ends a Markdown link.
      for (let at = match.index; at < end; at++) {
        if (text[at] === "(") depth++;
        else if (text[at] === ")") {
          if (depth === 0) {
            end = at;
            break;
          }
          depth--;
        }
      }
      pattern.lastIndex = end;
    }
    yield [offset + match.index, offset + end];
  }
}

function* protectedRanges(text: string): Generator<[number, number]> {
  let cursor = 0;
  let open: { start: number; marker: string } | undefined;
  for (const match of text.matchAll(FENCE_LINE)) {
    const start = match.index ?? 0;
    const [, marker, rest] = match;
    if (open) {
      if (!marker.startsWith(open.marker) || rest.trim() !== "") continue;
      cursor = start + match[0].length;
      yield [open.start, cursor];
      open = undefined;
    } else if (marker[0] === "~" || !rest.includes("`")) {
      yield* inlineRanges(text.slice(cursor, start), cursor);
      open = { start, marker };
    }
  }
  if (open) yield [open.start, text.length];
  else yield* inlineRanges(text.slice(cursor), cursor);
}
// One contiguous CJK span: Han, hiragana or katakana, in any mix. A span that
// carries kana is a Japanese span, so Han inside it is never treated as Chinese.
const CJK_RUN = /[\p{Script=Han}\u3040-\u30ff]+/gu;
const CJK_ALL = /[\p{Script=Han}\u3040-\u30ff]/gu;
// No trailing lookahead: on a long Han run it made the engine backtrack over every
// prefix. The end of the match is checked in the replacement instead.
const HAN_TOKEN = /(?<![\p{L}\p{N}_/\\])\p{Script=Han}[\p{Script=Han}가-힣]*/gu;
const WORD_CHAR = /[\p{L}\p{N}_/\\]/u;
// 개항(開港): Han inside brackets right after Hangul is a Hanja gloss, not a leak.
const GLOSS_BEFORE = /[가-힣][([{<〔「『]/u;
const CLOSE = /[)\]}>〕」』]/u;
// A quoted span holding kana is a Japanese citation: "これは 修改 입니다" keeps its
// 修改 even though it sits between two spaces. A quote without kana is Korean
// prose quoting something, so leaks inside it are still fixed.
const QUOTED = /"[^"\n]*"|“[^”\n]*”|「[^」\n]*」|『[^』\n]*』/gu;

function japaneseQuotes(line: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const m of line.matchAll(QUOTED)) {
    if (!KANA.test(m[0])) continue;
    const at = m.index ?? 0;
    ranges.push([at, at + m[0].length]);
  }
  return ranges;
}

interface Matcher {
  map: Map<string, string>;
  keys: string[];
}

function matcher(entries: ReadonlyArray<readonly [string, string]>): Matcher {
  const map = new Map(entries);
  // Longer keys first so 您的 wins over 您. Keys are CJK-only (test asserts it),
  // so they need no regex escaping.
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  return { map, keys };
}

const ZH = matcher(LEXICON);
const JA = matcher(JAPANESE_LEAKS);
const KANA_MAP = new Map(KANA_READINGS);
const SHINJITAI_MAP = new Map(SHINJITAI);
// One character class for the whole table, built once. Every key is a Han
// character, so none needs escaping inside the class.
const SHINJITAI_ANY = new RegExp(`[${[...SHINJITAI_MAP.keys()].join("")}]`, "u");

// Japanese particles and endings that must never be read as a name tail: after a
// Korean word they are the sentence, not a truncated name.
const JP_GRAMMAR = new Set([
  "は", "が", "を", "に", "で", "と", "も", "の", "へ", "や", "か", "ね", "よ",
  "な", "だ", "わ", "ぞ", "ぜ", "さ", "し", "て", "た", "ば", "ら", "り", "る",
  "です", "ます", "から", "まで", "より", "ほど", "ので", "のに", "けど",
]);
// What can follow a name in Korean: a particle, punctuation, or nothing.
// Shared with the rewrite layer so both refuse the same kana: a particle after a
// Korean word is the Japanese sentence, not a truncated name.
export function isJapaneseGrammar(span: string): boolean {
  return JP_GRAMMAR.has(span);
}
const KO_PARTICLE = /^(?:은|는|이|가|을|를|의|에|에게|에서|으로|로|도|만|와|과|께|보다|처럼|까지|부터|이나|이랑)/u;
const END_OK = /^[\s,.!?"')\]:;~…—]/u;

/**
 * Compose a final consonant onto the last Hangul syllable: 카즈 + ㄴ → 카즌.
 * Only used for ン, which is a final consonant in Korean, not a syllable.
 */
function composeFinal(word: string, jamo: string): string | null {
  if (!word || !HANGUL.test(word[word.length - 1])) return null;
  const fins = { "ㄴ": 4, "ㅇ": 21, "ㅁ": 16 };
  const fin = fins[jamo as keyof typeof fins];
  if (!fin) return null;
  const code = word.charCodeAt(word.length - 1);
  if ((code - 0xac00) % 28 !== 0) return null; // already has a final
  return word.slice(0, -1) + String.fromCharCode(code + fin);
}

/**
 * Read a 1-3 kana tail attached to a Hangul word as Hangul.
 *
 * A kana tail is treated as part of a Korean-rendered name, not a Japanese
 * sentence. The rules are narrow: the kana must be glued to a
 * Hangul word on the left, must not be a Japanese particle, must be followed by a
 * Korean particle or punctuation, and every kana must have a reading.
 */
export function kanaTail(run: string, prev: string, after: string): { text: string; trimPrev: number } | null {
  if (run.length < 1 || run.length > 3) return null;
  if (!HANGUL.test(prev)) return null;
  if (isJapaneseGrammar(run)) return null;
  if (!KO_PARTICLE.test(after) && !END_OK.test(after) && after !== "") return null;
  let out = "";
  let trimPrev = 0;
  for (const ch of run) {
    const reading = KANA_MAP.get(ch);
    if (!reading) return null;
    if (reading === "ㄴ") {
      // ン is a final consonant in Korean, so it joins the syllable before it.
      if (out) {
        const joined = composeFinal(out, "ㄴ");
        if (!joined) return null;
        out = joined;
      } else {
        const joined = composeFinal(prev, "ㄴ");
        if (!joined) return null;
        out = joined;
        trimPrev = 1;
      }
      continue;
    }
    out += reading;
  }
  return out ? { text: out, trimPrev } : null;
}

// Context suffixes: a Chinese noun followed by one of these still reads as
// Korean once the suffix is translated, and rewriting the whole span is what
// makes `类型的 규칙` into `타입의 규칙` instead of leaving it untouched.
// 的 們 are possessive/plural and safe after any noun; 是 (copula) is only safe
// after a time adverb, where the Korean is reliably `는`.
const NOUN_SUFFIX: ReadonlyArray<readonly [string, string]> = [["的", "의"], ["們", "들"], ["们", "들"]];
const TIME_ADVERBS = new Set(["目前", "当前", "现在", "已经", "刚才", "之前", "之后", "以后"]);

/**
 * Cover the whole span with dictionary words, longest first.
 * Returns null when any character is left over, so a partial swap can never
 * leave debris like `현재是` behind: 目前是 is 目前 + a stranded 是, and a span
 * we cannot fully read is a span we do not touch.
 */
function cover(run: string, m: Matcher): string | null {
  let out = "";
  let last = "";
  for (let at = 0; at < run.length; ) {
    const key = m.keys.find((k) => run.startsWith(k, at));
    if (key) {
      out += m.map.get(key)!;
      at += key.length;
      last = key;
      continue;
    }
    const rest = run.slice(at);
    const suffix = NOUN_SUFFIX.find(([s]) => s === rest);
    if (suffix && out) return out + suffix[1];
    if (rest === "是" && out && TIME_ADVERBS.has(last)) return out + "는";
    return null;
  }
  return out;
}

/**
 * Read a span that carries Japanese-only character forms: 変化 is in no Korean
 * table because a Korean writer types 변화 or 變化. Mapping the characters to the
 * form the bundled word table holds and reading that keeps a single rule for
 * every span: a word we cannot read uniquely is reported, never guessed.
 */
export function readShinjitai(run: string): string | null {
  let han = "";
  let mapped = false;
  for (const char of run) {
    const korean = SHINJITAI_MAP.get(char);
    if (korean) mapped = true;
    han += korean ?? char;
  }
  if (!mapped) return null;
  return cover(han, ZH) ?? readMixedHanja(han)?.reading ?? null;
}

// Swapping words swaps the final consonant, so the particle that follows can
// end up wrong: 修改가 becomes 수정가 instead of 수정이. Only the single-syllable
// particles are repaired; 로/으로 needs two syllables and is not worth the code.
const AFTER_FINAL: Record<string, string> = { 가: "이", 는: "은", 를: "을", 와: "과" };
const AFTER_VOWEL: Record<string, string> = { 이: "가", 은: "는", 을: "를", 과: "와" };

export function fixParticle(word: string, next: string): string | null {
  // Replacement can end in a loanword (커버), and only Hangul carries a patchim.
  if (!word || !HANGUL.test(word[word.length - 1])) return null;
  const hasFinal = (word.charCodeAt(word.length - 1) - 0xac00) % 28 !== 0;
  return (hasFinal ? AFTER_FINAL : AFTER_VOWEL)[next] ?? null;
}

/** A leak site we detected but deliberately did not rewrite. */
export interface Finding {
  kind: "zh-unknown" | "ja-unknown" | "ja-shinjitai" | "ja-kana" | "zh-spaced" | "cap-trip" | "foreign-line";
  text: string;
  why: string;
}

// Bare particles and postpositions after a Han span are how Chinese proper names
// show up in Korean prose (北京市와, 深圳市처럼). They are nouns we must not guess
// at, so such a span stays out of the report. Cost: a spaced leak followed by a
// postposition goes unreported too, which is the documented blind spot.
const POSTPOS = /^(?:처럼|보다|마다|조차|마저|부터|까지|이나|이라|으로|에서|라고|라는|이랑|하고|와의|과의|으로서|으로써|이|가|을|를|은|는|의|에|도|만|께|와|과|로)/u;
// Latin characters and digits also count as attachment points for a leak.
const GLUE = /[가-힣A-Za-z0-9]/u;

const MIDDLE_DOT = /[·・]/u;
const ALL_HAN = /^\s*\p{Script=Han}+\s*$/u;

/**
 * Han characters that belong to a middle-dot citation list such as 北京·上海.
 * Splitting on whitespace keeps this linear, where matching Han runs back to back
 * over a long Han paragraph was quadratic.
 */
function citedHanCount(line: string): number {
  if (!MIDDLE_DOT.test(line)) return 0;
  let total = 0;
  for (const word of line.split(/\s+/)) {
    if (!MIDDLE_DOT.test(word)) continue;
    for (const part of word.split(MIDDLE_DOT)) {
      if (ALL_HAN.test(part)) total += part.trim().length;
    }
  }
  return total;
}

// A citation list (北京市·上海市·深圳市) is names, not leaks: skip a span that is
// joined to its neighbour by a middle dot or sits inside one.
function cited(line: string, at: number, len: number): boolean {
  const before = line.slice(0, at);
  const after = line.slice(at + len);
  return /[·・]\s*$/.test(before) || /^\s*[·・]/.test(after);
}

/** Spans the dictionary could not read, for a sentence-level rewrite step. */
export function candidates(text: string): string[] {
  return processText(text).findings
    .filter((f) => UNREADABLE.has(f.kind))
    .map((f) => f.text);
}

export interface ProcessResult {
  text: string;
  count: number;
  findings: Finding[];
}

export interface SanitizeResult {
  text: string;
  count: number;
}

// Kinds a sentence-level rewrite can still read: the dictionary saw the span and
// did not know it.
const UNREADABLE = new Set<Finding["kind"]>(["zh-unknown", "ja-unknown", "ja-shinjitai", "ja-kana", "zh-spaced"]);

const MAX_FINDINGS = 20;
const clip = (text: string) => (text.length > 40 ? `${text.slice(0, 40)}…` : text);

// A line is Japanese prose (original or quotation) when kana carries it rather
// than the Korean around it. これは…です is 5 kana against 3 Hangul; a single
// leaked新たに in a Korean heading is 2 against 5, so the leak still gets read.
const JA_KANA_MIN = 3;
const JA_DENSITY = 0.4;

function isJapaneseLine(line: string): boolean {
  const kana = line.match(KANA_ALL)?.length ?? 0;
  if (kana < JA_KANA_MIN) return false;
  const hangul = line.match(HANGUL_ALL)?.length ?? 0;
  return kana / (kana + hangul) >= JA_DENSITY;
}

const LABEL = /^(\uFEFF? {0,3}(#{1,6}[ \t]+|[-+*][ \t]+)?(?:\*\*|__)?)([\p{Script=Han}\u3040-\u30ff]+)(?:\*\*|__)?([ \t]*[:：](?:\*\*|__)?)?/u;

function japaneseHeading(line: string, nextLine: string) {
  const match = LABEL.exec(line);
  if (!match) return;
  const [matched, prefix, marker, label, colon] = match;
  const reading = readJapaneseHeading(label);
  if (!reading) return;
  const rest = line.slice(matched.length).trim();
  if (!colon && (!marker?.startsWith("#") || !/^#*$/.test(rest))) return;
  const body = (colon && rest) || nextLine;
  if (/^ {0,3}(?:#{1,6}[ \t]+|>)/u.test(body) || !/[가-힣]{2}/u.test(body) || KANA.test(body)) return;
  return { at: prefix.length, label, reading };
}

/**
 * Replace leaked Chinese and Japanese in Korean replies.
 *
 * A line written in Japanese (kana, no Hangul) is protected as a whole, and a
 * CJK span touching kana is never rewritten, so quoted Japanese survives.
 * Korean lines are processed on their own, so one Japanese leak in a heading no
 * longer disables the pass for the rest of the reply.
 *
 * Rewrites happen only when the whole span is readable from a closed vocabulary
 * and the Korean particle after it can be repaired. Anything else is returned
 * untouched and reported as a `Finding`, so an unknown leak is visible in the
 * diagnostic log instead of guessed into the reply.
 */
export interface ProcessOptions {
  /** Return true to leave a span alone: the user asked about it. */
  protect?: (span: string) => boolean;
}

export function processText(text: string, options: ProcessOptions = {}): ProcessResult {
  if (!text || !HANGUL.test(text)) return { text, count: 0, findings: [] };
  const protect = options.protect;

  const findings: Finding[] = [];
  const flag = (kind: Finding["kind"], at: string, why: string) => {
    if (findings.length < MAX_FINDINGS) findings.push({ kind, text: clip(at), why });
  };
  const distinct = new Set<string>();
  let count = 0;

  const passLine = (line: string, nextLine?: string): string => {
    const heading = nextLine === undefined ? undefined : japaneseHeading(line, nextLine);
    if (heading && !protect?.(heading.label)) {
      const { at, label, reading } = heading;
      line = line.slice(0, at) + reading + line.slice(at + label.length);
      distinct.add(label);
      count++;
    }
    // Japanese original or quotation: the line reads as Japanese.
    if (isJapaneseLine(line)) return line;
    // A line that is mostly Han is translated text the user asked to keep, not a
    // leak. The previous guard counted dictionary words, which punished exactly
    // the replies with the most leaks: four distinct words disabled the pass.
    // Names in a citation list (北京市·上海市) are not translation, so they do not
    // count towards the "mostly Han" verdict.
    const citedHan = citedHanCount(line);
    const cjk = (line.match(CJK_ALL)?.length ?? 0) - citedHan;
    if (cjk >= 8 && cjk / (cjk + (line.match(HANGUL_ALL)?.length ?? 0)) > 0.5) {
      flag("foreign-line", line, "mostly Han line, treated as translation");
      return line;
    }
    const original = line;
    line = original.replace(HAN_TOKEN, (token: string, at: number) => {
      if (!HANGUL.test(token)) return token;
      const reading = readMixedHanja(token);
      if (!reading) return token;
      // The curated translation wins over a character-by-character reading.
      const hanPrefix = /^\p{Script=Han}+/u.exec(token)?.[0] ?? "";
      if (hanPrefix && cover(hanPrefix, ZH)) return token;
      const end = at + token.length;
      if (WORD_CHAR.test(original[end] ?? "")) return token;
      // 개항(開港) is a gloss: a Hangul word, then the bracket, then the Han.
      if (GLOSS_BEFORE.test(original.slice(Math.max(0, at - 2), at)) && CLOSE.test(original[end] ?? "")) return token;
      if (cited(original, at, token.length)) return token;
      // Only a quotation that reads as Japanese is out of bounds; Korean prose may
      // quote a Hanja term and still want it read.
      if (japaneseQuotes(original).some(([start, stop]) => at >= start && end <= stop)) return token;
      const spelled = token.slice(0, reading.source.length);
      if (protect?.(token) || protect?.(reading.source) || protect?.(spelled)) return token;
      if (protect && [...reading.source.matchAll(CJK_RUN)].some(([span]) => protect(span))) return token;
      // Dictionary word readings are not evidence of a translated passage, so they
      // do not count towards the translation cap.
      count++;
      return reading.reading + token.slice(reading.source.length);
    });

    let out = "";
    let last = 0;
    const quotes = japaneseQuotes(line);
    for (const match of line.matchAll(CJK_RUN)) {
      const at = match.index ?? 0;
      const run = match[0];
      if (quotes.some(([s, e]) => at >= s && at + run.length <= e)) {
        out += line.slice(last, at) + run;
        last = at + run.length;
        continue;
      }
      out += line.slice(last, at);
      const prev = line[at - 1] ?? "";
      const after = line.slice(at + run.length);
      const next = after[0] ?? "";
      last = at + run.length;

      const gloss = GLOSS_BEFORE.test(line.slice(0, at)) && CLOSE.test(next);
      const touchesKana = KANA.test(prev) || KANA.test(next);
      const attached = GLUE.test(prev) || (HANGUL.test(next) && !POSTPOS.test(after));
      const isJapanese = KANA.test(run);
      if (gloss || touchesKana) {
        out += run;
        continue;
      }
      // A kana tail belongs to the Korean word before it, not to a Japanese
      // sentence: read it and move on. Dictionary entries win when present.
      if (KANA_MAP.has(run[0] ?? "") && !cover(run, JA) && !protect?.(run)) {
        const tailKana = kanaTail(run, prev, after);
        if (tailKana) {
          if (tailKana.trimPrev) out = out.slice(0, -1);
          out += tailKana.text;
          distinct.add(run);
          count++;
          continue;
        }
      }
      if (protect?.(run)) {
        // Content the user asked about: not a leak, and not a finding either.
        out += run;
        continue;
      }
      const m = isJapanese ? JA : ZH;
      // Japanese-only character forms are a leak wherever they appear, attached
      // or spaced, so they are reported under their own kind below.
      const shinjitai = SHINJITAI_ANY.test(run);
      // The character map reads single Han characters, so a Han word glued to a
      // Hangul noun (파일改名) has to come from the 236k word table before it is
      // a finding. A spaced span still needs context, and cited names
      // (青石·白霧·長風) stay out of reach.
      const korean =
        cover(run, m) ??
        readShinjitai(run) ??
        (isJapanese || !HANGUL.test(prev) || cited(line, at, run.length)
          ? null
          : readMixedHanja(run)?.reading ?? null);
      if (!korean) {
        // Attached spans are the leak signature. Spaced spans are reported too,
        // under their own kind, because 造字를 is a leak while 北京市처럼 is a name
        // and only context can tell them apart: the rewrite step decides, and a
        // caller that ignores `zh-spaced` sees exactly the old behaviour.
        if (attached || shinjitai) {
          flag(shinjitai ? "ja-shinjitai" : isJapanese ? "ja-unknown" : "zh-unknown", run,
            shinjitai ? "Japanese shinjitai, no word-table reading"
              : isJapanese ? "Japanese leak, no dictionary reading" : "Han leak, no dictionary reading");
        } else if (isJapanese && !HAN.test(run)) {
          // Kana alone is never Korean: no reading here, so the span is reported
          // for the rewrite step instead of vanishing from the count.
          flag("ja-kana", run, "kana run, no dictionary reading");
        } else if (!isJapanese && run.length >= 2 && run.length <= 4 && !cited(line, at, run.length)) {
          flag("zh-spaced", run, "spaced Han span, needs context");
        }
        out += run;
        continue;
      }
      const fixed = fixParticle(korean, next);
      out += fixed ? `${korean}${fixed}` : korean;
      if (fixed) last++;
      distinct.add(run);
      count++;
    }
    return out + line.slice(last);
  };

  const passPlain = (start: number, end: number): string =>
    text.slice(start, end).split("\n").map((line, index, lines) => {
      // A slice after inline code or a URL can start halfway through a real line.
      if (index === 0 && start > 0 && text[start - 1] !== "\n") return passLine(line);
      const next = lines[index + 1];
      return passLine(line, (next?.trim() ? next : lines[index + 2]) ?? "");
    }).join("\n");

  let out = "";
  let last = 0;
  for (const [start, end] of protectedRanges(text)) {
    out += passPlain(last, start) + text.slice(start, end);
    last = end;
  }
  out += passPlain(last, text.length);

  // shortcut: many distinct dictionary words suggest a translation; revisit
  // this heuristic if it suppresses changes in ordinary mixed-language replies.
  if (distinct.size > 12) {
    flag("cap-trip", [...distinct].join(" "), "over 12 distinct words, treated as translation");
    return { text, count: 0, findings: findings.slice(0, MAX_FINDINGS) };
  }
  return { text: out, count, findings };
}

/** Existing API: rewrite and report how many words were replaced. */
export function sanitize(text: string): SanitizeResult {
  const { text: fixed, count } = processText(text);
  return { text: fixed, count };
}

/** Leak sites the pass saw and deliberately did not rewrite. */
export function diagnose(text: string): Finding[] {
  return processText(text).findings;
}

/**
 * Spans the user's own message asked about, so an answer must keep them.
 *
 * A pasted document is not a question about a term: once the message is long,
 * only spans the user actually delimited (quotes, backticks, a term list) count,
 * otherwise one incidental mention would protect a word across a whole reply.
 */
export function askedSpans(message: string): (span: string) => boolean {
  if (!message) return () => false;
  const delimited = /[`"「『']([^`"」』']{1,20})[`"」』']/gu;
  const terms = new Set<string>();
  for (const m of message.matchAll(delimited)) terms.add(m[1].trim());
  // A short question is about its terms even without quotes.
  const short = message.length <= 400;
  return (span: string) => terms.has(span) || (short && message.includes(span));
}

/**
 * Offsets a rewrite must never touch, computed from the same rules the dictionary
 * pass applies: code, URLs, quotations that carry kana, Hanja glosses, and lines
 * that read as Japanese.
 *
 * The line rule matters for repeated spans: a span that leaks in one Korean
 * sentence can also sit inside a Japanese quotation further down, and replacing
 * every occurrence without this guard rewrote the quotation.
 */
export function protectedMask(text: string): (offset: number, length: number) => boolean {
  const ranges = [...protectedRanges(text)];
  for (const m of text.matchAll(QUOTED)) {
    if (!KANA.test(m[0])) continue;
    const at = m.index ?? 0;
    ranges.push([at, at + m[0].length]);
  }
  for (const m of text.matchAll(/[가-힣][([{<〔]\s*[\p{Script=Han}]+\s*[)\]}>〕]/gu)) {
    const at = m.index ?? 0;
    ranges.push([at, at + m[0].length]);
  }
  let lineStart = 0;
  for (const line of text.split("\n")) {
    if (isJapaneseLine(line)) ranges.push([lineStart, lineStart + line.length]);
    lineStart += line.length + 1;
  }
  return (offset, length) => ranges.some(([s, e]) => offset >= s && offset + length <= e);
}
