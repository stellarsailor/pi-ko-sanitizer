import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEdits, buildPrompt, parseEdits } from "../src/rewrite.ts";

const noneProtected = () => false;

test("only Hangul readings are accepted", () => {
  const rows = [
    { span: "造字", reading: "조자" },
    { span: "造字", reading: "造字" },
    { span: "造字", reading: "abc" },
    { span: "造字", reading: "조자1" },
    { span: "造字", reading: "" },
    { span: "造字", reading: "조 자" },
  ];
  const raw = JSON.stringify(rows);
  assert.deepEqual(parseEdits(raw, ["造字"]), [
    { span: "造字", reading: "조자" },
    { span: "造字", reading: "조 자" },
  ]);
});

test("spans the model invents are dropped", () => {
  const raw = JSON.stringify([
    { span: "造字", reading: "조자" },
    { span: "不存在", reading: "없음" },
  ]);
  assert.deepEqual(parseEdits(raw, ["造字"]).map((e) => e.span), ["造字"]);
});

test("a runaway provider answer is dropped instead of parsed", () => {
  const huge = "[".repeat(300_000);
  const started = Date.now();
  assert.deepEqual(parseEdits(huge, ["造字"]), []);
  assert.ok(Date.now() - started < 100, "parser scanned an oversized answer");
});

test("a fenced or chatty answer is rejected without throwing", () => {
  assert.deepEqual(parseEdits("no json here", ["造字"]), []);
  assert.deepEqual(parseEdits("[{broken", ["造字"]), []);
  assert.deepEqual(parseEdits('{"span":"造字"}', ["造字"]), []);
  // Chatty wrapper is fine as long as a JSON array is in there.
  assert.equal(parseEdits('Sure!\n```json\n[{"span":"造字","reading":"조자"}]\n```', ["造字"]).length, 1);
});

test("numbers, dates, English and proper nouns survive a rewrite untouched", () => {
  const text = "가상 행사 SAMPLE은 2040년 1월 2일에 12건을 확인하고 造字를 기록했다.";
  const out = applyEdits(text, [{ span: "造字", reading: "조자" }], noneProtected);
  assert.equal(out.applied.length, 1);
  assert.equal(out.text, "가상 행사 SAMPLE은 2040년 1월 2일에 12건을 확인하고 조자를 기록했다.");
});

test("a span that only appears inside protected text is rejected", () => {
  const text = '인용은 "これは 造字 입니다" 이고 造字는 일반 본문이다';
  const start = text.indexOf("造字");
  const quoteGuard = (offset, len) => offset >= start && offset + len <= start + 2;
  const out = applyEdits(text, [{ span: "造字", reading: "조자" }], quoteGuard);
  // The quoted one is skipped, the plain one is rewritten.
  assert.equal(out.applied.length, 1);
  assert.match(out.text, /"これは 造字 입니다"/);
  assert.match(out.text, /조자는 일반 본문/);
});

test("an invalid first occurrence does not block a valid later one", async () => {
  const { rewriteReply } = await import("../src/rewrite.ts");
  const out = await rewriteReply(
    "첫 造字한다는 틀리고 다음 造字는 교정한다",
    ["造字"],
    async () => '[{"span":"造字","reading":"만든다"}]',
    { timeoutMs: 1000 },
    noneProtected,
  );
  assert.equal(out.text, "첫 造字한다는 틀리고 다음 만든다는 교정한다");
  assert.equal(out.replacements, 1);
});

test("a span with no safe site is reported as rejected, not applied", () => {
  const text = "造字만 있다";
  const out = applyEdits(text, [{ span: "造字", reading: "조자" }], () => true);
  assert.equal(out.applied.length, 0);
  assert.equal(out.rejected, 1);
  assert.equal(out.text, text);
});

test("a span missing from the text is rejected", () => {
  const out = applyEdits("다른 문장", [{ span: "造字", reading: "조자" }], noneProtected);
  assert.equal(out.applied.length, 0);
  assert.equal(out.rejected, 1);
});

