import assert from "node:assert/strict";
import { test } from "node:test";
import { loadExtension } from "./load-pi.mjs";

process.env.PI_KO_SANITIZER_LLM = "1";
process.env.PI_KO_SANITIZER_LLM_TIMEOUT = "150";

const loaded = await loadExtension();

// A model that never answers is the case that must not cost the user anything.
const hangingCtx = () => ({
  model: { provider: "local", id: "fake" },
  modelRegistry: {
    hasConfiguredAuth: () => true,
    complete: () => new Promise(() => {}),
  },
});

test("a hanging model call leaves the dictionary result and returns quickly", async () => {
  const handler = loaded.extensions[0].handlers.get("message_end")[0];
  const text = "표기 문제로 造字를 논했고 覆盖도 확인했다";
  const started = Date.now();
  const result = await handler({ message: { role: "assistant", content: [{ type: "text", text }] } }, hangingCtx());
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3000, `handler waited ${elapsed}ms`);
  assert.ok(result, "dictionary fix should still be returned");
  assert.match(result.message.content[0].text, /커버도 확인했다/);
  assert.match(result.message.content[0].text, /造字를/, "unread span must stay as it was");
});

test("a model reply that violates the contract is ignored", async () => {
  const handler = loaded.extensions[0].handlers.get("message_end")[0];
  const ctx = {
    model: { provider: "local", id: "fake" },
    modelRegistry: {
      hasConfiguredAuth: () => true,
      complete: async () => ({ content: [{ type: "text", text: "죄송합니다, 바꿀 것이 없습니다." }] }),
    },
  };
  const text = "표기 문제로 造字를 논했다";
  const result = await handler({ message: { role: "assistant", content: [{ type: "text", text }] } }, ctx);
  assert.equal(result, undefined, "no dictionary fix and no valid edit means no message replacement");
});

test("a span the user asked about is never rewritten", async () => {
  const handler = loaded.extensions[0].handlers.get("message_end")[0];
  let asked = 0;
  const ctx = {
    model: { provider: "local", id: "fake" },
    modelRegistry: {
      hasConfiguredAuth: () => true,
      complete: async () => {
        asked++;
        return { content: [{ type: "text", text: '[{"span":"造字","reading":"조자"}]' }] };
      },
    },
    sessionManager: {
      getBranch: () => [
        { message: { role: "user", content: [{ type: "text", text: "造字의 뜻을 알려줘" }] } },
      ],
    },
  };
  const text = "표기 문제로 造字를 논했다";
  const result = await handler({ message: { role: "assistant", content: [{ type: "text", text }] } }, ctx);
  assert.equal(asked, 0, "model was called for a span the user asked about");
  assert.equal(result, undefined, "reply was changed although the span was requested by the user");
});

