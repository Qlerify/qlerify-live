// Org Admin page (#admin) — general/members/roles/markings/environments/
// workspaces/workflows/audit tabs. Extracted from app.js.

import { state } from "./state.js";
import { escapeHtml } from "./format.js";
import { AUTH, api, navigate, render, currentOrgName } from "./app.js";

// --- Org Admin page --------------------------------------------------------

export async function loadAdmin() {
  const tab = state.admin?.tab || "general";
  const orgId = state.me?.organizationId;
  const [members, roles, markings, environments, workspaces, workflows, audit, anthropic, qlerify] = await Promise.all([
    api("/v1/members").catch(() => []),
    api("/v1/role-assignments").catch(() => []),
    api("/v1/markings").catch(() => []),
    api("/v1/environments").catch(() => []),
    api("/v1/workspaces").catch(() => []),
    api("/v1/workflows").catch(() => []),
    api("/v1/audit?limit=60").catch(() => []),
    orgId ? api(`/v1/organizations/${encodeURIComponent(orgId)}/anthropic-config`).catch(() => null) : Promise.resolve(null),
    orgId ? api(`/v1/organizations/${encodeURIComponent(orgId)}/qlerify-config`).catch(() => null) : Promise.resolve(null),
  ]);
  state.admin = { tab, members, roles, markings, environments, workspaces, workflows, audit, anthropic, qlerify };
  render();
}

// One-time display of a freshly issued temporary password (member invite or admin
// reset). Held in state.issuedCredential, never refetched — cleared on dismiss or
// any navigation, so the secret doesn't linger on screen.
function issuedCredentialBanner() {
  const c = state.issuedCredential;
  if (!c) return "";
  return `
    <div class="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5">
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="text-sm font-medium text-amber-900">Temporary password for <span class="mono">${escapeHtml(c.subject)}</span></div>
          <div class="mt-1.5 flex items-center gap-2">
            <code class="mono text-sm bg-white border border-amber-200 rounded px-2 py-1 select-all">${escapeHtml(c.password)}</code>
            <button id="issued-copy" class="text-xs px-2 py-1 rounded border border-amber-300 text-amber-800 hover:bg-amber-100">Copy</button>
          </div>
          <div class="text-xs text-amber-700 mt-1.5">Shown once. Share it over a secure channel; the member must change it on first sign-in.</div>
        </div>
        <button id="issued-dismiss" aria-label="Dismiss" class="text-amber-700 hover:text-amber-900 text-lg leading-none">×</button>
      </div>
    </div>`;
}

const ADMIN_TABS = [["general", "General"], ["members", "Members"], ["roles", "Roles"], ["markings", "Markings"], ["environments", "Environments"], ["workspaces", "Workspaces"], ["workflows", "Workflows"], ["audit", "Audit log"]];

export function adminView() {
  const a = state.admin || { tab: "general" };
  const tab = a.tab || "general";
  const tabBtns = ADMIN_TABS.map(([k, label]) =>
    `<button data-admin-tab="${k}" class="px-3 py-1.5 text-sm rounded-md ${tab === k ? "bg-stone-900 text-white" : "border border-stone-300 bg-white hover:bg-stone-50"}">${label}</button>`).join("");
  return `
    <header class="border-b border-stone-200 bg-white/90 backdrop-blur sticky top-0 z-20">
      <div class="px-6 pt-4 pb-2 flex items-center gap-4">
        <div class="flex-1">
          <div class="text-[11px] uppercase tracking-widest text-stone-500 font-semibold">Organization admin</div>
          <div class="text-stone-900 text-xl font-semibold leading-tight">${escapeHtml(currentOrgName())}</div>
        </div>
      </div>
      <div class="px-6 pb-3 flex items-center gap-2">${tabBtns}</div>
    </header>
    <main class="flex-1 overflow-auto p-6">${adminTabContent(tab, a)}</main>`;
}

function tbl(headers, rowsHtml, empty) {
  return `<div class="rounded-lg border border-stone-200 bg-white overflow-hidden">
    <table class="w-full text-sm">
      <thead class="bg-stone-50 border-b border-stone-200"><tr class="text-left text-[11px] uppercase tracking-wide text-stone-500">${headers.map((h) => `<th class="px-4 py-2 font-medium">${h}</th>`).join("")}</tr></thead>
      <tbody class="divide-y divide-stone-100">${rowsHtml || `<tr><td class="px-4 py-6 text-stone-400" colspan="${headers.length}">${empty || "Nothing here yet."}</td></tr>`}</tbody>
    </table></div>`;
}

function roleChip(k) {
  const tone = { owner: "bg-purple-100 text-purple-800", org_admin: "bg-purple-100 text-purple-800", editor: "bg-sky-100 text-sky-800", viewer: "bg-stone-200 text-stone-700", deployer: "bg-amber-100 text-amber-800" }[k] || "bg-stone-200 text-stone-700";
  return `<span class="text-[11px] px-1.5 py-px rounded ${tone}">${escapeHtml(k)}</span>`;
}

// A handful of current Claude models the org can pin (empty = platform default).
// Keep IDs exact — they're validated against the Anthropic API on save.
const ANTHROPIC_MODELS = [
  ["", "Platform default"],
  ["claude-opus-4-8", "Claude Opus 4.8 — most capable Opus"],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6 — balanced (default)"],
  ["claude-haiku-4-5", "Claude Haiku 4.5 — fastest / cheapest"],
  ["claude-fable-5", "Claude Fable 5 — most powerful"],
];

