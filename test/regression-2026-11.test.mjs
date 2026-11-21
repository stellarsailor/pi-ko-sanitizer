import assert from "node:assert/strict";
import { test } from "node:test";
import { JAPANESE_LEAKS } from "../src/lexicon.ts";
import { applyEdits, shapeProblem } from "../src/rewrite.ts";
import { askedSpans, candidates, diagnose, processText, protectedMask, sanitize } from "../src/sanitize.ts";

// Synthetic cases only. Do not paste inputs or outputs from a real session.
test("Japanese prose does not block correction on a separate Korean line", () => {
  const japanese = "ひらがなを読みます。";
  assert.equal(sanitize(`${japanese}\n서식을 修改하세요.`).text, `${japanese}\n서식을 수정하세요.`);
});

test("a time word can take the copula but an unrelated dictionary word cannot", () => {
  assert.equal(sanitize("目前是 시험 단계입니다.").text, "현재는 시험 단계입니다.");
  assert.equal(sanitize("按钮是 확인하지 않습니다.").text, "按钮是 확인하지 않습니다.");
});

test("dictionary coverage includes possessive suffixes and particle repair", () => {
  const result = sanitize("类型的 규칙과 修改가 필요합니다.");
  assert.deepEqual(result, { text: "타입의 규칙과 수정이 필요합니다.", count: 2 });
});

test("more than three distinct dictionary words can be corrected", () => {
  assert.equal(sanitize("표에서 修改, 使用, 按钮, 页面 항목을 찾아 주세요.").count, 4);
});

test("a Han-heavy line is preserved and marked as foreign prose", () => {
  const text = "这是用来展示一段中文内容的例句입니다.";
  assert.equal(processText(text).text, text);
  assert.equal(diagnose(text)[0].kind, "foreign-line");
});

test("unknown spans are not rewritten by the dictionary", () => {
  const text = "새 용어固化를 표에 추가했습니다.";
  const result = processText(text);
  assert.equal(result.text, text);
  assert.deepEqual(diagnose(text), result.findings);
  assert.deepEqual(candidates(text), ["固化"]);
});

test("unknown spans next to digits and Latin are candidates", () => {
  assert.deepEqual(candidates("12固化와 ABC固化를 표시합니다."), ["固化", "固化"]);
});

test("a spaced unknown span can be a candidate", () => {
  assert.deepEqual(candidates("화면에 固化 항목이 있습니다."), ["固化"]);
});

test("a single unknown Han character is detected but not removed", () => {
  const text = "표에罕을 그대로 적습니다.";
  assert.equal(sanitize(text).text, text);
  assert.deepEqual(candidates(text), ["罕"]);
});

test("middle-dot citation lists are not correction candidates", () => {
  const text = "기호 표기 목록: 青石·白霧·長風.";
  assert.equal(sanitize(text).text, text);
  assert.deepEqual(candidates(text), []);
});

test("Hanja glosses are protected even when the word is in the dictionary", () => {
  const text = "앞 문장의 수정(修改) 표기를 확인합니다.";
  assert.equal(sanitize(text).text, text);
  assert.ok(protectedMask(text)(text.indexOf("修改"), "修改".length));
});

test("code, URLs, and kana quotations keep their original bytes", () => {
  const text = '예시: `使用`, https://example.test/修改, "これは 修改 です".';
  assert.equal(sanitize(text).text, text);
});

test("a model edit does not touch a repeated span on a Japanese line", () => {
  const text = "화면에 固化 항목이 있습니다.\nこれは固化です。";
  const edited = applyEdits(text, [{ span: "固化", reading: "고정" }], protectedMask(text));
  assert.equal(edited.text, "화면에 고정 항목이 있습니다.\nこれは固化です。");
});

test("short questions protect terms the user asks about", () => {
  const protect = askedSpans("使用라는 단어는 무슨 뜻인가요?");
  assert.equal(processText("여기서 使用는 설명할 단어입니다.", { protect }).count, 0);
});

test("long inputs protect only explicitly delimited terms", () => {
  const protect = askedSpans(`사용 예시입니다. `.repeat(60) + "確認 `使用`");
  assert.equal(protect("使用"), true);
  assert.equal(protect("確認"), false);
});

test("Japanese lexicon keys are distinct and include kana", () => {
  const keys = JAPANESE_LEAKS.map(([key]) => key);
  assert.equal(new Set(keys).size, keys.length);
  for (const key of keys) {
    assert.ok(key.length >= 2);
    assert.match(key, /[\u3040-\u30ff]/u);
  }
});

test("short kana tails and a final nasal can attach to Hangul names", () => {
  assert.equal(sanitize("가상 인물 모모ナ에게 인사했습니다.").text, "가상 인물 모모나에게 인사했습니다.");
  assert.equal(sanitize("모모ン과 인사했습니다.").text, "모몬과 인사했습니다.");
});

test("standalone kana, Japanese particles, and name tails in code are untouched", () => {
  for (const text of ["ナナ를 보았습니다.", "모모は 여기에 있습니다.", "테스트 값은 `모모ナ`입니다."]) {
    assert.equal(sanitize(text).text, text);
  }
  assert.equal(shapeProblem("하", " 여기에 있습니다.", "は", "모"), "japanese particle");
});
