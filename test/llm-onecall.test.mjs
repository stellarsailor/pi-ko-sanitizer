import assert from "node:assert/strict";
import { test } from "node:test";
import { loadExtension } from "./load-pi.mjs";

process.env.PI_KO_SANITIZER_LLM = "1";
process.env.PI_KO_SANITIZER_LLM_TIMEOUT = "4000";
process.env.PI_KO_SANITIZER_VERIFY = "0";

const loaded = await loadExtension();

test("the shipped configuration makes exactly one model call per reply", async () => {
  // Verification is opt-in; with it off a reply must never be billed twice.
  const handler = loaded.extensions[0].handlers.get("message_end")[0];
  let calls = 0;
  const ctx = {
    model: { provider: "local", id: "fake" },
    modelRegistry: {
      hasConfiguredAuth: () => true,
      complete: async () => {
        calls++;
        return { content: [{ type: "text", text: '[{"span":"造字","reading":"조자"}]' }] };
      },
    },
    sessionManager: { getBranch: () => [] },
  };
  const content = [
    { type: "text", text: "표기 문제로 造字와 丢掉를 논했다" },
    { type: "toolCall", id: "example", name: "example", arguments: {} },
    { type: "text", text: "같은 造字 설명을 다시 읽었다" },
  ];
  const result = await handler({ message: { role: "assistant", content } }, ctx);
  assert.equal(calls, 1);
  assert.match(result.message.content[0].text, /조자와/);
  assert.equal(result.message.content[1], content[1]);
  assert.equal(result.message.content[2], content[2]);
});
