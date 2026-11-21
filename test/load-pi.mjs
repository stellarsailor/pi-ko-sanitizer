import { fileURLToPath } from "node:url";

export async function loadExtension() {
  const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const { loadExtensions } = await import(new URL("./core/extensions/loader.js", piEntry));
  const dir = fileURLToPath(new URL("../src/", import.meta.url));
  return loadExtensions([fileURLToPath(new URL("../src/index.ts", import.meta.url))], dir);
}