// Common Bedrock regions + Claude model/inference-profile ids. Datalist
// SUGGESTIONS only (free text allowed) — what an AWS account actually has
// enabled varies; the config is validated against Bedrock on save anyway.
const BEDROCK_REGIONS = [
  "us-east-1", "us-east-2", "us-west-2", "ca-central-1",
  "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-north-1",
  "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "ap-south-1", "sa-east-1",
];
const BEDROCK_MODEL_SUGGESTIONS = [
  "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
  "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "us.anthropic.claude-opus-4-5-20251101-v1:0",
];

// General-tab card: the organisation's AI/LLM provider. `llm` is the masked
// status from GET /v1/organizations/:id/anthropic-config (never raw secrets).
// Three shapes: locked (read-only, centrally managed), org-configured
// (Anthropic key or the org's own AWS Bedrock account), or platform fallback.
function anthropicCard(llm) {
  const providerLabel = (p) => (p === "bedrock" ? "AWS Bedrock" : p === "anthropic" ? "Anthropic API" : "—");

  // LOCKED: the deployment pins the provider in .env — explain exactly what is
  // active (provider/model/region, no secrets) and render no form at all.
  if (llm && llm.locked) {
    const pin = llm.configured
      ? `AI features are <b>active</b> and pre-set to <b>${providerLabel(llm.provider)}</b> · model <span class="mono">${escapeHtml(llm.model || "")}</span>${llm.region ? ` · region <span class="mono">${escapeHtml(llm.region)}</span>` : ""}.`
      : `<span class="text-rose-600">The provider lock is on, but no platform provider is configured — contact your administrator.</span>`;
    return `
        <div class="rounded-lg border border-stone-200 bg-white p-5">
          <div class="flex items-center gap-2">
            <div class="text-sm font-semibold text-stone-900">AI · LLM provider</div>
            <span class="text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 bg-stone-100 border border-stone-200 text-stone-600">🔒 centrally managed</span>
          </div>
          <div class="text-xs text-stone-500 mt-0.5 mb-3">The server operator has locked the AI provider for this deployment (<span class="mono">LLM_SETTINGS_LOCKED</span>), so it cannot be changed per organisation.</div>
          <div class="text-xs text-stone-700 rounded-md bg-stone-50 border border-stone-200 px-3 py-2">${pin}</div>
          <div class="text-xs text-stone-400 mt-2">API keys and AWS credentials live in the server configuration and are never shown here.</div>
        </div>`;
  }

  const usingOrg = !!llm && llm.source === "org";
  const status = !llm
    ? `<span class="text-stone-400">checking…</span>`
    : usingOrg && llm.provider === "bedrock"
    ? `Using <b>your AWS Bedrock account</b> · access key <span class="mono">${escapeHtml(llm.hint || "")}</span> · region <span class="mono">${escapeHtml(llm.region || "")}</span> · model <span class="mono">${escapeHtml(llm.model || "")}</span>`
    : usingOrg
    ? `Using <b>your organisation's Anthropic key</b> <span class="mono">${escapeHtml(llm.hint || "")}</span>${llm.model ? ` · model <span class="mono">${escapeHtml(llm.model)}</span>` : ""}`
    : llm.configured
    ? `Using the <b>platform default</b> — ${providerLabel(llm.provider)}${llm.model ? ` · model <span class="mono">${escapeHtml(llm.model)}</span>` : ""}${llm.region ? ` · region <span class="mono">${escapeHtml(llm.region)}</span>` : ""}`
    : `<span class="text-rose-600">No AI provider configured — AI features are disabled until one is set.</span>`;

  // Pre-select the org's saved Anthropic model; surface a legacy/custom value not in the list.
  const curModel = usingOrg && llm.provider === "anthropic" && llm.model ? llm.model : "";
  const models = ANTHROPIC_MODELS.some(([v]) => v === curModel) ? ANTHROPIC_MODELS : [...ANTHROPIC_MODELS, [curModel, `${curModel} (custom)`]];
  const modelOpts = models
    .map(([v, label]) => `<option value="${escapeHtml(v)}"${v === curModel ? " selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
  const curProvider = usingOrg ? llm.provider : "platform";
  const provOpts = [
    ["platform", "Platform default (managed by the server operator)"],
    ["anthropic", "Anthropic API — your organisation's own key"],
    ["bedrock", "AWS Bedrock — your organisation's own AWS account"],
  ].map(([v, label]) => `<option value="${v}"${v === curProvider ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
  const hidden = (p) => (p === curProvider ? "" : " hidden");
  return `
        <div class="rounded-lg border border-stone-200 bg-white p-5">
          <div class="text-sm font-semibold text-stone-900">AI · LLM provider</div>
          <div class="text-xs text-stone-500 mt-0.5 mb-3">Run this organisation's AI features (chat assistant, code &amp; connector generation) on — and billed to — your own account: an Anthropic API key, or your own AWS account via Bedrock. Credentials are stored encrypted; only a masked preview is ever shown.</div>
          <div class="text-xs text-stone-700 mb-3 rounded-md bg-stone-50 border border-stone-200 px-3 py-2">Status: ${status}</div>
          <label class="block text-xs text-stone-500 mb-1">Provider</label>
          <select id="llm-provider" class="w-full rounded-md border border-stone-300 px-3 py-2 text-sm mb-3 bg-white">${provOpts}</select>

          <div id="llm-form-platform"${hidden("platform")}>
            <div class="text-xs text-stone-500 mb-3">Uses whatever the server operator configured in <span class="mono">.env</span>. Saving deletes any AI credentials stored for this organisation.</div>
          </div>

          <div id="llm-form-anthropic"${hidden("anthropic")}>
            <label class="block text-xs text-stone-500 mb-1">Anthropic API key</label>
            <input id="anthropic-key" type="password" autocomplete="off" placeholder="${usingOrg && llm.provider === "anthropic" ? "Enter a new key to replace the current one" : "sk-ant-…"}" class="w-full rounded-md border border-stone-300 px-3 py-2 text-sm mb-2" />
            <label class="block text-xs text-stone-500 mb-1">Model <span class="text-stone-400">(optional)</span></label>
            <select id="anthropic-model" class="w-full rounded-md border border-stone-300 px-3 py-2 text-sm mb-3 bg-white">${modelOpts}</select>
          </div>

          <div id="llm-form-bedrock"${hidden("bedrock")}>
            <div class="text-xs text-stone-500 mb-3">Enter an IAM access key from <b>your AWS account</b>, ideally scoped to <span class="mono">bedrock:InvokeModel</span> only. Replacing the configuration requires re-entering all four fields.</div>
            <label class="block text-xs text-stone-500 mb-1">AWS region <span class="text-stone-400">(where Claude is enabled)</span></label>
            <input id="bedrock-region" list="bedrock-regions-list" autocomplete="off" placeholder="eu-north-1" value="${usingOrg && llm.provider === "bedrock" ? escapeHtml(llm.region || "") : ""}" class="w-full rounded-md border border-stone-300 px-3 py-2 text-sm mb-2 mono" />
            <datalist id="bedrock-regions-list">${BEDROCK_REGIONS.map((r) => `<option value="${r}"></option>`).join("")}</datalist>
            <label class="block text-xs text-stone-500 mb-1">Bedrock model or inference-profile id</label>
            <input id="bedrock-model" list="bedrock-models-list" autocomplete="off" placeholder="eu.anthropic.claude-sonnet-4-5-20250929-v1:0" value="${usingOrg && llm.provider === "bedrock" ? escapeHtml(llm.model || "") : ""}" class="w-full rounded-md border border-stone-300 px-3 py-2 text-sm mb-1 mono" />
            <datalist id="bedrock-models-list">${BEDROCK_MODEL_SUGGESTIONS.map((m) => `<option value="${m}"></option>`).join("")}</datalist>
            <div class="text-[11px] text-stone-400 mb-2">Suggestions only — check which Claude models are enabled in your AWS console (Bedrock → Model access).</div>
            <label class="block text-xs text-stone-500 mb-1">AWS access key ID</label>
            <input id="bedrock-access-key-id" autocomplete="off" placeholder="AKIA…" class="w-full rounded-md border border-stone-300 px-3 py-2 text-sm mb-2 mono" />
            <label class="block text-xs text-stone-500 mb-1">AWS secret access key</label>
            <input id="bedrock-secret" type="password" autocomplete="off" class="w-full rounded-md border border-stone-300 px-3 py-2 text-sm mb-3" />
          </div>

          <div class="flex items-center gap-2">
            <button id="anthropic-save" class="px-4 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-40">Save</button>
          </div>
          <div id="anthropic-msg" class="text-xs mt-2"></div>
        </div>`;
}

// General-tab card: bring-your-own Qlerify account — the credential the server uses
// to fetch a model behind the Model page's "⤓ Reload from link". `q` is the masked
// status from GET /v1/organizations/:id/qlerify-config (never the raw key).
function qlerifyCard(q) {
  const usingOrg = !!q && q.source === "org";
  const status = !q
    ? `<span class="text-stone-400">checking…</span>`
    : usingOrg
    ? `Using <b>your organisation's key</b> <span class="mono">${escapeHtml(q.hint || "")}</span>`
    : q.configured
    ? `Using the <b>platform default</b> Qlerify credentials`
    : `<span class="text-rose-600">No Qlerify credentials configured — "Reload from link" is disabled until a key is set.</span>`;
  return `
        <div class="rounded-lg border border-stone-200 bg-white p-5">
          <div class="text-sm font-semibold text-stone-900">Modeller · Qlerify account</div>
          <div class="text-xs text-stone-500 mt-0.5 mb-3">Plug in your own Qlerify MCP API key so this organisation's model fetches (the Model page's "⤓ Reload from link") run against — and are scoped to — your own Qlerify account. The key is stored encrypted; only a masked preview is ever shown. Leave unset to use the platform default.</div>
          <div class="text-xs text-stone-700 mb-3 rounded-md bg-stone-50 border border-stone-200 px-3 py-2">Status: ${status}</div>
          <label class="block text-xs text-stone-500 mb-1">Qlerify API key</label>
          <input id="qlerify-key" type="password" autocomplete="off" placeholder="${usingOrg ? "Enter a new key to replace the current one" : "x-api-key…"}" class="w-full rounded-md border border-stone-300 px-3 py-2 text-sm mb-3" />
          <div class="flex items-center gap-2">
            <button id="qlerify-save" class="px-4 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-40">Save key</button>
            ${usingOrg ? `<button id="qlerify-clear" class="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50">Revert to platform default</button>` : ""}
          </div>
          <div id="qlerify-msg" class="text-xs mt-2"></div>
        </div>`;
}

function adminTabContent(tab, a) {
  if (tab === "general") {
    const curOrg = (state.orgs || []).find((o) => o.id === state.me?.organizationId) || {};
    const orgName = curOrg.name || currentOrgName();
    const slug = curOrg.slug || "—";
    const isSystem = curOrg.slug === "system";
    const delOpen = !!a.deleteOrgOpen;
    const delBusy = !!a.deleteOrgBusy;
    const dangerInner = isSystem
      ? `<div class="text-xs text-stone-500">The system organisation cannot be deleted.</div>`
      : !delOpen
      ? `<button id="org-delete-open" class="px-4 py-2 text-sm rounded-md bg-rose-600 text-white hover:bg-rose-700 font-medium">Delete this organisation</button>`
      : `<div class="rounded-md border border-rose-300 bg-white p-3 max-w-md">
           <div class="text-xs text-stone-700 mb-2">This permanently deletes <b>${escapeHtml(orgName)}</b> and every workflow, model, dataset, member, and audit record it owns. Type <span class="mono font-semibold">${escapeHtml(orgName)}</span> below to confirm.</div>
           <input id="org-delete-confirm" autocomplete="off" class="w-full rounded-md border border-stone-300 px-3 py-2 text-sm mb-2" placeholder="${escapeHtml(orgName)}" />
           <div class="flex items-center gap-2">
             <button id="org-delete-cancel" class="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50">Cancel</button>
             <button id="org-delete-go" disabled class="px-4 py-2 text-sm rounded-md bg-rose-600 text-white hover:bg-rose-700 font-medium disabled:opacity-40 disabled:cursor-not-allowed">${delBusy ? "Deleting…" : "Delete permanently"}</button>
           </div>
           <div id="org-delete-err" class="text-xs text-rose-600 mt-2"></div>
         </div>`;
    return `
      <div class="max-w-2xl space-y-6">
        <div class="rounded-lg border border-stone-200 bg-white p-5">
          <div class="text-sm font-semibold text-stone-900">Organisation name</div>
          <div class="text-xs text-stone-500 mt-0.5 mb-3">The display name shown across the console. The URL handle (slug <span class="mono">${escapeHtml(slug)}</span>) stays the same.</div>
          <div class="flex items-end gap-2">
            <input id="org-name-input" value="${escapeHtml(orgName)}" ${isSystem ? "disabled" : ""} class="flex-1 rounded-md border border-stone-300 px-3 py-2 text-sm disabled:bg-stone-50 disabled:text-stone-400" />
            <button id="org-name-save" ${isSystem ? "disabled" : ""} class="px-4 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-40">Save</button>
          </div>
          <div id="org-name-msg" class="text-xs mt-2"></div>
          ${isSystem ? `<div class="text-xs text-stone-400 mt-1">The system organisation can't be renamed.</div>` : ""}
        </div>
        ${anthropicCard(a.anthropic)}
        ${qlerifyCard(a.qlerify)}
        <div class="rounded-lg border border-rose-300 bg-rose-50/40 p-5">
          <div class="text-sm font-semibold text-rose-800">Danger zone</div>
          <div class="text-xs text-rose-700 mt-0.5 mb-3">Deleting this organisation permanently removes all of its workflows, models, data, members, and history. This action cannot be undone.</div>
          ${dangerInner}
        </div>
      </div>`;
  }
  if (tab === "members") {
    const rows = (a.members || []).map((m) => `<tr>
      <td class="px-4 py-2 mono text-xs">${escapeHtml(m.subject)}</td>
      <td class="px-4 py-2 text-stone-600">${escapeHtml(m.primaryEmail || "—")}</td>
      <td class="px-4 py-2">${(m.roles || []).map(roleChip).join(" ") || '<span class="text-stone-400">—</span>'}</td>
      <td class="px-4 py-2 text-stone-500">${escapeHtml(m.status || "active")}</td>
      <td class="px-4 py-2 text-right"><button data-reset-pw="${escapeHtml(m.identityId)}" data-reset-subject="${escapeHtml(m.subject)}" class="text-xs px-2 py-1 rounded border border-stone-300 text-stone-700 hover:bg-stone-50">Reset password</button></td>
    </tr>`).join("");
    return `
      ${issuedCredentialBanner()}
      <div class="mb-4 flex items-end gap-2">
        <div><label class="block text-xs text-stone-500 mb-1">Username (IdP subject)</label><input id="m-subject" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm" placeholder="jane@corp" /></div>
        <div><label class="block text-xs text-stone-500 mb-1">Email</label><input id="m-email" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm" placeholder="optional" /></div>
        <button id="m-add" class="px-3 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800">Add member</button>
      </div>
      <div class="text-xs text-stone-500 mb-3">Inviting a member issues a one-time temporary password (shown once below). With single sign-on not yet configured, share it over a secure channel — the member changes it on first sign-in.</div>
      ${tbl(["Username", "Email", "Roles", "Status", ""], rows, "No members.")}`;
  }
  if (tab === "roles") {
    const rows = (a.roles || []).map((r) => `<tr>
      <td class="px-4 py-2 mono text-xs">${escapeHtml(r.principalId)}</td>
      <td class="px-4 py-2 text-stone-500">${escapeHtml(r.principalType)}</td>
      <td class="px-4 py-2">${roleChip(r.roleKey)}</td>
      <td class="px-4 py-2 text-stone-600">${escapeHtml(r.scopeType)}: <span class="mono text-xs">${escapeHtml(String(r.scopeId).slice(0, 12))}</span></td>
    </tr>`).join("");
    const roleOpts = ["owner", "editor", "viewer", "deployer", "org_admin"].map((k) => `<option>${k}</option>`).join("");
    const scopeOpts = ["organization", "environment", "workspace", "workflow", "resource"].map((k) => `<option>${k}</option>`).join("");
    return `
      <div class="mb-4 flex items-end gap-2 flex-wrap">
        <div><label class="block text-xs text-stone-500 mb-1">Principal id</label><input id="r-principal" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm mono" placeholder="identity id" /></div>
        <div><label class="block text-xs text-stone-500 mb-1">Role</label><select id="r-role" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm">${roleOpts}</select></div>
        <div><label class="block text-xs text-stone-500 mb-1">Scope</label><select id="r-scope" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm">${scopeOpts}</select></div>
        <div><label class="block text-xs text-stone-500 mb-1">Scope id</label><input id="r-scopeid" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm mono" placeholder="(org id for org scope)" /></div>
        <button id="r-add" class="px-3 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800">Assign role</button>
      </div>
      ${tbl(["Principal", "Type", "Role", "Scope"], rows, "No role assignments.")}`;
  }
  if (tab === "markings") {
    const rows = (a.markings || []).map((m) => `<tr>
      <td class="px-4 py-2"><span class="text-[11px] px-1.5 py-px rounded bg-rose-100 text-rose-800">${escapeHtml(m.name)}</span></td>
      <td class="px-4 py-2 text-stone-600">${escapeHtml(m.description || "—")}</td>
    </tr>`).join("");
    return `
      <div class="mb-4 flex items-end gap-2">
        <div><label class="block text-xs text-stone-500 mb-1">Marking</label><input id="mk-name" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm" placeholder="PII" /></div>
        <div><label class="block text-xs text-stone-500 mb-1">Description</label><input id="mk-desc" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm" placeholder="optional" /></div>
        <button id="mk-add" class="px-3 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800">Add marking</button>
      </div>
      <div class="text-xs text-stone-500 mb-3">Markings are a mandatory access gate (MAC): a caller must hold every marking on a resource to access it, regardless of role.</div>
      ${tbl(["Marking", "Description"], rows, "No markings.")}`;
  }
  if (tab === "environments") {
    const rows = (a.environments || []).map((e) => `<tr>
      <td class="px-4 py-2 font-medium">${escapeHtml(e.name)}</td>
      <td class="px-4 py-2 text-stone-600">${escapeHtml(e.region || "local")}</td>
      <td class="px-4 py-2 text-stone-500">${escapeHtml(e.lifecycleState || "active")}</td>
    </tr>`).join("");
    return `
      <div class="mb-4 flex items-end gap-2">
        <div><label class="block text-xs text-stone-500 mb-1">Environment</label><input id="e-name" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm" placeholder="staging" /></div>
        <div><label class="block text-xs text-stone-500 mb-1">Region</label><input id="e-region" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm" placeholder="local" /></div>
        <button id="e-add" class="px-3 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800">Add environment</button>
      </div>
      ${tbl(["Environment", "Region", "Lifecycle"], rows, "No environments.")}`;
  }
  if (tab === "workspaces") {
    const rows = (a.workspaces || []).map((w) => `<tr>
      <td class="px-4 py-2 font-medium">${escapeHtml(w.name)}</td>
      <td class="px-4 py-2 mono text-xs text-stone-500">${escapeHtml(String(w.environmentId).slice(0, 12))}</td>
      <td class="px-4 py-2 text-stone-500">${escapeHtml(w.lifecycleState || "active")}</td>
    </tr>`).join("");
    const envOpts = (a.environments || []).map((e) => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.name)}</option>`).join("");
    return `
      <div class="mb-4 flex items-end gap-2">
        <div><label class="block text-xs text-stone-500 mb-1">Workspace</label><input id="ws-name" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm" placeholder="Finance" /></div>
        <div><label class="block text-xs text-stone-500 mb-1">Environment</label><select id="ws-env" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm">${envOpts}</select></div>
        <button id="ws-add" class="px-3 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800">Add workspace</button>
      </div>
      ${tbl(["Workspace", "Environment", "Lifecycle"], rows, "No workspaces.")}`;
  }
  if (tab === "workflows") {
    const rows = (a.workflows || []).map((pr) => `<tr>
      <td class="px-4 py-2 font-medium">${escapeHtml(pr.name)}</td>
      <td class="px-4 py-2 mono text-xs text-stone-500">${escapeHtml(String(pr.workspaceId).slice(0, 12))}</td>
      <td class="px-4 py-2 text-stone-500">${escapeHtml(pr.lifecycleState || "active")}</td>
      <td class="px-4 py-2 text-right"><button data-proj-del="${escapeHtml(pr.id)}" data-proj-name="${escapeHtml(pr.name)}" class="text-xs px-2 py-1 rounded border border-rose-200 text-rose-700 hover:bg-rose-50">Delete</button></td>
    </tr>`).join("");
    const wsOpts = (a.workspaces || []).map((w) => `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)}</option>`).join("");
    const emptyMsg = "No workflows yet — create one and point it at a Qlerify model.";
    return `
      <div class="mb-4 flex items-end gap-2">
        <div><label class="block text-xs text-stone-500 mb-1">Workflow</label><input id="proj-name" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm" placeholder="Q3 Forecast" /></div>
        <div><label class="block text-xs text-stone-500 mb-1">Workspace</label><select id="proj-ws" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm">${wsOpts}</select></div>
        <button id="proj-add" class="px-3 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800">Add workflow</button>
      </div>
      <div class="text-xs text-stone-500 mb-3">A new workflow starts empty — point it at your own Qlerify model (⚙ Set model) to give it data. Switch workflows from the breadcrumb at the top. Deleting a workflow permanently drops its tables, data, run history, and model versions.</div>
      ${tbl(["Workflow", "Workspace", "Lifecycle", ""], rows, emptyMsg)}`;
  }
  // audit
  const rows = (a.audit || []).map((ev) => `<tr>
    <td class="px-4 py-2 mono text-xs text-stone-500">${ev.seq}</td>
    <td class="px-4 py-2 font-medium">${escapeHtml(ev.action)}</td>
    <td class="px-4 py-2">${ev.decision ? `<span class="text-[11px] px-1.5 py-px rounded ${ev.decision === "allow" ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"}">${escapeHtml(ev.decision)}</span>` : "—"}</td>
    <td class="px-4 py-2 text-stone-600">${escapeHtml(ev.targetRef || "—")}</td>
    <td class="px-4 py-2 text-stone-500 text-xs">${escapeHtml(ev.reason || "")}</td>
    <td class="px-4 py-2 text-stone-400 text-xs mono">${escapeHtml((ev.occurredAt || "").toString().slice(0, 19).replace("T", " "))}</td>
  </tr>`).join("");
  return `
    <div class="mb-3 flex items-center gap-2">
      <button id="audit-verify" class="px-3 py-1.5 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50">Verify chain integrity</button>
      <span id="audit-verify-result" class="text-sm text-stone-500"></span>
    </div>
    ${tbl(["#", "Action", "Decision", "Target", "Reason", "When"], rows, "No audit events.")}`;
}

export function bindAdmin() {
  document.querySelectorAll("[data-admin-tab]").forEach((el) => el.addEventListener("click", () => {
    state.issuedCredential = null; // don't carry a one-time secret across tabs
    state.admin = { ...(state.admin || {}), tab: el.dataset.adminTab };
    render();
  }));
  const reload = () => loadAdmin();
  const act = async (fn) => { try { await fn(); await reload(); } catch (e) { alert(e.message); } };

  // Invite a member: the server issues a one-time temporary password (when the
  // identity has none yet). Capture it BEFORE reload so the banner can show it.
  document.getElementById("m-add")?.addEventListener("click", async () => {
    try {
      const subject = document.getElementById("m-subject").value.trim();
      if (!subject) throw new Error("Username is required");
      const email = document.getElementById("m-email").value.trim() || undefined;
      const r = await api("/v1/memberships", { method: "POST", body: JSON.stringify({ subject, email }) });
      state.issuedCredential = r.temporaryPassword ? { subject, password: r.temporaryPassword } : null;
      await reload();
    } catch (e) { alert(e.message); }
  });
  document.querySelectorAll("[data-reset-pw]").forEach((el) => el.addEventListener("click", async () => {
    const identityId = el.dataset.resetPw;
    const subject = el.dataset.resetSubject || identityId;
    if (!confirm(`Reset the password for "${subject}"?\n\nTheir current password stops working immediately and a new temporary one is issued (shown once).`)) return;
    try {
      const r = await api(`/v1/members/${encodeURIComponent(identityId)}/reset-password`, { method: "POST", body: "{}" });
      state.issuedCredential = r.temporaryPassword ? { subject, password: r.temporaryPassword } : null;
      await reload();
    } catch (e) { alert(e.message); }
  }));
  document.getElementById("issued-copy")?.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(state.issuedCredential?.password || ""); } catch { /* clipboard blocked — the code stays selectable */ }
  });
  document.getElementById("issued-dismiss")?.addEventListener("click", () => { state.issuedCredential = null; render(); });
  document.getElementById("r-add")?.addEventListener("click", () => act(async () => {
    const principalId = document.getElementById("r-principal").value.trim();
    const scopeId = document.getElementById("r-scopeid").value.trim() || state.me?.organizationId;
    if (!principalId) throw new Error("Principal id is required");
    await api("/v1/role-assignments", { method: "POST", body: JSON.stringify({ principalId, roleKey: document.getElementById("r-role").value, scopeType: document.getElementById("r-scope").value, scopeId }) });
  }));
  document.getElementById("mk-add")?.addEventListener("click", () => act(async () => {
    const name = document.getElementById("mk-name").value.trim();
    if (!name) throw new Error("Marking name is required");
    await api("/v1/markings", { method: "POST", body: JSON.stringify({ name, description: document.getElementById("mk-desc").value.trim() || undefined }) });
  }));
  document.getElementById("e-add")?.addEventListener("click", () => act(async () => {
    const name = document.getElementById("e-name").value.trim();
    if (!name) throw new Error("Environment name is required");
    await api("/v1/environments", { method: "POST", body: JSON.stringify({ name, region: document.getElementById("e-region").value.trim() || "local" }) });
  }));
  document.getElementById("ws-add")?.addEventListener("click", () => act(async () => {
    const name = document.getElementById("ws-name").value.trim();
    const environmentId = document.getElementById("ws-env").value;
    if (!name) throw new Error("Workspace name is required");
    if (!environmentId) throw new Error("Pick an environment");
    await api("/v1/workspaces", { method: "POST", body: JSON.stringify({ name, environmentId }) });
  }));
  document.getElementById("proj-add")?.addEventListener("click", () => act(async () => {
    const name = document.getElementById("proj-name").value.trim();
    const workspaceId = document.getElementById("proj-ws").value;
    if (!name) throw new Error("Workflow name is required");
    if (!workspaceId) throw new Error("Pick a workspace");
    await api("/v1/workflows", { method: "POST", body: JSON.stringify({ name, workspaceId }) });
  }));
  document.querySelectorAll("[data-proj-del]").forEach((el) => el.addEventListener("click", () => act(async () => {
    const id = el.dataset.projDel;
    const name = el.dataset.projName || "this workflow";
    if (!confirm(`Delete workflow "${name}"?\n\nThis permanently drops its tables, all data, run history, and model versions. This cannot be undone.`)) return;
    await api(`/v1/workflows/${encodeURIComponent(id)}`, { method: "DELETE" });
    // If we just deleted the active workflow, fall back to the org's Default.
    if (AUTH.workflow() === id) AUTH.setWorkflow(null);
    // Refresh who-am-I so the breadcrumb picker drops the deleted workflow.
    try { state.me = await api("/v1/whoami"); } catch {}
  })));
  document.getElementById("audit-verify")?.addEventListener("click", async () => {
    const el = document.getElementById("audit-verify-result");
    el.textContent = "verifying…";
    try {
      const r = await api("/v1/audit/verify");
      el.innerHTML = r.ok ? `<span class="text-emerald-700">✓ intact — ${r.length} events, hash chain verified</span>` : `<span class="text-rose-700">✗ tampering detected at seq ${r.brokenAtSeq}</span>`;
    } catch (e) { el.textContent = e.message; }
  });

  // --- General tab: rename the org ------------------------------------------
  const curOrgName = () => (state.orgs || []).find((o) => o.id === state.me?.organizationId)?.name || currentOrgName();
  document.getElementById("org-name-save")?.addEventListener("click", async () => {
    const setMsg = (cls, text) => { const m = document.getElementById("org-name-msg"); if (m) { m.className = `text-xs mt-2 ${cls}`; m.textContent = text; } };
    const name = (document.getElementById("org-name-input")?.value || "").trim();
    if (!name) { setMsg("text-rose-600", "Name is required."); return; }
    if (name === curOrgName()) { setMsg("text-stone-400", "No change."); return; }
    setMsg("text-stone-400", "Saving…");
    try {
      const orgId = state.me?.organizationId;
      const updated = await api(`/v1/organizations/${encodeURIComponent(orgId)}`, { method: "PATCH", body: JSON.stringify({ name }) });
      // Refresh who-am-I so the top-bar org pill + switcher show the new name.
      try { state.me = await api("/v1/whoami"); state.orgs = state.me.organizations || []; } catch { /* keep the old context */ }
      render(); // repaint the admin header, the input, and the tenant bar
      setMsg("text-emerald-700", `Renamed to "${updated.name}".`);
    } catch (e) {
      setMsg("text-rose-600", e.message);
    }
  });

  // --- General tab: per-org AI/LLM provider ---------------------------------
  const anthropicMsg = (cls, html) => { const m = document.getElementById("anthropic-msg"); if (m) { m.className = `text-xs mt-2 ${cls}`; m.innerHTML = html; } };
  // Adaptive form: show only the selected provider's fields. (Absent entirely
  // when the deployment is locked — the card renders read-only, no controls.)
  document.getElementById("llm-provider")?.addEventListener("change", (e) => {
    const v = e.target.value;
    for (const p of ["platform", "anthropic", "bedrock"]) {
      document.getElementById(`llm-form-${p}`)?.toggleAttribute("hidden", p !== v);
    }
    anthropicMsg("", "");
  });
  document.getElementById("anthropic-save")?.addEventListener("click", async () => {
    const orgId = state.me?.organizationId;
    const provider = document.getElementById("llm-provider")?.value || "platform";
    const btn = document.getElementById("anthropic-save");
    const put = async (body, workingMsg, doneMsg) => {
      anthropicMsg("text-stone-400", workingMsg);
      if (btn) btn.disabled = true;
      try {
        const r = await api(`/v1/organizations/${encodeURIComponent(orgId)}/anthropic-config`, { method: "PUT", body: JSON.stringify(body) });
        await loadAdmin(); // repaints the card with the new masked status
        anthropicMsg("text-emerald-700", doneMsg(r));
      } catch (e) {
        if (btn) btn.disabled = false;
        anthropicMsg("text-rose-600", escapeHtml(e.message));
      }
    };
    if (provider === "platform") {
      if (!confirm("Revert to the platform default AI provider? Any AI credentials stored for your organisation will be deleted.")) return;
      await put({ clear: true }, "Reverting…", () => "Reverted to the platform default.");
    } else if (provider === "bedrock") {
      const region = (document.getElementById("bedrock-region")?.value || "").trim();
      const model = (document.getElementById("bedrock-model")?.value || "").trim();
      const accessKeyId = (document.getElementById("bedrock-access-key-id")?.value || "").trim();
      const secretAccessKey = (document.getElementById("bedrock-secret")?.value || "").trim();
      if (!region || !model || !accessKeyId || !secretAccessKey) {
        anthropicMsg("text-rose-600", "All Bedrock fields are required: region, model, access key ID, and secret access key.");
        return;
      }
      await put({ provider: "bedrock", region, model, accessKeyId, secretAccessKey }, "Validating with AWS Bedrock…",
        (r) => `Saved — now using your AWS Bedrock account <span class="mono">${escapeHtml(r.hint || "")}</span> · region <span class="mono">${escapeHtml(r.region || "")}</span> · model <span class="mono">${escapeHtml(r.model || "")}</span>.`);
    } else {
      const apiKey = (document.getElementById("anthropic-key")?.value || "").trim();
      const model = (document.getElementById("anthropic-model")?.value || "").trim();
      if (!apiKey) { anthropicMsg("text-rose-600", "Enter an API key."); return; }
      await put({ provider: "anthropic", apiKey, model: model || undefined }, "Validating key with Anthropic…",
        (r) => `Saved — now using your key <span class="mono">${escapeHtml(r.hint || "")}</span>${r.model ? ` · model <span class="mono">${escapeHtml(r.model)}</span>` : ""}.`);
    }
  });

  // --- General tab: per-org Qlerify key -------------------------------------
  const qlerifyMsg = (cls, html) => { const m = document.getElementById("qlerify-msg"); if (m) { m.className = `text-xs mt-2 ${cls}`; m.innerHTML = html; } };
  document.getElementById("qlerify-save")?.addEventListener("click", async () => {
    const apiKey = (document.getElementById("qlerify-key")?.value || "").trim();
    if (!apiKey) { qlerifyMsg("text-rose-600", "Enter an API key."); return; }
    qlerifyMsg("text-stone-400", "Validating key with Qlerify…");
    const btn = document.getElementById("qlerify-save"); if (btn) btn.disabled = true;
    try {
      const orgId = state.me?.organizationId;
      const r = await api(`/v1/organizations/${encodeURIComponent(orgId)}/qlerify-config`, { method: "PUT", body: JSON.stringify({ apiKey }) });
      await loadAdmin(); // repaints the card with the new masked status
      qlerifyMsg("text-emerald-700", `Saved — now using your key <span class="mono">${escapeHtml(r.hint || "")}</span>.`);
    } catch (e) {
      if (btn) btn.disabled = false;
      qlerifyMsg("text-rose-600", escapeHtml(e.message));
    }
  });
  document.getElementById("qlerify-clear")?.addEventListener("click", async () => {
    if (!confirm("Revert to the platform default Qlerify credentials? Your organisation's key will be removed.")) return;
    qlerifyMsg("text-stone-400", "Reverting…");
    try {
      const orgId = state.me?.organizationId;
      await api(`/v1/organizations/${encodeURIComponent(orgId)}/qlerify-config`, { method: "PUT", body: JSON.stringify({ clear: true }) });
      await loadAdmin();
      qlerifyMsg("text-emerald-700", "Reverted to the platform default credentials.");
    } catch (e) {
      qlerifyMsg("text-rose-600", escapeHtml(e.message));
    }
  });

  // --- General tab: delete the org (typed-name confirmation) -----------------
  document.getElementById("org-delete-open")?.addEventListener("click", () => {
    state.admin = { ...(state.admin || {}), deleteOrgOpen: true };
    render();
    setTimeout(() => document.getElementById("org-delete-confirm")?.focus(), 30);
  });
  document.getElementById("org-delete-cancel")?.addEventListener("click", () => {
    state.admin = { ...(state.admin || {}), deleteOrgOpen: false };
    render();
  });
  // Enable the irreversible button only when the typed name matches exactly.
  const delInput = document.getElementById("org-delete-confirm");
  const delGo = document.getElementById("org-delete-go");
  if (delInput && delGo) delInput.addEventListener("input", () => { delGo.disabled = delInput.value.trim() !== curOrgName(); });
  document.getElementById("org-delete-go")?.addEventListener("click", async () => {
    const errEl = document.getElementById("org-delete-err");
    const name = curOrgName();
    if ((document.getElementById("org-delete-confirm")?.value || "").trim() !== name) { if (errEl) errEl.textContent = "The name doesn't match."; return; }
    const orgId = state.me?.organizationId;
    state.admin = { ...(state.admin || {}), deleteOrgBusy: true };
    render();
    try {
      await api(`/v1/organizations/${encodeURIComponent(orgId)}`, { method: "DELETE" });
      // Switch away from the now-deleted org. Prefer another accessible org; if this
      // was the caller's only org there's nowhere to land, so sign out for a clean
      // re-auth rather than leaving a broken, org-less console.
      const remaining = (state.orgs || []).filter((o) => o.id !== orgId);
      state.me = null; state.orgs = []; state.admin = null;
      if (remaining.length) {
        AUTH.setOrg(remaining[0].id); // also clears the selected workflow
        state.modelMsg = { ok: true, text: `Organisation "${name}" was permanently deleted.` };
        navigate("#");
        setTimeout(() => { state.modelMsg = null; render(); }, 3500);
      } else {
        AUTH.clear();
        navigate("#login");
      }
    } catch (e) {
      state.admin = { ...(state.admin || {}), deleteOrgBusy: false };
      render();
      const e2 = document.getElementById("org-delete-err"); if (e2) e2.textContent = e.message;
    }
  });
}

