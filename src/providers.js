// src/providers.js
// One module per email provider, behind a common interface:
//   connect()                    -> { email, token, expiresAt }
//   fetch(acct, { sinceMs, cache }) -> [ { id, subject, body, from, received } ]  (newest first)
//   trash(acct, id)              -> moves that message to the provider's Trash
//   reauth()                     -> { token, expiresAt }  (silent, no UI)
// Everything runs inside the extension service worker - no backend.
//
// Two rules that matter for reliability:
//   * Always hand the extractor the FULL body. Outlook's bodyPreview stops at
//     ~255 characters, which is before the code in most HTML emails - that was
//     the single biggest reason codes were "not found".
//   * Cache message bodies per search. A search polls every couple of seconds;
//     re-downloading the same ten messages each time is slow enough to eat the
//     whole polling budget.

// Use THIS extension's real redirect URL so launchWebAuthFlow can catch the
// callback regardless of the loaded extension ID. Register the value of
// REDIRECT_URI (logged below) with each provider.
const REDIRECT_URI = chrome.identity.getRedirectURL();
console.log("[OttoKey] OAuth redirect URI to register with each provider:", REDIRECT_URI);

// Bodies are capped so a pathological newsletter can't stall the worker.
const MAX_BODY_CHARS = 60000;

// ---- shared helpers --------------------------------------------------------
const rand = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const frag = (url, k) => new URLSearchParams(url.split("#")[1] || "").get(k);
const expiryFrom = (redirect) => {
  const secs = Number(frag(redirect, "expires_in"));
  // Fall back to 45 minutes: shorter than the usual hour, so we refresh early.
  return Date.now() + (Number.isFinite(secs) && secs > 0 ? secs * 1000 : 2700000);
};

function webAuth(url, interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive }, (redirect) => {
      const err = chrome.runtime.lastError;
      if (err || !redirect) reject(new Error(err ? err.message : "Sign-in cancelled"));
      else resolve(redirect);
    });
  });
}

async function authedGet(url, token, headers = {}) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, ...headers } });
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status}`);
    e.code = res.status;                       // 401 -> expired, 403 -> scope, 429 -> rate limit
    if (res.status === 401) e.message = "unauthorized";
    if (res.status === 429) e.message = "rate limited";
    throw e;
  }
  return res.json();
}

// =====================================================================
// MICROSOFT (Outlook / Hotmail) - implicit flow, Mail.ReadWrite
// =====================================================================
const MS_CLIENT = "283d79f8-578a-4021-9583-58963390201c";
// Full, explicit resource scopes - no shorthand - so Microsoft issues a
// write-capable token instead of falling back to read-only.
const MS_SCOPES =
  "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/User.Read openid profile offline_access";
// Ask Graph for plain text instead of HTML: less to parse and no markup to
// accidentally split a code across.
const MS_TEXT_BODY = { Prefer: 'outlook.body-content-type="text"' };

async function msConnect({ loginHint } = {}) {
  // Clear any stale locally cached Microsoft token first, so a brand-new token
  // that reflects the updated Mail.ReadWrite consent is always issued instead
  // of an old read-only one (which caused 403s on trash).
  await chrome.storage.local.remove(["outlook_token", "outlook_token_exp"]);

  const state = rand();
  const p = new URLSearchParams({
    client_id: MS_CLIENT, response_type: "token", redirect_uri: REDIRECT_URI,
    scope: MS_SCOPES, response_mode: "fragment",
    state
  });
  // Reconnecting a known inbox: name it, and skip the account picker so the
  // whole thing is one click. Linking a new one: always show the picker.
  if (loginHint) p.set("login_hint", loginHint);
  else p.set("prompt", "select_account");
  const redir = await webAuth(`https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${p}`);
  if (frag(redir, "state") !== state) throw new Error("State mismatch");
  const token = frag(redir, "access_token");
  if (!token) throw new Error(frag(redir, "error_description") || "Microsoft sign-in failed");
  // Verify the granted scope actually includes write access; warn early if not.
  const grantedScope = frag(redir, "scope") || "";
  if (grantedScope && !/Mail\.ReadWrite/i.test(grantedScope)) {
    console.warn("[OttoKey] Microsoft token is missing Mail.ReadWrite - trashing will 403.");
  }
  const me = await authedGet("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", token);
  return { email: me.mail || me.userPrincipalName || "", token, expiresAt: expiryFrom(redir) };
}

async function msFetch(acct, { sinceMs, cache }) {
  // Cheap pass first: ids and timestamps only, newest first.
  const listUrl =
    "https://graph.microsoft.com/v1.0/me/messages" +
    "?$top=15&$select=id,receivedDateTime&$orderby=receivedDateTime desc";
  const list = await authedGet(listUrl, acct.token);

  const out = [];
  for (const row of list.value || []) {
    const received = Date.parse(row.receivedDateTime) || 0;
    if (received && received < sinceMs) break;             // ordered desc: the rest are older too
    const hit = cache.get(row.id);
    if (hit) { out.push(hit); continue; }
    // Full body, as text, only for messages we have not parsed yet.
    const m = await authedGet(
      `https://graph.microsoft.com/v1.0/me/messages/${row.id}` +
      "?$select=id,subject,body,bodyPreview,from,receivedDateTime",
      acct.token, MS_TEXT_BODY
    );
    const parsed = {
      id: m.id,
      subject: m.subject || "",
      body: ((m.body && m.body.content) || m.bodyPreview || "").slice(0, MAX_BODY_CHARS),
      from: (m.from && m.from.emailAddress && m.from.emailAddress.address) || "",
      received: Date.parse(m.receivedDateTime) || received || 0
    };
    cache.set(m.id, parsed);
    out.push(parsed);
  }
  return out;
}

