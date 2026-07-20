// Pure presentation helpers — HTML escaping and lightweight markdown rendering.
// No DOM, no state, no network, no other app modules: safe to import anywhere.
// Extracted from app.js as the first module-split increment.

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Display label for an entity/aggregate identifier. The raw identifier is the
// source of truth everywhere (model keys, $refs, gen_ table names, codegen, data
// keys); this is the single hook for prettifying the text the user reads. With
// no model-supplied overrides it passes the name through verbatim — nothing is
// hard-coded to any particular model.
export function prettyEntity(name) {
  return name;
}

// Inline formatting: bold, italic, inline code. Operates on already-escaped HTML.
export function renderInline(escaped) {
  return escaped
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1<i>$2</i>')
    .replace(/`([^`]+?)`/g, '<code class="bg-stone-100 px-1 py-0.5 rounded text-[12px] mono">$1</code>');
}

// Render a markdown table block. Lines are pre-escaped raw lines.
export function renderTable(lines) {
  // Lines: ["| h1 | h2 |", "|---|---|", "| r1 | r2 |", ...]
  const split = (l) => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
  const header = split(lines[0]);
  const rows = lines.slice(2).map(split);
  const thead = `<tr>${header.map((h) => `<th class="text-left font-semibold px-2 py-1 border-b border-stone-300 bg-stone-50">${renderInline(h)}</th>`).join("")}</tr>`;
  const tbody = rows.map((r) => `<tr>${r.map((c) => `<td class="px-2 py-1 border-b border-stone-100 align-top">${renderInline(c)}</td>`).join("")}</tr>`).join("");
  return `<div class="overflow-x-auto my-2"><table class="text-[12px] w-full border-collapse"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`;
}

export function renderTextContent(text) {
  const lines = escapeHtml(text).split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Skip blank lines between blocks
    if (line.trim() === "") { i++; continue; }
    // Table: line starts with | and the next line is a separator (|---|---|)
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s\-:|]+\|?\s*$/.test(lines[i + 1])) {
      const tableLines = [line];
      i++;
      while (i < lines.length && /^\s*\|/.test(lines[i])) { tableLines.push(lines[i]); i++; }
      blocks.push(renderTable(tableLines));
      continue;
    }
    // Horizontal rule
    if (/^---+\s*$/.test(line)) { blocks.push('<hr class="my-2 border-stone-200" />'); i++; continue; }
    // Heading
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      const lvl = h[1].length;
      const cls = lvl <= 2 ? "text-sm font-semibold mt-2 mb-1" : "text-[13px] font-semibold mt-2 mb-1 text-stone-700";
      blocks.push(`<div class="${cls}">${renderInline(h[2])}</div>`);
      i++;
      continue;
    }
    // Unordered list (consecutive lines starting with - or *)
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(`<ul class="list-disc ml-5 my-1 space-y-0.5">${items.map((it) => `<li>${renderInline(it)}</li>`).join("")}</ul>`);
      continue;
    }
    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push(`<ol class="list-decimal ml-5 my-1 space-y-0.5">${items.map((it) => `<li>${renderInline(it)}</li>`).join("")}</ol>`);
      continue;
    }
    // Paragraph — collect consecutive non-empty, non-special lines
    const paraLines = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !/^\s*\|/.test(lines[i]) && !/^---+\s*$/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push(`<p class="my-1">${renderInline(paraLines.join("<br>"))}</p>`);
  }
  return blocks.join("");
}
