// fetch_docs: the chat agent's documentation reader. No network in these tests —
// they cover the pure HTML→text stripper and the guard rails that must reject a
// URL before any request is made (protocol allowlist, SSRF block on literal
// private IPs — the same posture as the authored ctx.fetch, applied up front).

import { describe, it, expect, vi, afterEach } from "vitest";
import { htmlToText, fetchDocs } from "../../src/chat/fetch-docs.js";

describe("htmlToText", () => {
  it("drops script/style/comments, keeps block structure as newlines, decodes entities", () => {
    const html = [
      "<html><head><style>.x{color:red}</style><script>alert('no')</script></head>",
      "<body><!-- hidden --><h1>Deals API</h1>",
      "<p>List deals with <code>GET /v1/deals</code>.</p>",
      "<ul><li>id &amp; title</li><li>value &gt; 0</li></ul>",
      "</body></html>",
    ].join("");
    const text = htmlToText(html);
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("hidden");
    expect(text).toContain("Deals API");
    expect(text).toContain("GET /v1/deals");
    expect(text).toContain("id & title");
    expect(text).toContain("value > 0");
    // Block boundaries survive as line breaks (h1 vs the paragraph).
    expect(text.indexOf("Deals API")).toBeLessThan(text.indexOf("List deals"));
    expect(text).toMatch(/Deals API\n/);
  });

  it("decodes numeric entities and collapses whitespace runs", () => {
    expect(htmlToText("A&#65;   B\n\n\n\nC")).toBe("AA B\n\nC");
  });

  it("decodes doubly-escaped entities exactly ONE level (API docs show escaped code samples)", () => {
    expect(htmlToText("&amp;lt;GetDeals&amp;gt; &amp;#65; &amp;quot;x&amp;quot;")).toBe('&lt;GetDeals&gt; &#65; &quot;x&quot;');
  });
});

describe("fetchDocs guard rails (no network)", () => {
  it("rejects an unparseable URL", async () => {
    await expect(fetchDocs("not a url")).rejects.toThrow(/invalid URL/);
  });

  it("rejects non-http(s) protocols", async () => {
    await expect(fetchDocs("file:///etc/passwd")).rejects.toThrow(/only http\(s\)/);
    await expect(fetchDocs("ftp://example.com/docs")).rejects.toThrow(/only http\(s\)/);
  });

  it("blocks literal private / loopback / metadata addresses before any request", async () => {
    await expect(fetchDocs("http://127.0.0.1/docs")).rejects.toThrow(/blocked/);
    await expect(fetchDocs("http://10.0.0.5/internal")).rejects.toThrow(/blocked/);
    await expect(fetchDocs("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/blocked/);
  });
});

// The load-bearing hardening over the known-weak ctx.fetch posture is per-HOP
// redirect re-validation — pin it with a stubbed fetch so a refactor to
// redirect:"follow" can't silently reopen redirect-based SSRF. Public LITERAL
// IPs are used as hostnames so assertSafeUrl never does a DNS lookup.
describe("fetchDocs redirect + body handling (stubbed fetch, no network)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("re-validates EVERY redirect hop — a public page redirecting to the metadata IP is blocked unfetched", async () => {
    const stub = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }));
    vi.stubGlobal("fetch", stub);
    await expect(fetchDocs("http://8.8.8.8/api")).rejects.toThrow(/blocked/);
    expect(stub).toHaveBeenCalledTimes(1); // the private hop itself is never requested
  });

  it("gives up after too many redirects", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: `http://8.8.8.8/hop-${n++}` } })));
    await expect(fetchDocs("http://8.8.8.8/start")).rejects.toThrow(/too many redirects/);
  });

  it("rejects binary content types", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("PDFDATA", { status: 200, headers: { "content-type": "application/pdf" } })));
    await expect(fetchDocs("http://8.8.8.8/file.pdf")).rejects.toThrow(/unsupported content-type/);
  });

  it("returns stripped text for an HTML page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("<html><body><h1>API</h1><p>GET /v1/things</p></body></html>", {
        status: 200, headers: { "content-type": "text/html; charset=utf-8" },
      })));
    const r = await fetchDocs("http://8.8.8.8/api");
    expect(r.status).toBe(200);
    expect(r.contentType).toBe("text/html");
    expect(r.truncated).toBe(false);
    expect(r.text).toContain("GET /v1/things");
  });
});