async function msTrash(acct, id) {
  // Graph's Trash is the well-known folder id "deleteditems" (the literal
  // "trash" is not a valid Graph folder and returns 404).
  const res = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${id}/move`, {
    method: "POST",
    headers: { Authorization: `Bearer ${acct.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ destinationId: "deleteditems" })
  });
  if (!res.ok) throw new Error(`Trash failed: HTTP ${res.status}`);
}

// Silent token renewal (no UI) - used when a poll hits 401 because the ~1-hour
// implicit token expired. Works while the Microsoft session cookie is alive;
// otherwise it rejects and the user is asked to reconnect.
async function msReauth(account = {}) {
  const state = rand();
  const p = new URLSearchParams({
    client_id: MS_CLIENT, response_type: "token", redirect_uri: REDIRECT_URI,
    scope: MS_SCOPES, response_mode: "fragment", prompt: "none", state
  });
  // Without login_hint, prompt=none fails outright as soon as more than one
  // Microsoft account is signed in to the browser: the provider cannot pick for
  // us, so it errors instead of renewing. Naming the account is what makes
  // silent renewal actually work.
  if (account.email) p.set("login_hint", account.email);
  const redir = await webAuth(`https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${p}`, false);
  const token = frag(redir, "access_token");
  if (!token) throw new Error(frag(redir, "error_description") || "Silent re-auth failed");
  return { token, expiresAt: expiryFrom(redir) };
}

// =====================================================================
// GMAIL - launchWebAuthFlow against Google's OAuth2 endpoint, gmail.modify.
// (getAuthToken is NOT used: it binds to the primary Chrome profile account and
// never shows an account picker, which broke "Switch Account".)
// =====================================================================
// NOTE: launchWebAuthFlow needs a "Web application" OAuth client with
// REDIRECT_URI registered as an authorized redirect URI. A "Chrome App" client
// will NOT work here.
const GOOGLE_CLIENT = "886648392591-mifi87mdls6un4i5rcovldi3akcksp9i.apps.googleusercontent.com";
const GOOGLE_SCOPES = "openid email profile https://www.googleapis.com/auth/gmail.modify";

async function gmailConnect({ loginHint } = {}) {
  const state = rand();
  const p = new URLSearchParams({
    client_id: GOOGLE_CLIENT,
    response_type: "token",          // implicit: access token in the URL fragment
    redirect_uri: REDIRECT_URI,
    scope: GOOGLE_SCOPES,
    include_granted_scopes: "true",
    state
  });
  // Same as Microsoft: name the account when reconnecting, show the picker when
  // linking something new.
  if (loginHint) p.set("login_hint", loginHint);
  else p.set("prompt", "select_account");
  const redir = await webAuth(`https://accounts.google.com/o/oauth2/v2/auth?${p}`);
  if (frag(redir, "state") !== state) throw new Error("State mismatch");
  const token = frag(redir, "access_token");
  if (!token) throw new Error(frag(redir, "error_description") || "Google sign-in failed");
  const me = await authedGet("https://gmail.googleapis.com/gmail/v1/users/me/profile", token);
  return { email: me.emailAddress || "", token, expiresAt: expiryFrom(redir) };
}

