// Documentation fetch for the chat agent's fetch_docs tool: pull one PUBLIC web
// page (API reference / developer docs) so the connector builder can ground its
// instructions in the vendor's real field and endpoint names instead of guessing.
//
// Security posture mirrors the authored-adapter ctx.fetch, tightened where that
// path is known-weak: the SSRF guard runs on EVERY redirect hop (not just the
// initial URL), only http(s) is allowed, and the body is metered while it is
// read — a Content-Length check alone would pass an unbounded chunked response.

import { assertSafeUrl } from "../packs/net-guard.js";

const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 1_500_000; // download cap, metered per chunk
const MAX_TEXT_CHARS = 40_000;    // what the model actually gets back

/** Strip an HTML page to readable text. Pure (unit-testable). Deliberately
 * simple — good enough for documentation pages; not a general HTML parser. */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script\s*>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style\s*>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // Block-level boundaries become newlines so headings/paragraphs stay legible.
  s = s.replace(/<\s*br\s*\/?\s*>/gi, "\n");
  s = s.replace(/<\/\s*(p|div|li|tr|h[1-6]|section|article|pre|blockquote|table)\s*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  // Decode &amp; LAST: a doubly-escaped entity ("&amp;lt;" — routine in API docs
  // showing escaped XML/code examples) must decode exactly one level ("&lt;"),
  // not collapse all the way to "<".
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
    })
    .replace(/&amp;/gi, "&");
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function assertHttpUrl(url: string): URL {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`fetch_docs: invalid URL ${JSON.stringify(url)}`); }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`fetch_docs: only http(s) URLs are allowed (got ${u.protocol})`);
  }
  return u;
}

/** Read a response body with a hard byte cap, metering as chunks arrive. */
async function readCapped(res: Response): Promise<{ bytes: Uint8Array; capped: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0), capped: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let capped = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
      if (total >= MAX_BODY_BYTES) {
        capped = true;
        await reader.cancel().catch(() => {});
        break;
      }
    }
  }
  const out = new Uint8Array(Math.min(total, MAX_BODY_BYTES));
  let offset = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, out.byteLength - offset);
    if (take <= 0) break;
    out.set(take === c.byteLength ? c : c.subarray(0, take), offset);
    offset += take;
  }
  return { bytes: out, capped };
}

export interface FetchDocsResult {
  url: string;          // the final URL after redirects
  status: number;
  contentType: string;
  truncated: boolean;
  text: string;
}

/** Fetch one public documentation page and return its readable text. Throws on
 * invalid/blocked URLs, non-text content, network errors, and timeouts — the
 * chat tool layer surfaces the message to the model as a tool error. */
export async function fetchDocs(url: string): Promise<FetchDocsResult> {
  let current = assertHttpUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let res: Response | null = null;
    for (let hop = 0; ; hop++) {
      await assertSafeUrl(current.href);
      res = await fetch(current.href, {
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "text/html, text/plain, application/json;q=0.9, */*;q=0.5" },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) break;
        if (hop >= MAX_REDIRECTS) throw new Error("fetch_docs: too many redirects");
        // Re-validate the NEXT hop — a public page redirecting to an internal
        // address must be blocked, same as if it had been requested directly.
        current = assertHttpUrl(new URL(location, current).href);
        continue;
      }
      break;
    }
    const contentType = (res!.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const textual =
      contentType.startsWith("text/") ||
      contentType.includes("json") ||
      contentType.includes("xml") ||
      contentType.includes("javascript") ||
      contentType === "";
    if (!textual) {
      await res!.body?.cancel().catch(() => {});
      throw new Error(`fetch_docs: unsupported content-type "${contentType}" — only text/HTML/JSON documentation pages can be read`);
    }
    const { bytes, capped } = await readCapped(res!);
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const text = contentType.includes("html") || /^\s*</.test(raw.slice(0, 200)) ? htmlToText(raw) : raw.trim();
    const truncated = capped || text.length > MAX_TEXT_CHARS;
    return {
      url: current.href,
      status: res!.status,
      contentType: contentType || "unknown",
      truncated,
      text: text.slice(0, MAX_TEXT_CHARS),
    };
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error(`fetch_docs: timed out after ${TIMEOUT_MS / 1000}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
