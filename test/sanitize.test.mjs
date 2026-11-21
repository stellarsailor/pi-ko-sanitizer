import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitize } from "../src/sanitize.ts";
import { LEXICON } from "../src/lexicon.ts";

test("replaces leaked Chinese words with their Korean equivalent", () => {
  assert.deepEqual(sanitize("설정을 修改해야 합니다"), { text: "설정을 수정해야 합니다", count: 1 });
  assert.deepEqual(sanitize("需要 추가 확인"), { text: "필요 추가 확인", count: 1 });
});

test("longest key wins", () => {
  assert.equal(sanitize("您的 요청을 확인했습니다").text, "귀하의 요청을 확인했습니다");
});

test("fenced code keeps its bytes", () => {
  const text = "이렇게 하세요:\n```js\nconst 使用 = 修改;\n```\n끝입니다.";
  assert.deepEqual(sanitize(text), { text, count: 0 });
});

test("inline code and URLs keep their bytes", () => {
  const text = "`使用` 변수와 https://예시.kr/修改/使用 링크입니다.";
  assert.deepEqual(sanitize(text), { text, count: 0 });
});

test("text containing Japanese kana is left alone", () => {
  const text = "これは 修改 입니다";
  assert.deepEqual(sanitize(text), { text, count: 0 });
});

test("text without Hangul is left alone", () => {
  const text = "修改这个函数";
  assert.deepEqual(sanitize(text), { text, count: 0 });
});

test("more than three matches is a translated sentence, not a leak", () => {
  const text = "我们 可以 修改 使用 需要";
  assert.deepEqual(sanitize(text), { text, count: 0 });
});

test("hanja glosses in Korean prose survive", () => {
  const text = "개항(開港) 이후 채권(債權) 정리";
  assert.deepEqual(sanitize(text), { text, count: 0 });
});

test("count matches the number of replaced words", () => {
  const result = sanitize("이 버튼은 按钮, 저건 页面입니다.");
  assert.equal(result.count, 2);
  assert.equal(result.text, "이 버튼은 버튼, 저건 페이지입니다.");
});

test("three matches still convert, four stop the whole block", () => {
  assert.equal(sanitize("按钮 하고 页面 하고 表格").count, 3);
  assert.deepEqual(sanitize("按钮 页面 表格 菜单"), { text: "按钮 页面 表格 菜单", count: 0 });
});

test("every key is Han-only, at least two characters, and unique", () => {
  const seen = new Set();
  for (const [key] of LEXICON) {
    assert.match(key, /^[\p{Script=Han}]{2,}$/u, `bad key: ${key}`);
    assert.ok(!seen.has(key), `duplicate key: ${key}`);
    seen.add(key);
  }
});

test("particles are repaired when the replacement changes the final consonant", () => {
  assert.equal(sanitize("修改가 필요합니다").text, "수정이 필요합니다");
  assert.equal(sanitize("使用를 위해").text, "사용을 위해");
  assert.equal(sanitize("修改이 필요합니다").text, "수정이 필요합니다");
  assert.equal(sanitize("按钮은 클릭").text, "버튼은 클릭");
  assert.equal(sanitize("按钮이 클릭").text, "버튼이 클릭");
});

test("a word repeated four times is still a leak, not a translation", () => {
  // Prompt previews echo the user's prompt into the reply, doubling a match;
  // the cap counts distinct words so the repeat does not disable the whole block.
  const result = sanitize("Prompt: 설정을 修改해야\n\n설정을 修改해야 합니다. 按钮도 按钮입니다.");
  assert.equal(result.count, 4);
  assert.equal(result.text, "Prompt: 설정을 수정해야\n\n설정을 수정해야 합니다. 버튼도 버튼입니다.");
});
