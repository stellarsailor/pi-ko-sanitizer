import assert from "node:assert/strict";
import { test } from "node:test";
import { loadExtension } from "./load-pi.mjs";

process.env.PI_KO_SANITIZER_OFF = "1";

const loaded = await loadExtension();

test("PI_KO_SANITIZER_OFF=1 loads the package but leaves replies untouched", async () => {
  assert.deepEqual(loaded.errors, []);
  const handler = loaded.extensions[0].handlers.get("message_end")[0];
  const content = [{ type: "text", text: "설정을 修改해야 합니다. 전 갤러리를覆盖 중이다." }];
  assert.equal(await handler({ message: { role: "assistant", content } }, {}), undefined);
});