test("the prompt names the allowed spans and forbids guessing", () => {
  const prompt = buildPrompt("표기 문제로 造字를 논했다", ["造字"]);
  assert.match(prompt, /"造字"/);
  assert.match(prompt, /Do not change any other word, number, date, name or quotation/);
  assert.match(prompt, /return \[\]/);
});

test("an earlier array in a prompt echo does not shadow the answer", () => {
  // Real failure: the reply carried the instruction line with ["也不用"] in it,
  // and parsing from the first bracket rejected the actual answer.
  const raw = 'Rules: - Use only spans from this list: ["也不用"]\n\n[{"span": "也不用", "reading": "사용하지"}]';
  assert.deepEqual(parseEdits(raw, ["也不用"]), [{ span: "也不用", reading: "사용하지" }]);
});

test("an empty answer after a bracketed prompt is an empty edit list", () => {
  const raw = 'spans: ["造字"]\n\n[]';
  assert.deepEqual(parseEdits(raw, ["造字"]), []);
});

test("a verb stem is rejected before 하다", () => {
  // Observed: 也不用하지 -> 쓰지하지. The reading must be a noun here.
  const text = "검색도 배경지식 추정也不用하지 않았고";
  const out = applyEdits(text, [{ span: "也不用", reading: "쓰지" }], noneProtected);
  assert.equal(out.applied.length, 0);
  assert.equal(out.text, text);
  const noun = applyEdits(text, [{ span: "也不用", reading: "사용" }], noneProtected);
  assert.equal(noun.applied.length, 1);
  assert.match(noun.text, /추정사용하지 않았고/);
});

test("a verb ending is still allowed when 하다 does not follow", () => {
  const text = "후보가最初부터 그대로다";
  const out = applyEdits(text, [{ span: "最初", reading: "처음" }], noneProtected);
  assert.equal(out.applied.length, 1);
  assert.match(out.text, /후보가처음부터 그대로다/);
});

test("a one-syllable reading before 하다 is rejected", () => {
  // Observed: 也不用하지 -> 도하지. Correct Korean needs the space that the
  // substitution cannot introduce.
  const text = "검색도 배경지식 추정也不用하지 않았고";
  const out = applyEdits(text, [{ span: "也不用", reading: "도" }], noneProtected);
  assert.equal(out.applied.length, 0);
});

// Cancellation: the signal must reach the provider (transport-level cancel) and
// the caller must stop waiting even when the provider ignores it.
test("the abort signal is passed to the provider and fires at the deadline", async () => {
  const { rewriteReply } = await import("../src/rewrite.ts");
  let seen = null;
  const hang = (prompt, signal) => {
    seen = signal;
    return new Promise(() => {});
  };
  const started = Date.now();
  const out = await rewriteReply("표기 문제로 造字를 논했다", ["造字"], hang, { timeoutMs: 120 }, noneProtected);
  const elapsed = Date.now() - started;
  assert.ok(seen instanceof AbortSignal, "provider did not receive a signal");
  assert.equal(seen.aborted, true, "signal was not aborted at the deadline");
  assert.equal(out.timedOut, true);
  assert.equal(out.text, "표기 문제로 造字를 논했다");
  assert.ok(elapsed < 2000, `waited ${elapsed}ms past a 120ms budget`);
});

test("a result that arrives after the deadline is dropped", async () => {
  const { rewriteReply } = await import("../src/rewrite.ts");
  // Provider ignores abort and answers late with a valid-looking edit.
  const late = () =>
    new Promise((resolve) => setTimeout(() => resolve('[{"span":"造字","reading":"조자"}]'), 400));
  const out = await rewriteReply("표기 문제로 造字를 논했다", ["造字"], late, { timeoutMs: 100 }, noneProtected);
  assert.equal(out.timedOut, true);
  assert.equal(out.applied.length, 0);
  assert.equal(out.text, "표기 문제로 造字를 논했다");
});

