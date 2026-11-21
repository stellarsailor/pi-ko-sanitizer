// Sentence-level rewrite for spans no dictionary can read.
//
// The model never regenerates the reply. It is asked for span→reading pairs, and
// this module applies them to the original string, so numbers, dates, English,
// proper nouns, code and citations cannot be lost by construction: a replacement
// is only written where a Han/kana span already stood.

import { fixParticle, isJapaneseGrammar } from "./sanitize.ts";

/** One accepted rewrite: the leaked span and the Korean that replaces it. */
export interface Edit {
  span: string;
  reading: string;
}

export interface ApplyResult {
  text: string;
  /** Distinct edits that were written at least once. */
  applied: Edit[];
  /** Every occurrence that was actually replaced. */
  count: number;
  /** Distinct edits that had no safe site. */
  rejected: number;
}

const HANGUL_ONLY = /^[가-힣][가-힣 ]*$/u;
// A span followed by 하다 needs a noun, not a conjugated verb: 也不用하지 with the
// reading 쓰지 produced 쓰지하지. The model answered for the word alone.
const VERB_END = /(?:지|다|고|서|며|면|게)$/u;
// A reading that already ends in a particle cannot take another one: 아무도 + 가
// produced 아무도가. Adverb endings glued before a noun are the other shape that
// reads fine in isolation and wrong in the sentence.
// 아무도 가 아니라: these pronouns never take a case particle. A closed list beats
// a suffix rule, because 정도가 / 수도가 are correct Korean and a suffix rule
// would revert them.
const NO_PARTICLE = new Set(["아무도", "누구도", "무엇도", "어디도", "아무것도", "아무데도"]);
const ADVERB_END = /(?:히|적으로|스레|되게)$/u;
const STARTS_PARTICLE = /^(?:이|가|을|를|은|는|의|에|도|만|와|과|로)\b/u;
const NEXT_PARTICLE = /^(?:이|가|을|를|은|는|의|에|도|만|와|과|로|께|에서|으로)/u;
const MAX_READING = 20;
const MAX_EDITS = 12;

export function buildPrompt(text: string, spans: string[]): string {
  return [
    "You are a Korean copy editor. The text below was written in Korean but a few",
    "Chinese or Japanese words leaked into it.",
    "Return ONLY a JSON array. Each item is {\"span\": <the exact leaked substring>,",
    "\"reading\": <natural Korean for it>}.",
    "Rules:",
    "- Use only spans from this list: " + JSON.stringify(spans),
    "- A span you are not sure about: omit it. Do not guess.",
    "- The reading must be Hangul only. No Han, kana, Latin letters or digits.",
    "- Do not change any other word, number, date, name or quotation.",
    "- If nothing should change, return [].",
    "",
    "TEXT:",
    text,
  ].join("\n");
}

/**
 * Pull a JSON array out of whatever the model wrapped it in.
 *
 * Scans from the last `[` backwards: a reply can carry an earlier array in a
 * quote or a prompt echo, and taking the first bracket silently parsed that one
 * and rejected every edit.
 */
export function parseEdits(raw: string, allowed: string[]): Edit[] {
  const starts: number[] = [];
  for (let i = raw.indexOf("["); i >= 0; i = raw.indexOf("[", i + 1)) starts.push(i);
  let parsed: unknown;
  for (let k = starts.length - 1; k >= 0; k--) {
    const end = raw.indexOf("]", starts[k]);
    if (end < 0) continue;
    try {
      const candidate = JSON.parse(raw.slice(starts[k], end + 1));
      if (Array.isArray(candidate)) {
        parsed = candidate;
        break;
      }
    } catch {
      // not this one, try an earlier bracket
    }
  }
  if (!Array.isArray(parsed)) return [];
  const ok = new Set(allowed);
  const edits: Edit[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const span = (item as { span?: unknown }).span;
    const reading = (item as { reading?: unknown }).reading;
    if (typeof span !== "string" || typeof reading !== "string") continue;
    if (!ok.has(span)) continue;
    if (!HANGUL_ONLY.test(reading) || reading.length > MAX_READING) continue;
    if (edits.length >= MAX_EDITS) break;
    edits.push({ span, reading });
  }
  return edits;
}

