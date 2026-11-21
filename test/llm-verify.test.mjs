import assert from "node:assert/strict";
import { test } from "node:test";
import { loadExtension } from "./load-pi.mjs";

process.env.PI_KO_SANITIZER_LLM = "1";
process.env.PI_KO_SANITIZER_LLM_TIMEOUT = "4000";
process.env.PI_KO_SANITIZER_VERIFY = "1";

const loaded = await loadExtension();

test("a valid edit is applied to the reply", async () => {
  const handler = loaded.extensions[0].handlers.get("message_end")[0];
  const prompts = [];
  const ctx = {
    model: { provider: "local", id: "fake" },
    modelRegistry: {
      hasConfiguredAuth: () => true,
      complete: async (model, context) => {
        const prompt = context.messages[0].content[0].text;
        prompts.push(prompt);
        // Phase 1 proposes, phase 2 (the meaning check) approves.
        const text = prompt.includes("checking a finished edit")
          ? '[{"span": "造字", "keep": true}]'
          : '[{"span": "造字", "reading": "조자"}]';
        return { content: [{ type: "text", text }] };
      },
    },
  };
  const text = "표기 문제로 造字를 논했다";
  const result = await handler({ message: { role: "assistant", content: [{ type: "text", text }] } }, ctx);
  assert.ok(prompts.length <= 2, `expected at most two calls, saw ${prompts.length}`);
  assert.equal(result.message.content[0].text, "표기 문제로 조자를 논했다");
});

test("phase two can veto a plausible but wrong reading", async () => {
  const handler = loaded.extensions[0].handlers.get("message_end")[0];
  const ctx = {
    model: { provider: "local", id: "fake" },
    modelRegistry: {
      hasConfiguredAuth: () => true,
      complete: async (model, context) => {
        const prompt = context.messages[0].content[0].text;
        const text = prompt.includes("checking a finished edit")
          ? '[{"span": "造字", "keep": false}]'
          : '[{"span": "造字", "reading": "조자"}]';
        return { content: [{ type: "text", text }] };
      },
    },
  };
  const text = "표기 문제로 造字를 논했다";
  const result = await handler({ message: { role: "assistant", content: [{ type: "text", text }] } }, ctx);
  assert.equal(result, undefined, "vetoed edit must leave the reply untouched");
});

test("another span in the same reply is still rewritten", async () => {
  const handler = loaded.extensions[0].handlers.get("message_end")[0];
  const ctx = {
    model: { provider: "local", id: "fake" },
    modelRegistry: {
      hasConfiguredAuth: () => true,
      complete: async (model, context) => {
        const prompt = context.messages[0].content[0].text;
        assert.ok(!prompt.includes('"造字"'), "requested span leaked into the prompt");
        const text = prompt.includes("checking a finished edit")
          ? '[{"span":"丢掉","keep":true}]'
          : '[{"span":"丢掉","reading":"버리기"}]';
        return { content: [{ type: "text", text }] };
      },
    },
    sessionManager: {
      getBranch: () => [
        { message: { role: "user", content: [{ type: "text", text: "造字의 뜻은?" }] } },
      ],
    },
  };
  const text = "造字 설명에서 丢掉 부분은 뺐다";
  const result = await handler({ message: { role: "assistant", content: [{ type: "text", text }] } }, ctx);
  assert.ok(result, "reply should have been rewritten");
  assert.match(result.message.content[0].text, /造字 설명에서/);
});

test("the dictionary pass also leaves a span the user asked about alone", async () => {
  const { processText } = await import("../src/sanitize.ts");
  const asked = "覆盖와 配额의 뜻을 알려줘";
  const out = processText("覆盖는 덮는다는 뜻이고 配额는 한도다", { protect: (s) => asked.includes(s) });
  assert.equal(out.count, 0);
  assert.match(out.text, /覆盖는 덮는다는/);
  assert.match(out.text, /配额는 한도다/);
  // Without the guard the same text is rewritten, so the guard is what changed.
  assert.equal(processText("覆盖는 덮는다는 뜻이다").count, 1);
});

test("a reply keeps the term the user asked about, end to end", async () => {
  const handler = loaded.extensions[0].handlers.get("message_end")[0];
  const ctx = {
    model: { provider: "local", id: "fake" },
    modelRegistry: { hasConfiguredAuth: () => true, complete: async () => ({ content: [] }) },
    sessionManager: {
      getBranch: () => [
        { message: { role: "user", content: [{ type: "text", text: "覆盖와 配额의 뜻은?" }] } },
      ],
    },
  };
  const text = "覆盖는 덮는다, 配额는 한도다";
  const result = await handler({ message: { role: "assistant", content: [{ type: "text", text }] } }, ctx);
  assert.equal(result, undefined, "reply must not be changed");
});