test("a provider error keeps the original text", async () => {
  const { rewriteReply } = await import("../src/rewrite.ts");
  const boom = () => Promise.reject(new Error("provider down"));
  const out = await rewriteReply("표기 문제로 造字를 논했다", ["造字"], boom, { timeoutMs: 500 }, noneProtected);
  assert.equal(out.text, "표기 문제로 造字를 논했다");
  assert.equal(out.applied.length, 0);
  assert.equal(out.timedOut, true, "a rejected call is reported as a timeout, not as a quiet success");
});

// The meaning check is a second call, and it must be able to say no.
const twoPhase = (proposal, verdict) => {
  let call = 0;
  return async () => {
    call++;
    return call === 1 ? proposal : verdict;
  };
};

test("the verifier can reject a plausible but wrong reading", async () => {
  const { rewriteReply } = await import("../src/rewrite.ts");
  // 固化的 fix is a shape-clean noun, so only the meaning check can stop it.
  const call = twoPhase('[{"span":"固化","reading":"딱딱"}]', '[{"span":"固化","keep":false}]');
  const out = await rewriteReply("값을固化해야 한다", ["固化"], call, { timeoutMs: 2000, verify: true }, noneProtected);
  assert.equal(out.applied.length, 0);
  assert.equal(out.text, "값을固化해야 한다", "a rejected reading must not be written");
  assert.equal(out.verified, 1, "the edit did reach verification");
});

test("a native numeral is required for 一 + measure word", async () => {
  const { rewriteReply, riskyReading } = await import("../src/rewrite.ts");
  assert.equal(riskyReading("일층", "에서", "一层"), true);
  assert.equal(riskyReading("한 층", "에서", "一层"), false);
  const call = twoPhase('[{"span":"一层","reading":"일층"}]', '[{"span":"一层","keep":true}]');
  const out = await rewriteReply("상위一层에서 안내", ["一层"], call, { timeoutMs: 2000 }, noneProtected);
  // Even with a permissive verifier, 일층 is dropped before it can be applied.
  assert.equal(out.applied.length, 0);
  assert.equal(out.verified, 0);
});

test("a verifier that omits an edit reverts it", async () => {
  const { rewriteReply } = await import("../src/rewrite.ts");
  const call = twoPhase('[{"span":"固化","reading":"고정"}]', "[]");
  const out = await rewriteReply("값을固化해야 한다", ["固化"], call, { timeoutMs: 2000, verify: true }, noneProtected);
  assert.equal(out.applied.length, 0);
});

test("a verifier that approves an edit applies it", async () => {
  const { rewriteReply } = await import("../src/rewrite.ts");
  const call = twoPhase('[{"span":"固化","reading":"고정"}]', '[{"span":"固化","keep":true}]');
  const out = await rewriteReply("값을固化해야 한다", ["固化"], call, { timeoutMs: 2000, verify: true }, noneProtected);
  assert.equal(out.applied.length, 1);
  assert.equal(out.text, "값을고정해야 한다");
});

test("a verifier that times out reverts the edit", async () => {
  const { rewriteReply } = await import("../src/rewrite.ts");
  let call = 0;
  const call2 = () => {
    call++;
    if (call === 1) return Promise.resolve('[{"span":"固化","reading":"고정"}]');
    return new Promise(() => {});
  };
  const out = await rewriteReply("값을固化해야 한다", ["固化"], call2, { timeoutMs: 600, verify: true }, noneProtected);
  assert.equal(out.applied.length, 0);
  assert.equal(out.text, "값을固化해야 한다");
});

test("the misleading shapes are dropped before the second call", async () => {
  const { riskyReading } = await import("../src/rewrite.ts");
  assert.equal(riskyReading("아무도", "가 아니라"), true);
  assert.equal(riskyReading("정도", "가 문제"), false);
  assert.equal(riskyReading("베이스", "에서"), false);
});