/**
 * Apply span→reading pairs to `text`.
 *
 * `protectedAt` answers "is this offset inside a region a rewrite must not
 * touch" (code, URL, kana quotation, Hanja gloss). A span that only appears
 * inside such a region is rejected rather than edited.
 */
export function applyEdits(
  text: string,
  edits: Edit[],
  protectedAt: (offset: number, length: number) => boolean,
): ApplyResult {
  // Positions are resolved once, on the original string, then written right to
  // left so an earlier replacement can never shift a later offset. Searching the
  // mutating string with indexOf fixed only the first occurrence, which lost the
  // second and third 执行 in a reply.
  type Site = { at: number; edit: Edit };
  const sites: Site[] = [];
  // The model sometimes proposes the same span twice. Writing it twice is
  // idempotent, but counting it twice made the replacement total disagree with
  // the number of positions that actually changed.
  const seen = new Set<string>();
  let rejected = 0;

  for (const edit of edits) {
    if (!edit.span || !text.includes(edit.span)) {
      rejected++;
      continue;
    }
    let from = 0;
    let found = 0;
    for (;;) {
      const at = text.indexOf(edit.span, from);
      if (at < 0) break;
      from = at + edit.span.length;
      if (protectedAt(at, edit.span.length)) continue;
      if (shapeProblem(edit.reading, text.slice(at + edit.span.length), edit.span, text[at - 1] ?? "")) continue;
      const slot = `${edit.span}@${at}`;
      if (seen.has(slot)) continue;
      seen.add(slot);
      // The same span can sit in two sentences, but one answer came back for it.
      // Sites whose surface differs enough to read differently are filtered by
      // the shape rules above; identical occurrences share one reading.
      sites.push({ at, edit });
      found++;
    }
    if (!found) rejected++;
  }

  sites.sort((a, b) => b.at - a.at);
  let out = text;
  const applied: Edit[] = [];
  for (const site of sites) {
    const { edit, at } = site;
    const next = out[at + edit.span.length] ?? "";
    // Particles follow nouns. A verb form (충족하는, 나눈다) must not get one.
    const verbish =
      VERB_END.test(edit.reading) || VERB_MODIFIER.test(edit.reading) || VERB_STEM.test(edit.reading);
    const fixed = next && !verbish ? fixParticle(edit.reading, next) : null;
    const tail = fixed ?? "";
    out = out.slice(0, at) + edit.reading + tail + out.slice(at + edit.span.length + tail.length);
    if (!applied.includes(edit)) applied.push(edit);
  }

  return { text: out, applied, count: sites.length, rejected };
}

/**
 * Deterministic shape checks that need no model call. They catch the readings
 * that are grammatical on their own and wrong in the sentence: a double particle
 * (아무도 + 가) or an adverb glued where the sentence needs a noun.
 */
// 一 + measure word takes a native numeral in Korean: 一层 is 한 층, not 일층.
// Sino-Korean numerals there are the exact shape of a plausible wrong reading.
const NATIVE_COUNTER = /^[一二三][个次种条项名层处回遍份件台辆间]/u;
const NATIVE_READING = /^(?:한|두|세|네|몇)\s?/u;

// The embedded-question endings need a verb form: 満た는지 → 충족는지 is broken
// because 충족 is a noun. A noun reading there is the tell.
const NEEDS_VERB = /^(?:는지|은지|을지|던지|면서|으면서)/u;
// A verb ending where the sentence continues with 하다 doubles the verb:
// 分开한다 → 나눈다한다.
// 한다 starts with 한, not 하: the 하-family is 하/한/합/했/해.
const DOUBLES_VERB = /^(?:하|한|합|했|해)/u;
// A modifier form (충족하는) satisfies the embedded-question ending.
const VERB_MODIFIER = /(?:는|던|한|할|인|될|쓸|줄|볼)$/u;
// A bare stem that takes 하/해 directly (충족하 + 는지) is a verb form too.
const VERB_STEM = /(?:하|해|되|되하|시키)$/u;

