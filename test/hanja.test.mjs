import assert from "node:assert/strict";
import { test } from "node:test";
import { askedSpans, processText, sanitize } from "../src/sanitize.ts";

for (const [name, input, expected, count] of [
  ["mixed stems", "표를 調사하고 조査 결과를 정리했습니다.", "표를 조사하고 조査 결과를 정리했습니다.", 1],
  ["word-initial readings after a space", "예문에서 歷사를 보고 連결을 확인합니다.", "예문에서 역사를 보고 연결을 확인합니다.", 2],
  ["word-initial readings in both directions", "자료를 利용하고 例외를 알려 주세요.", "자료를 이용하고 예외를 알려 주세요.", 2],
  ["a vowel or final nieun before ryeol and ryul", "비율과 比율을 보고 계열과 系열을 확인합니다.", "비율과 비율을 보고 계열과 계열을 확인합니다.", 2],
  ["other finals keep the reading", "확률과 確률을 보고 직렬과 直렬을 확인합니다.", "확률과 확률을 보고 직렬과 직렬을 확인합니다.", 2],
  ["compatibility ideographs", "과제를 檢색하고 歷사 문서를 열었습니다.", "과제를 검색하고 역사 문서를 열었습니다.", 2],
  ["a Han word with a Korean particle", "그 連結은 중요합니다.", "그 연결은 중요합니다.", 1],
  ["untouched text is not normalized", "각도 ①은 표의 調사 항목에 표시됩니다.", "각도 ①은 표의 조사 항목에 표시됩니다.", 1],
]) {
  test(`Hanja reading handles ${name}`, () => {
    assert.deepEqual(sanitize(input), { text: expected, count });
  });
}

test("a word with two plausible readings is left alone", () => {
  const text = "표의 行렬과 行列을 확인합니다.";
  assert.deepEqual(sanitize(text), { text, count: 0 });
});

test("phonetic fallback leaves unknown words, partial matches, and all-Han words alone", () => {
  const text = "원문은 連結을 쓰고 調사진, ABC調사, 社조도 표시합니다.";
  assert.deepEqual(sanitize(text), { text: "원문은 연결을 쓰고 調사진, ABC調사, 社조도 표시합니다.", count: 1 });
});

test("mixed-script phonetic fallback leaves code, links, and quoted wording alone", () => {
  const text = '예시: `調사`, https://example.test/調사, “調사”, 조사(調사), 調사·연結.';
  assert.deepEqual(sanitize(text), { text, count: 0 });
});

test("a mixed spelling the user explicitly asked about is not rewritten", () => {
  const protect = askedSpans("설명입니다. ".repeat(65) + "`調사`가 어떤 표기인가요?");
  const text = "이 사례에는 調사가 적혀 있습니다.";
  assert.equal(processText(text, { protect }).text, text);
});