test("detection only ever offers CJK spans, so English terms are never edited", async () => {
  const { candidates, processText } = await import("../src/sanitize.ts");
  const text = "React의 useEffect와 v1.2.3 빌드, HTTP/2 헤더와 造字를 확인했다";
  const spans = candidates(text);
  assert.deepEqual(spans, ["造字"]);
  assert.equal(processText(text).text, text, "dictionary pass left the Latin text alone");
  for (const span of spans) assert.match(span, /^[\p{Script=Han}\u3040-\u30ff]+$/u);
});

test("a reading that flips the final consonant repairs the particle", () => {
  const text = "서머타임을跨는 소스가 섞인다";
  const out = applyEdits(text, [{ span: "跨", reading: "걸침" }], noneProtected);
  assert.equal(out.applied.length, 1);
  // 걸침 ends in ㅁ, so 는 must become 은.
  assert.match(out.text, /걸침은 소스가/);
});

test("the six reviewed failures are all rejected", async () => {
  const { shapeProblem } = await import("../src/rewrite.ts");
  const cases = [
    ["일층", "에서", "一层", "wrong sense: floor for layer"],
    ["단계적으로", " 직렬로", "段的", "wrong part of speech"],
    ["아무도", "가 아니라", "没人", "double particle"],
    ["나눈다", "한다", "分开", "doubled verb"],
    ["충족", "는지", "満た", "noun where a verb form is needed"],
    ["충족하는", "는지", "満た", "swallowed the following ending"],
  ];
  for (const [reading, after, span, why] of cases) {
    assert.ok(shapeProblem(reading, after, span), `not rejected (${why}): ${reading} + ${after}`);
  }
});

test("the correct readings for the same sites still pass", async () => {
  const { shapeProblem } = await import("../src/rewrite.ts");
  for (const [reading, after, span] of [
    ["한 층", "에서", "一层"],
    ["단계의", " 직렬로", "段的"],
    ["고정", "해야 한다", "固化"],
    ["나누는", "다", "分开"],
    ["충족하", "는지", "満た"],
  ]) {
    assert.equal(shapeProblem(reading, after, span), null, `wrongly rejected: ${reading} + ${after}`);
  }
});

test("a reading that repeats the following syllable or particle is rejected", async () => {
  const { shapeProblem } = await import("../src/rewrite.ts");
  assert.equal(shapeProblem("지표로", "으로 봐야", "指标的"), "duplicated particle");
  assert.equal(shapeProblem("소품", "품 연속", "小品"), "duplicated syllable");
  // The same sites with a clean reading still pass.
  assert.equal(shapeProblem("지표", "으로 봐야", "指标的"), null);
  assert.equal(shapeProblem("소품", " 연속", "小品"), null);
});

test("a single kana span is never rewritten", async () => {
  const { shapeProblem } = await import("../src/rewrite.ts");
  // か → 까 produced 정할까**의 and か → 인가 produced 정할인가**의.
  // か is a Japanese particle, so the shared guard rejects it before the tail rule.
  assert.equal(shapeProblem("까", "**의 문제", "か"), "japanese particle");
  assert.equal(shapeProblem("인가", "**의 문제", "か"), "japanese particle");
  assert.equal(shapeProblem("는지", "의 문제", "か"), "japanese particle");
  // A kana word of two or more characters is still fair game.
  assert.equal(shapeProblem("트라이", " 없이", "トライ"), null);
});

test("a vowel-final reading before 아/어 is rejected as a broken contraction", async () => {
  const { shapeProblem } = await import("../src/rewrite.ts");
  // 扱 → 다루 + 아야 gave 다루아야 instead of 다뤄야.
  assert.equal(shapeProblem("다루", "아야 한다", "扱"), "contraction needed");
  assert.equal(shapeProblem("다뤄", "야 한다", "扱"), null);
});

