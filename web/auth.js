// Sign-in + change-password screens (full-page, outside the tenant shell).
// Extracted from app.js.

import { state } from "./state.js";
import { escapeHtml } from "./format.js";
import { AUTH, api, navigate, render, qlerifyMark } from "./app.js";

export function loginView() {
  const err = state.loginError ? `<div class="text-sm text-rose-600 mb-3">${escapeHtml(state.loginError)}</div>` : "";
  return `
    <div class="min-h-screen flex items-center justify-center bg-gradient-to-b from-stone-50 to-stone-100">
      <form id="login-form" class="w-80 rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
        <div class="flex items-center gap-2 mb-1"><span style="color:#50E593">${qlerifyMark("h-6 w-6")}</span><span class="text-lg font-semibold">Qlerify<span class="text-amber-500">·</span>Live</span></div>
        <div class="text-sm text-stone-500 mb-4">Sign in to the multi-tenant console</div>
        ${err}
        <label class="block text-xs font-medium text-stone-600 mb-1">Username</label>
        <input id="login-subject" autocomplete="username" class="w-full mb-3 rounded-md border border-stone-300 px-3 py-2 text-sm" placeholder="superadmin" />
        <label class="block text-xs font-medium text-stone-600 mb-1">Password</label>
        <input id="login-password" type="password" autocomplete="current-password" class="w-full mb-4 rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <button class="w-full rounded-md bg-stone-900 text-white py-2 text-sm font-medium hover:bg-stone-800">Sign in</button>
      </form>
    </div>`;
}

export function bindLogin() {
  document.getElementById("login-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const subject = document.getElementById("login-subject").value.trim();
    const password = document.getElementById("login-password").value;
    state.loginError = null;
    AUTH.clear(); // never attach a stale token to the login request
    try {
      const r = await api("/v1/auth/login", { method: "POST", body: JSON.stringify({ subject, password }) });
      AUTH.setSession(r.token);
      AUTH.setOrg((r.organizations || [])[0]?.id || "");
      state.me = null;
      navigate("#org"); // land on the portfolio control tower after login
    } catch (_err) {
      state.loginError = "Invalid username or password.";
      render();
    }
  });
}

// --- Change password (forced first-use, or from the account menu) -----------
// Full-screen card mirroring loginView. When `state.cpForced` (an admin-issued
// temporary password) there is no escape — the member must set their own before
// anything else loads. From the account menu it is cancellable.
export function changePasswordView() {
  const forced = !!state.cpForced;
  const err = state.cpError ? `<div class="text-sm text-rose-600 mb-3">${escapeHtml(state.cpError)}</div>` : "";
  const intro = forced
    ? `<div class="text-sm text-stone-500 mb-4">Your account uses a temporary password. Set your own to continue.</div>`
    : `<div class="text-sm text-stone-500 mb-4">Update the password for <span class="font-medium">${escapeHtml(state.me?.subject || "")}</span>.</div>`;
  const cancel = forced ? "" : `<button type="button" id="cp-cancel" class="w-full mt-2 rounded-md border border-stone-300 py-2 text-sm hover:bg-stone-50">Cancel</button>`;
  return `
    <div class="min-h-screen flex items-center justify-center bg-gradient-to-b from-stone-50 to-stone-100">
      <form id="cp-form" class="w-80 rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
        <div class="flex items-center gap-2 mb-1"><span style="color:#50E593">${qlerifyMark("h-6 w-6")}</span><span class="text-lg font-semibold">Qlerify<span class="text-amber-500">·</span>Live</span></div>
        <div class="text-base font-semibold text-stone-800 mb-1">Change password</div>
        ${intro}
        ${err}
        <label class="block text-xs font-medium text-stone-600 mb-1">Current password</label>
        <input id="cp-current" type="password" autocomplete="current-password" class="w-full mb-3 rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <label class="block text-xs font-medium text-stone-600 mb-1">New password</label>
        <input id="cp-new" type="password" autocomplete="new-password" class="w-full mb-3 rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <label class="block text-xs font-medium text-stone-600 mb-1">Confirm new password</label>
        <input id="cp-confirm" type="password" autocomplete="new-password" class="w-full mb-4 rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <button class="w-full rounded-md bg-stone-900 text-white py-2 text-sm font-medium hover:bg-stone-800">Update password</button>
        ${cancel}
      </form>
    </div>`;
}

export function bindChangePassword() {
  document.getElementById("cp-cancel")?.addEventListener("click", () => {
    state.cpError = null;
    navigate(state.cpReturn || "#org");
  });
  document.getElementById("cp-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const currentPassword = document.getElementById("cp-current").value;
    const newPassword = document.getElementById("cp-new").value;
    const confirm = document.getElementById("cp-confirm").value;
    state.cpError = null;
    if (newPassword !== confirm) { state.cpError = "The new passwords don't match."; render(); return; }
    if (newPassword.length < 10) { state.cpError = "New password must be at least 10 characters."; render(); return; }
    try {
      const r = await api("/v1/account/password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
      if (r.token) AUTH.setSession(r.token); // server revoked the old sessions; swap to the fresh token
      state.cpForced = false;
      state.cpError = null;
      state.me = null; // re-fetch whoami — mustChangePassword is now false
      navigate(state.cpReturn || "#org");
    } catch (_err) {
      state.cpError = "Couldn't update the password — check your current password.";
      render();
    }
  });
}