/** Why a reading cannot be written at this position, or null when it may be. */
export function shapeProblem(reading: string, after: string, span = "", prev = ""): string | null {
  if (DOUBLES_VERB.test(after) && (VERB_END.test(reading) || reading.length === 1)) return "verb doubles 하다";
  if (NEEDS_VERB.test(after) && !VERB_END.test(reading) && !VERB_MODIFIER.test(reading) && !VERB_STEM.test(reading)) {
    return "verb form needed";
  }
  // A kana span answered with one syllable is a particle guess: か → 까 left
  // 정할까의, which is not Korean. A kana word never becomes one syllable.
  // A single kana is usually a grammatical particle (か, は, の), and translating
  // it produced 정할인가. The one safe case is a name tail: glued to a Hangul word
  // and followed by a Korean particle or punctuation.
  // The dictionary layer refuses a Japanese particle outright; this layer must
  // refuse the same set so a model cannot read a Japanese particle as a name tail.
  if (span && /^[\u3040-\u30ff]{1,3}$/u.test(span) && isJapaneseGrammar(span)) {
    return "japanese particle";
  }
  if (span && /^[\u3040-\u30ff]$/u.test(span)) {
    const tail = /[가-힣]/u.test(prev) && (/[가-힣]/u.test(after[0] ?? "") || /^[\s,.!?"')\]:;~…—]/u.test(after));
    if (!tail) return "single kana is a particle";
  }
  // A vowel-final reading before 아/어/여 needs contraction that a substitution
  // cannot do: 扱 → 다루 + 아야 gave 다루아야 instead of 다뤄야.
  if (/^[아어여]/u.test(after) && /[가-힣]/u.test(reading.at(-1) ?? "")) {
    const last = reading.charCodeAt(reading.length - 1);
    if ((last - 0xac00) % 28 === 0) return "contraction needed";
  }
  // The reading swallowed a whole suffix that is still in the text: 以上 →
  // 이상입니다 + 입니다 made 이상입니다입니다.
  for (let k = 2; k <= 4; k++) {
    const overlap = after.slice(0, k);
    if (overlap.length === k && reading.endsWith(overlap)) return "duplicated ending";
  }
  // The reading already swallowed the ending that follows it: 충족하는 + 는지,
  // 小品 → 소품 + 품.
  if (reading.length >= 2 && /[가-힣]/u.test(reading.at(-1) ?? "") && reading.at(-1) === after[0]) {
    return "duplicated syllable";
  }
  // A reading that already carries a particle cannot be followed by another one:
  // 指标的 → 지표로 + 으로.
  if (/(?:으로|로|에서|에게|부터|까지|보다|처럼|에는|에도)$/u.test(reading) && NEXT_PARTICLE.test(after)) {
    return "duplicated particle";
  }
  if (riskyReading(reading, after, span)) return "shape";
  return null;
}

export function riskyReading(reading: string, after: string, span = ""): boolean {
  const next = after[0] ?? "";
  if (!next) return false;
  if (NO_PARTICLE.has(reading) && NEXT_PARTICLE.test(after)) return true;
  if (STARTS_PARTICLE.test(reading)) return true;
  // An adverb reading is almost always the wrong part of speech where a noun or
  // verb belongs: 段的 → 단계적으로. Rejecting the shape costs few good edits.
  if (ADVERB_END.test(reading)) return true;
  if (span && NATIVE_COUNTER.test(span) && !NATIVE_READING.test(reading)) return true;
  return false;
}

/**
 * Second opinion on meaning, not shape. The first call answers "what does this
 * word say"; this one answers "does the sentence still say the same thing after
 * the swap", which is the question that catches 일층 for 一层.
 */
export function buildVerifyPrompt(text: string, edits: Edit[]): string {
  return [
    "You are a Korean copy editor checking a finished edit.",
    "For each replacement, decide whether the Korean sentence still means what the",
    "original sentence meant, and whether the replacement is grammatical in place.",
    "Return ONLY a JSON array of {\"span\": <the span>, \"keep\": true|false}.",
    "Use keep:true when the reading is grammatical in place and keeps the meaning",
    "of the original word. Use keep:false only when you can name what breaks: a",
    "different sense (一层 as 일층 instead of 한 층), a different part of speech, or",
    "spacing and particles that the sentence no longer supports.",
    "A missing entry is treated as keep:false.",
    "",
    "EDITS:",
    JSON.stringify(edits.map((e) => ({ span: e.span, reading: e.reading }))),
    "",
    "SENTENCE AFTER EDIT:",
    text,
  ].join("\n");
}

/** Spans the verifier explicitly approved. Everything else is reverted. */
export function parseKeep(raw: string, spans: string[]): Set<string> {
  const starts: number[] = [];
  for (let i = raw.indexOf("["); i >= 0; i = raw.indexOf("[", i + 1)) starts.push(i);
  const allowed = new Set(spans);
  for (let k = starts.length - 1; k >= 0; k--) {
    const end = raw.indexOf("]", starts[k]);
    if (end < 0) continue;
    try {
      const parsed: unknown = JSON.parse(raw.slice(starts[k], end + 1));
      if (!Array.isArray(parsed)) continue;
      const keep = new Set<string>();
      for (const item of parsed) {
        const span = (item as { span?: unknown })?.span;
        const ok = (item as { keep?: unknown })?.keep;
        if (typeof span === "string" && allowed.has(span) && ok === true) keep.add(span);
      }
      return keep;
    } catch {
      // try an earlier bracket
    }
  }
  return new Set();
}

export interface RewriteOptions {
  timeoutMs: number;
  /** Optional meaning check; it costs another call and can reject valid readings. */
  verify?: boolean;
}

export interface RewriteOutcome {
  text: string;
  applied: Edit[];
  /** Distinct edits the model proposed and this module accepted. */
  proposed: number;
  /** Occurrences actually replaced. */
  replacements: number;
  rejected: number;
  ms: number;
  timedOut: boolean;
  /** Edits that went through the meaning check. */
  verified: number;
}

/**
 * Ask a model for span→reading pairs, then patch the original string.
 *
 * The abort signal is handed to the caller so the provider request is cancelled
 * at the transport, not merely ignored: a raced promise would leave the request
 * running and the tokens burning. A result that arrives after the deadline is
 * dropped rather than applied.
 */
export async function rewriteReply(
  text: string,
  spans: string[],
  callModel: (prompt: string, signal: AbortSignal) => Promise<string>,
  options: RewriteOptions,
  protectedAt: (offset: number, length: number) => boolean,
): Promise<RewriteOutcome> {
  const started = Date.now();
  const keep = (outcome?: Partial<RewriteOutcome>): RewriteOutcome => ({
    text,
    applied: [],
    proposed: 0,
    replacements: 0,
    rejected: 0,
    ms: Date.now() - started,
    timedOut: false,
    verified: 0,
    ...outcome,
  });
  if (!spans.length) return keep();

  const budget = Math.max(1, options.timeoutMs);
  const deadlineAt = started + budget;
  const remaining = () => deadlineAt - Date.now();

  const ask = async (prompt: string): Promise<string | null> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("rewrite deadline"));
      }, Math.max(1, remaining()));
    });
    try {
      return await Promise.race([callModel(prompt, controller.signal), deadline]);
    } catch {
      controller.abort();
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const raw = await ask(buildPrompt(text, spans));
  if (raw === null) return keep({ timedOut: true });
  const proposed = parseEdits(raw, spans);
  if (!proposed.length) return keep();

  const direct = applyEdits(text, proposed, protectedAt);
  const shaped = direct.applied;
  if (!shaped.length) return keep({ proposed: proposed.length, rejected: proposed.length });

  if (!options.verify) {
    return {
      text: direct.text,
      applied: direct.applied,
      proposed: proposed.length,
      replacements: direct.count,
      rejected: proposed.length - direct.applied.length,
      ms: Date.now() - started,
      timedOut: false,
      verified: 0,
    };
  }

  // Second call: meaning and grammar in place. No answer means no edit, because
  // the cost of a plausible wrong word is higher than the cost of leaving a leak.
  if (remaining() < 300) return keep({ proposed: proposed.length, rejected: proposed.length });
  const verdict = await ask(buildVerifyPrompt(direct.text, shaped));
  if (verdict === null) return keep({ proposed: proposed.length, rejected: proposed.length, timedOut: true });
  const approved = parseKeep(verdict, shaped.map((e) => e.span));
  const finalEdits = shaped.filter((e) => approved.has(e.span));
  if (!finalEdits.length) {
    return keep({ proposed: proposed.length, rejected: proposed.length, verified: shaped.length });
  }

  const result = applyEdits(text, finalEdits, protectedAt);
  return {
    text: result.text,
    applied: result.applied,
    proposed: proposed.length,
    replacements: result.count,
    rejected: proposed.length - result.applied.length,
    ms: Date.now() - started,
    timedOut: false,
    verified: shaped.length,
  };
}