test("a wrong-sense reading with clean shape is a documented limit", async () => {
  const { shapeProblem } = await import("../src/rewrite.ts");
  // 小品 → 조사 has the right shape and the wrong meaning; nothing deterministic
  // can tell it from a correct reading, so it stays a known miss.
  assert.equal(shapeProblem("조사", "품 연속", "小品"), null);
  assert.equal(shapeProblem("소품", " 연속", "小品"), null);
});

// Position-based application: one edit must reach every unprotected occurrence,
// and a protected occurrence between them must survive.
test("a repeated span is replaced at every unprotected occurrence", () => {
  const text = "실행한다 실행한다 \"실행한다\" 실행한다";
  const quoteGuard = (offset, length) => offset >= 10 && offset + length <= 16;
  const out = applyEdits(text, [{ span: "실행", reading: "집행" }], quoteGuard);
  assert.equal(out.count, 3, "three unprotected occurrences");
  assert.equal(out.text, '집행한다 집행한다 "실행한다" 집행한다');
  assert.equal(out.applied.length, 1);
});

test("replacement offsets are not shifted by earlier edits", () => {
  // A shorter reading before a later site must not move that site.
  const text = "以上的以上、大多数が大多数";
  const out = applyEdits(text, [{ span: "以上", reading: "이상" }], noneProtected);
  // The Han between the two sites is not part of the span and must survive.
  assert.equal(out.text, "이상的이상、大多数が大多数");
  assert.equal(out.count, 2);
});

test("a text with no occurrence counts as rejected, not as applied", () => {
  const out = applyEdits("다른 문장", [{ span: "造字", reading: "조자" }], noneProtected);
  assert.equal(out.count, 0);
  assert.equal(out.applied.length, 0);
  assert.equal(out.rejected, 1);
});

test("all occurrences disappearing is what the scorer calls a fix", () => {
  const text = "코드 코드 코드";
  const out = applyEdits(text, [{ span: "코드", reading: "코드" }], noneProtected);
  // Same reading: the count still reports the three sites.
  assert.equal(out.count, 3);
});

test("a reading that swallowed a multi-character ending is rejected", async () => {
  const { shapeProblem } = await import("../src/rewrite.ts");
  // 以上 → 이상입니다 with 입니다 still in the text made 이상입니다입니다.
  assert.equal(shapeProblem("이상입니다", "입니다. 제공된", "以上"), "duplicated ending");
  assert.equal(shapeProblem("이상", "이 주어진", "以上"), null);
  // Two-character overlap is enough to catch it; short legitimate endings pass.
  assert.equal(shapeProblem("다뤄", "야 한다", "扱"), null);
});

test("a duplicate proposal for the same offset is counted once", () => {
  const edit = { span: "造字", reading: "조자" };
  const result = applyEdits("첫 표에 造字 항목을 넣었습니다.", [edit, { ...edit }], noneProtected);
  assert.equal(result.count, 1);
  assert.equal(result.text, "첫 표에 조자 항목을 넣었습니다.");
});

test("the same span at two offsets still replaces both", () => {
  const text = "当初 일정과 当初 물량";
  const out = applyEdits(
    text,
    [
      { span: "当初", reading: "당초" },
      { span: "当初", reading: "당초" },
    ],
    noneProtected,
  );
  assert.equal(out.count, 2);
  assert.equal(out.text, "당초 일정과 당초 물량");
});

test("a single kana is allowed only as a name tail", async () => {
  const { shapeProblem } = await import("../src/rewrite.ts");
  // 카즈マ: glued to Hangul, followed by a Korean particle.
  assert.equal(shapeProblem("마", "에게 말했다", "マ", "즈"), null);
  // Same span where the context is not a Korean name.
  assert.equal(shapeProblem("마", "에게", "マ", " "), "single kana is a particle");
  assert.equal(shapeProblem("까", "**의", "か", "할"), "japanese particle");
  assert.equal(shapeProblem("인가", "**의 문제", "か", "할"), "japanese particle");
});
