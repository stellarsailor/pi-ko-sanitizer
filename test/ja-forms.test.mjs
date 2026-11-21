import assert from "node:assert/strict";
import { test } from "node:test";
import { SHINJITAI } from "../src/lexicon.ts";
import { readWordTable } from "../src/word-data.ts";
import { candidates, diagnose, processText, sanitize } from "../src/sanitize.ts";

const HAN = /\p{Script=Han}/u;

// Synthetic cases only. Do not paste inputs or outputs from a real session.
test("a Japanese-only character form is read through the word table", () => {
  assert.deepEqual(sanitize("메모리 총変化 를 확인했습니다"), {
    text: "메모리 총변화 를 확인했습니다",
    count: 1,
  });
  assert.equal(sanitize("総括 하겠습니다").text, "총괄 하겠습니다");
  assert.equal(sanitize("経済 상태 확인").text, "경제 상태 확인");
});

test("a shinjitai span the table cannot read is reported, not guessed", () => {
  // 団体 is 團體, which the bundled table does not hold.
  const text = "파일 団体 목록";
  const result = processText(text);
  assert.equal(result.text, text);
  assert.equal(result.count, 0);
  assert.deepEqual(diagnose(text).map((f) => f.kind), ["ja-shinjitai"]);
  assert.deepEqual(candidates(text), ["団体"]);
});

test("kana alone is a leak the dictionary reports", () => {
  const text = "함수는 テスト 를 통과했습니다";
  assert.equal(processText(text).text, text);
  assert.deepEqual(diagnose(text).map((f) => f.kind), ["ja-kana"]);
  assert.deepEqual(candidates(text), ["テスト"]);
});

test("a Japanese quotation keeps its character forms", () => {
  const text = "인용하면 「変化を見ます」 입니다";
  assert.deepEqual(sanitize(text), { text, count: 0 });
});

test("code and URLs keep their character forms", () => {
  const text = "`変化` 값과 https://예시.kr/変化 링크입니다";
  assert.deepEqual(sanitize(text), { text, count: 0 });
});

// Data checks: a wrong pair is a wrong word, so the bundled table decides.
test("every shinjitai maps a single Japanese form onto a Hanja the table holds", () => {
  const sources = readWordTable("hanja");
  const keys = new Set();
  for (const [japanese, hanja] of SHINJITAI) {
    assert.equal([...japanese].length, 1, `${japanese} is not a single character`);
    assert.equal([...hanja].length, 1, `${hanja} is not a single character`);
    assert.notEqual(japanese, hanja, `${japanese} needs no mapping`);
    assert.ok(HAN.test(japanese), `${japanese} is not Han`);
    assert.ok(HAN.test(hanja), `${hanja} is not Han`);
    assert.ok(sources.includes(hanja), `${hanja} is in no table entry`);
    assert.ok(!keys.has(japanese), `${japanese} is listed twice`);
    keys.add(japanese);
  }
});
