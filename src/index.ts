import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { preloadWordTables } from "./hanja.ts";
import { processText, candidates, askedSpans, protectedMask, type Finding } from "./sanitize.ts";
import { rewriteReply } from "./rewrite.ts";

// Uncertain leaks go here, never into the reply. One JSON object per line.
const LOG = join(homedir(), ".pi", "agent", "logs", "ko-sanitizer-diag.jsonl");
const MAX_LOG = 512 * 1024;
const DEBUG = Boolean(process.env.PI_KO_SANITIZER_DEBUG);
// Raw leak text is off by default: the log is a counter, not a copy of the
// reply. Set PI_KO_SANITIZER_LOG_TEXT=1 when you need to read the spans.
const LOG_TEXT = process.env.PI_KO_SANITIZER_LOG_TEXT === "1";
// The sentence-level rewrite costs a model round trip per reply, so it is opt-in.
const LLM = process.env.PI_KO_SANITIZER_LLM === "1";
// PI_KO_SANITIZER_OFF=1 loads the package but does not edit or log replies.
const OFF = process.env.PI_KO_SANITIZER_OFF === "1";
const VERIFY = process.env.PI_KO_SANITIZER_VERIFY === "1";
const LLM_TIMEOUT_MS = Number(process.env.PI_KO_SANITIZER_LLM_TIMEOUT ?? 12000);
const LLM_MAX_SPANS = 8;
const LLM_MAX_CHARS = 6000;

// The log holds model text inside 40-character windows, so a key that rode
// along in a reply would be written to disk. Nothing here is worth that risk:
// anything shaped like a credential becomes a marker before it is logged.
const SECRET = new RegExp(
  [
    // vendor prefixes with a separator, anchored so task_manager stays text
    "\\b(?:sk|ghp|gho|ghu|ghs|ghr|glpat|xox[abprs])[-_][A-Za-z0-9_-]{6,}",
    "(?:AKIA|ASIA|AIza)[A-Za-z0-9_-]{8,}|ya29\\.[A-Za-z0-9_\\-]{8,}",
    "eyJ[A-Za-z0-9_\\-.]{10,}",
    "\\b(?:[A-Za-z0-9]{3,}[_-])?(?:api[_-]?key|apikey|access[_-]?token|access[_-]?key|secret[_-]?key|client[_-]?secret|password|passwd|pwd)\\b\\s*[=:]\\s*\\S+",
    "\\bbearer\\s+[A-Za-z0-9._-]{8,}",
    "\\b\\d{8,10}:AA[A-Za-z0-9_-]{30,}",
  ].join("|"),
  "gi",
);

export function redact(value: unknown): string {
  const text = String(value ?? "");
  return text.replace(SECRET, (m) => `<redacted:${m.slice(0, 4)}…${m.length}>`);
}

function safe(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(safe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, safe(v)]));
  }
  return value;
}

function log(record: Record<string, unknown>) {
  const line = JSON.stringify(safe(record));
  try {
    if (statSync(LOG).size > MAX_LOG) renameSync(LOG, `${LOG}.1`);
    appendFileSync(LOG, `${line}\n`);
  } catch {
    try {
      mkdirSync(dirname(LOG), { recursive: true });
      appendFileSync(LOG, `${line}\n`);
    } catch {
      // A missing diagnostic log must never cost the user their reply.
    }
  }
}

/** Store a fingerprint of the leak instead of the leak itself. */
export function findingRecord(finding: Finding): Record<string, unknown> {
  const digest = createHash("sha1").update(finding.text).digest("hex").slice(0, 10);
  return LOG_TEXT
    ? { kind: finding.kind, len: finding.text.length, digest, text: redact(finding.text) }
    : { kind: finding.kind, len: finding.text.length, digest };
}

// The user asked about a term, so the answer must keep it: 造字 in a question about
// Chinese characters is content, not a leak. Read the last user message from the
// session and treat every span it mentions as untouchable.
function lastUserText(ctx: ExtensionContext): string {
  try {
    const entries = ctx.sessionManager?.getBranch?.() ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const message = (entries[i] as { message?: { role?: string; content?: unknown } }).message;
      if (!message || message.role !== "user") continue;
      const parts = Array.isArray(message.content) ? message.content : [];
      return parts
        .filter((p): p is { type: "text"; text: string } => (p as { type?: string }).type === "text")
        .map((p) => p.text)
        .join("\n");
    }
  } catch {
    // A missing session must not stop the pass.
  }
  return "";
}

