import assert from "node:assert/strict";
import { test } from "node:test";
import { findingRecord, redact } from "../src/pi-ko-sanitizer.ts";

// Construct invalid credential-shaped inputs, not copies of any actual values.
const dummy = "fake".repeat(10);
const inputs = [
  `sk-${dummy}`,
  `ghp_${dummy}`,
  `glpat-${dummy}`,
  `xoxb-${dummy}`,
  `AKIA${dummy}`,
  `AIza${dummy}`,
  `ya29.${dummy}`,
  `eyJ${dummy}.fake.fake`,
  `demo_api_key=${dummy}`,
  `Authorization: Bearer ${dummy}`,
  `0000000000:AA${dummy}`,
];

test("credential-shaped strings are redacted without keeping the payload", () => {
  for (const input of inputs) {
    const output = redact(input);
    assert.match(output, /<redacted:/);
    assert.ok(!output.includes(dummy));
  }
});

test("ordinary text and reserved example URLs are not redacted", () => {
  for (const text of ["task_manager", "작업 이름을 입력하세요.", "https://example.test/status"]) {
    assert.equal(redact(text), text);
  }
});

test("findings are represented by a consistent fingerprint by default", () => {
  const finding = { kind: "zh-unknown", text: "固化", why: "synthetic fixture" };
  const record = findingRecord(finding);
  assert.deepEqual(Object.keys(record).sort(), ["digest", "kind", "len"]);
  assert.equal(record.len, 2);
  assert.match(record.digest, /^[0-9a-f]{10}$/);
  assert.equal(record.digest, findingRecord(finding).digest);
});
