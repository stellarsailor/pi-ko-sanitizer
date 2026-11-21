import assert from "node:assert/strict";
import { test } from "node:test";
import { loadExtension } from "./load-pi.mjs";

const loaded = await loadExtension();

test("Pi loads the extension, rewrites replies, and protects code", async () => {
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  assert.deepEqual([...extension.handlers.keys()], ["message_end"]);
  const handler = extension.handlers.get("message_end")[0];
  const content = [{ type: "text", text: "설정을 修改해야 합니다.\n```js\nconst 使用=1;\n```" }];
  const result = await handler({ message: { role: "assistant", content } }, {});
  assert.equal(result.message.content[0].text, "설정을 수정해야 합니다.\n```js\nconst 使用=1;\n```");
});

test("Pi message with nothing to replace is returned untouched", async () => {
  const handler = loaded.extensions[0].handlers.get("message_end")[0];
  const content = [{ type: "text", text: "정상 답변입니다." }];
  assert.equal(await handler({ message: { role: "assistant", content } }, {}), undefined);
});