async function rewritePart(
  text: string,
  spans: string[],
  ctx: ExtensionContext,
  protect: (span: string) => boolean,
): Promise<{ text: string; applied: number; ms: number; timedOut: boolean }> {
  const model = ctx.model;
  if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
    return { text, applied: 0, ms: 0, timedOut: false };
  }
  const base = protectedMask(text);
  const guard = (offset: number, length: number) =>
    base(offset, length) || protect(text.slice(offset, offset + length));
  const outcome = await rewriteReply(
    text,
    spans,
    async (prompt, signal) => {
      // The signal must reach the provider: that is what cancels the HTTP request.
      const response = await ctx.modelRegistry.complete(
        model,
        { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
        { signal, sessionId: `ko-sanitizer-${Date.now()}` },
      );
      return response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    },
    { timeoutMs: LLM_TIMEOUT_MS, verify: VERIFY },
    guard,
  );
  return { text: outcome.text, applied: outcome.applied.length, ms: outcome.ms, timedOut: outcome.timedOut };
}

export default function (pi: ExtensionAPI) {
  // The tables cost about 250 ms to build; pay it while Pi finishes starting.
  setImmediate(preloadWordTables);
  let replaced = 0;
  let flagged = 0;
  let rewritten = 0;

  pi.on("message_end", async ({ message }, ctx) => {
    if (OFF || message.role !== "assistant") return;
    let changed = 0;
    const found: Finding[] = [];
    const protect = askedSpans(lastUserText(ctx));
    const content = message.content.map((part) => {
      if (part.type !== "text") return part;
      const result = processText(part.text, { protect });
      changed += result.count;
      found.push(...result.findings);
      return result.count ? { ...part, text: result.text } : part;
    });
    replaced += changed;
    flagged += found.length;

    // Sentence-level rewrite: only for leaks the dictionary could not read, one
    // attempt, and the reply is kept if the model fails or answers off-contract.
    let llm = { applied: 0, ms: 0, timedOut: 0 };
    if (LLM && found.length) {
      const perPart = content.filter((p) => p.type === "text");
      const totalChars = perPart.reduce((n, p) => n + p.text.length, 0);
      if (totalChars <= LLM_MAX_CHARS) {
        try {
          for (const [index, part] of content.entries()) {
            if (part.type !== "text") continue;
            const spans = [...new Set(candidates(part.text).filter((span) => !protect(span)))].slice(0, LLM_MAX_SPANS);
            if (!spans.length) continue;
            const out = await rewritePart(part.text, spans, ctx, protect);
            llm = { applied: out.applied, ms: out.ms, timedOut: Number(out.timedOut) };
            if (out.text !== part.text) content[index] = { ...part, text: out.text };
            rewritten += out.applied;
            break;
          }
        } catch (error) {
          // Fail open: the dictionary result stands, the reply is never lost.
          if (DEBUG) log({ t: new Date().toISOString(), pid: process.pid, msg: "llm-error", error: String(error).slice(0, 120) });
        }
      }
    }

    log({
      t: new Date().toISOString(),
      pid: process.pid,
      msg: "reply",
      chars: content.reduce((n, p) => n + (p.type === "text" ? p.text.length : 0), 0),
      changed,
      flagged: found.length,
      llmApplied: llm.applied,
      llmMs: llm.ms,
      llmTimedOut: llm.timedOut,
    });
    if (DEBUG) log({ t: new Date().toISOString(), pid: process.pid, msg: "inspect", parts: content.length });
    if (found.length) log({ t: new Date().toISOString(), pid: process.pid, msg: "findings", count: found.length, findings: found.map(findingRecord) });
    const touched = changed > 0 || llm.applied > 0;
    if (!touched) return;
    return { message: { ...message, content } };
  });

  // The package is judged by how often it fires, so the counter ships with it.
  pi.registerCommand("zh-ko", {
    description: "Show replaced, flagged and rewritten counts for this session",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`replaced ${replaced}, flagged ${flagged}, rewritten ${rewritten} (log: ${LOG})`, "info");
    },
  });
}
