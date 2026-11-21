import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

export function readWordTable(name: "hanja" | "japanese-headings"): string {
  try {
    return gunzipSync(readFileSync(new URL(`./data/${name}.tsv.gz`, import.meta.url))).toString("utf8");
  } catch {
    // A missing supplemental table must not drop or delay the reply.
    return "";
  }
}