function gmHeader(payload, name) {
  const h = ((payload && payload.headers) || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}
function gmDecode(data) {
  try {
    const bin = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder("utf-8").decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return "";   // a single undecodable part must not sink the whole fetch
  }
}
// Collect BOTH the text and HTML alternatives. Returning only text/plain (what
// this used to do) loses the code whenever the plain part is a stub like
// "This email requires HTML to view".
function gmBody(payload) {
  let plain = "", html = "";
  const walk = (part) => {
    if (!part) return;
    if (part.body && part.body.data) {
      if (part.mimeType === "text/plain") plain += gmDecode(part.body.data) + "\n";
      else if (part.mimeType === "text/html") html += gmDecode(part.body.data) + "\n";
    }
    (part.parts || []).forEach(walk);
  };
  walk(payload);
  return (plain + "\n" + html).trim();
}

async function gmailFetch(acct, { sinceMs, cache }) {
  // in:anywhere so a code that landed in Spam is still found; trash, drafts and
  // sent mail are excluded. after: takes epoch seconds.
  const q = encodeURIComponent(
    `in:anywhere -in:trash -in:drafts -in:sent after:${Math.floor(sinceMs / 1000)}`
  );
  const list = await authedGet(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=15&q=${q}`, acct.token
  );

  const out = [];
  for (const { id } of list.messages || []) {
    const hit = cache.get(id);
    if (hit) { out.push(hit); continue; }
    const m = await authedGet(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, acct.token
    );
    const parsed = {
      id,
      subject: gmHeader(m.payload, "Subject"),
      body: (gmBody(m.payload) || m.snippet || "").slice(0, MAX_BODY_CHARS),
      from: gmHeader(m.payload, "From"),
      received: Number(m.internalDate) || 0
    };
    cache.set(id, parsed);
    out.push(parsed);
  }
  return out;
}

async function gmailTrash(acct, id) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/trash`, {
    method: "POST",
    headers: { Authorization: `Bearer ${acct.token}`, "Content-Length": "0" }
  });
  if (!res.ok) throw new Error(`Trash failed: HTTP ${res.status}`);
}

// Silent Google token renewal (no UI), mirroring msReauth.
async function gmailReauth(account = {}) {
  const state = rand();
  const p = new URLSearchParams({
    client_id: GOOGLE_CLIENT, response_type: "token", redirect_uri: REDIRECT_URI,
    scope: GOOGLE_SCOPES, include_granted_scopes: "true", prompt: "none", state
  });
  // See msReauth: prompt=none cannot choose between signed-in accounts, so it
  // needs to be told which one to renew.
  if (account.email) p.set("login_hint", account.email);
  const redir = await webAuth(`https://accounts.google.com/o/oauth2/v2/auth?${p}`, false);
  const token = frag(redir, "access_token");
  if (!token) throw new Error(frag(redir, "error_description") || "Silent re-auth failed");
  return { token, expiresAt: expiryFrom(redir) };
}

// ---- registry --------------------------------------------------------------
// (Yahoo removed: it blocks client-side OAuth and reading needs IMAP, which a
// browser extension can't do - not worth shipping.)
export const PROVIDERS = {
  gmail:   { label: "Gmail",   connect: gmailConnect, fetch: gmailFetch, trash: gmailTrash, reauth: gmailReauth, canTrash: true },
  outlook: { label: "Outlook", connect: msConnect,    fetch: msFetch,    trash: msTrash,    reauth: msReauth,    canTrash: true }
};

export function providerLabel(provider) {
  return (PROVIDERS[provider] && PROVIDERS[provider].label) || provider;
}
export function canTrash(provider) { return !!(PROVIDERS[provider] && PROVIDERS[provider].canTrash); }

export async function silentReauth(account) {
  const p = PROVIDERS[account.provider];
  if (!p || !p.reauth) throw new Error("No silent re-auth for this provider");
  return p.reauth(account);
}

// `loginHint` targets a specific address: used by the one-click reconnect so the
// user does not have to pick a provider and then an account all over again.
export async function connectProvider(provider, { loginHint } = {}) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown provider: ${provider}`);
  if (!p.connect) throw new Error(`${p.label} is linked with an App Password, not OAuth.`);
  const result = await p.connect({ loginHint });
  return { provider, ...result };
}
export function fetchMessages(account, opts) { return PROVIDERS[account.provider].fetch(account, opts); }
export function trashMessage(account, id) {
  const p = PROVIDERS[account.provider];
  if (!p || !p.trash) return Promise.resolve(); // provider with no trash support
  return p.trash(account, id);
}
