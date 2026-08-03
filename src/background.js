// Service worker: multi-account engine. Polls every linked inbox concurrently,
// extracts the code, fills it in, and (optionally) moves that message to Trash.
// No backend - every request goes straight from this worker to Gmail/Graph.
import { extractCode } from "./extractor.js";
import { listAccounts, upsertAccount, removeAccount, updateToken, markAccount, MAX_ACCOUNTS } from "./accounts.js";
import { connectProvider, fetchMessages, trashMessage, silentReauth } from "./providers.js";

const POLL_INTERVAL_MS = 2500;
const POLL_DURATION_MS = 120000;
// How far back a code can be and still count. Verification codes usually live
// ~10 min and the user may not open OttoKey the instant the code lands, so the
// window is a little wider than the code's own lifetime.
const LOOKBACK_MS = 900000; // 15 minutes
// Renew an access token this long before it actually expires. An expired token
// used to surface as "no code found", which is the most confusing failure there
// is - the code was sitting right there, we just weren't allowed to read it.
const TOKEN_MARGIN_MS = 120000;
const MAX_HISTORY = 50;
// Tidy-up is off until the user turns it on and confirms the dialog: it deletes
// mail, so it must never be a default.
const DEFAULT_SETTINGS = { autofill: true, autoopen: true, notify: true, tidy: false };

let activeSearch = null;

const get = (keys) => chrome.storage.local.get(keys);
const set = (obj) => chrome.storage.local.set(obj);
const setStatus = (status, extra = {}) => set({ status, statusAt: Date.now(), ...extra });
async function getSettings() {
  const { settings = {} } = await get("settings");
  return { ...DEFAULT_SETTINGS, ...settings };
}

// ----- auth plumbing --------------------------------------------------------
// Refresh ahead of expiry, and retry once on a 401 in case the clock was off.
async function ensureFreshToken(acct) {
  if (!acct.expiresAt || acct.expiresAt - Date.now() > TOKEN_MARGIN_MS) return;
  const fresh = await silentReauth(acct);
  await updateToken(acct.id, fresh.token, { expiresAt: fresh.expiresAt });
  acct.token = fresh.token;
  acct.expiresAt = fresh.expiresAt;
}

async function withAuth(acct, run) {
  try {
    await ensureFreshToken(acct);
  } catch (e) {
    throw reauthError(acct, e);
  }
  try {
    const out = await run();
    if (acct.needsReauth) await markAccount(acct.id, { needsReauth: false });
    return out;
  } catch (e) {
    if (e.code !== 401) throw e;
    let fresh;
    try {
      fresh = await silentReauth(acct);
    } catch (inner) {
      throw reauthError(acct, inner);
    }
    await updateToken(acct.id, fresh.token, { expiresAt: fresh.expiresAt });
    acct.token = fresh.token;
    acct.expiresAt = fresh.expiresAt;
    return run();
  }
}

function reauthError(acct, cause) {
  const e = new Error(`${acct.email || acct.provider} needs to be reconnected`);
  e.kind = "reauth";
  e.accountId = acct.id;
  e.email = acct.email || "";
  e.cause = cause;
  return e;
}

// ----- one poll across every linked inbox -----------------------------------
async function checkAllOnce(accounts, sinceMs, caches, excludeIds) {
  let scanned = 0;
  const results = await Promise.allSettled(
    accounts.map(async (acct) => {
      if (!caches.has(acct.id)) caches.set(acct.id, new Map());
      const cache = caches.get(acct.id);
      const messages = await withAuth(acct, () => fetchMessages(acct, { sinceMs, cache }));
      for (const m of messages) {
        if (m.received && m.received < sinceMs) continue;
        scanned++;
        if (excludeIds.has(m.id)) continue;
        const found = extractCode(m.subject || "", m.body || "");
        if (found) {
          return { acct, id: m.id, code: found.code, from: m.from, received: m.received || Date.now() };
        }
      }
      return null;
    })
  );

  let best = null;
  let error = null;
  let stale = 0;      // inboxes that need the user to sign in again
  let healthy = 0;    // inboxes we could actually read
  for (const r of results) {
    if (r.status === "fulfilled") {
      healthy++;
      if (r.value && (!best || r.value.received > best.received)) best = r.value;
    } else {
      const e = r.reason || new Error("Inbox check failed");
      console.warn("[OttoKey] Inbox check failed:", e.message);
      if (e.kind === "reauth") {
        stale++;
        await markAccount(e.accountId, { needsReauth: true });
      }
      if (!error || e.kind === "reauth") error = e;   // a reauth need outranks anything else
    }
  }
  // Only a total blackout should stop the search. With two inboxes linked, one
  // expired sign-in used to abort the poll for the healthy one as well.
  return { hit: best, error, scanned, allStale: stale > 0 && healthy === 0 };
}

// ----- search lifecycle -----------------------------------------------------
async function startSearch(tabId, { fresh = false, automatic = false } = {}) {
  // Content scripts run in every frame, so a single login page can report itself
  // several times. Ignore the duplicates - but never ignore a button the user
  // pressed themselves.
  if (automatic && activeSearch && activeSearch.tabId === tabId) return;
  if (activeSearch) clearTimeout(activeSearch.timer);

  const accounts = await listAccounts();
  if (!accounts.length) { await setStatus("needs-auth"); return; }

  // "Fetch new code" should wait for the *next* email, not hand back the code it
  // already gave you, so the message the last code came from is skipped.
  const excludeIds = new Set();
  if (fresh) {
    const { latestCode } = await get("latestCode");
    if (latestCode && latestCode.messageId) excludeIds.add(latestCode.messageId);
  }

  await setStatus("searching", { latestCode: null, statusDetail: "" });
  setBadge("...");

  // "Open OttoKey automatically" means as soon as the hunt starts - that is what
  // makes the searching animation visible at all. Auto-fill is a separate
  // setting, so leaving this off gives you a silent fill with no window.
  const settings = await getSettings();
  if (settings.autoopen) openPopupSafe("search start");

  const sinceMs = Date.now() - LOOKBACK_MS;
  const search = {
    tabId, excludeIds, caches: new Map(), scanned: 0,
    stopAt: Date.now() + POLL_DURATION_MS, timer: null
  };
  activeSearch = search;

  const tick = async () => {
    if (activeSearch !== search) return;             // superseded or stopped
    let outcome = { hit: null, error: null, scanned: 0 };
    try {
      outcome = await checkAllOnce(accounts, sinceMs, search.caches, search.excludeIds);
    } catch (e) {
      console.warn("[OttoKey] poll error:", e.message);
      outcome.error = e;
    }
    if (activeSearch !== search) return;
    search.scanned = Math.max(search.scanned, outcome.scanned);
    if (outcome.hit) return finish(outcome.hit, "found");
    // A dead token will never fix itself by polling again - but only give up if
    // there is no working inbox left to wait on.
    if (outcome.allStale) return finish(null, "reauth", outcome.error);
    if (Date.now() >= search.stopAt) return finish(null, outcome.error ? "error" : "timeout", outcome.error);
    search.timer = setTimeout(tick, POLL_INTERVAL_MS);
  };
  tick();
}

async function finish(hit, status, error) {
  const search = activeSearch;
  const tabId = search ? search.tabId : null;
  const scanned = search ? search.scanned : 0;
  if (search) clearTimeout(search.timer);
  activeSearch = null;
  const settings = await getSettings();

  if (status === "found" && hit) {
    // Tidy up: when enabled in Settings, move the source email to Trash after
    // reading it. Recoverable in the provider for 30 days.
    if (settings.tidy) {
      trashMessage(hit.acct, hit.id).catch((e) => console.warn("[OttoKey] Trash failed:", e.message));
    }

    const entry = {
      code: hit.code,
      site: hostFrom(hit.from),
      account: hit.acct.email,
      provider: hit.acct.provider,
      messageId: hit.id,
      time: Date.now()
    };
    const { history = [] } = await get("history");
    history.unshift(entry);
    await set({ history: history.slice(0, MAX_HISTORY) });
    await setStatus("found", { latestCode: entry, statusDetail: "" });

    setBadge("1");
    if (settings.notify) notify("Verification code ready", `${entry.code} - ${entry.site || "filled"}`);
    // Fill first, then surface the popup: opening it takes focus off the page.
    if (settings.autofill && tabId != null) injectIntoTab(tabId, entry.code);
    if (settings.autoopen) openPopupSafe("code found");
    return;
  }

  setBadge("");
  if (status === "reauth") {
    await setStatus("reauth", {
      statusDetail: error ? error.email || "" : "",
      reauthAccountId: (error && error.accountId) || ""
    });
    if (settings.notify) notify("OttoKey needs reconnecting", "Your inbox sign-in expired. Open OttoKey and press Reconnect.");
  } else if (status === "error") {
    await setStatus("error", { statusDetail: (error && error.message) || "Could not reach your inbox." });
  } else {
    // Say how much was actually looked at, so "not found" is diagnosable.
    await setStatus("timeout", { statusDetail: scanned ? `Checked ${scanned} recent email${scanned === 1 ? "" : "s"}.` : "No new email arrived." });
  }
}

// Re-run the interactive sign-in for one known inbox, then resume searching.
async function reconnectAccount(id) {
  const accounts = await listAccounts();
  const acct = accounts.find((a) => a.id === id);
  if (!acct) throw new Error("That inbox is no longer linked.");

  const { provider, email, token, expiresAt } = await connectProvider(acct.provider, {
    loginHint: acct.email
  });
  const sameAddress = (email || "").toLowerCase() === (acct.email || "").toLowerCase();
  if (!sameAddress && email) {
    // Signed in as somebody else: replace the slot rather than leaving a dead
    // entry behind next to the new one.
    await removeAccount(acct.id);
  }
  await upsertAccount({ email: email || acct.email, provider, token, extra: { expiresAt, needsReauth: false } });
  console.log(`[OttoKey] Reconnected ${provider}: ${email}`);

  await setStatus("idle", { statusDetail: "", reauthAccountId: "" });
  // The user only pressed Reconnect because they were waiting on a code.
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) =>
    startSearch(tabs[0] && tabs[0].id)
  );
  return { ok: true, email: email || acct.email };
}

function stopSearch() {
  if (activeSearch) { clearTimeout(activeSearch.timer); activeSearch = null; }
  setBadge("");
  setStatus("idle", { statusDetail: "" });
}

function hostFrom(from) {
  const at = /@(.+?)>?$/.exec((from || "").trim());
  return at ? at[1].trim() : (from || "").trim();
}

// ----- UI side effects ------------------------------------------------------
// chrome.action.openPopup() needs Chrome 127+ and a focused window, and it
// rejects if a popup is already showing. Everything except "already open" is
// worth logging: silently swallowing it is why "Open OttoKey automatically"
// looked broken with no way to tell why.
function openPopupSafe(when) {
  if (!chrome.action || !chrome.action.openPopup) {
    console.warn("[OttoKey] Cannot open the popup automatically: this Chrome build has no chrome.action.openPopup (needs Chrome 127+). The badge and notification still work.");
    return;
  }
  const complain = (e) => {
    const msg = (e && e.message) || String(e);
    if (/already open|popup is open/i.test(msg)) return;   // expected, not a fault
    console.warn(`[OttoKey] Could not open the popup (${when}):`, msg);
  };
  try {
    const p = chrome.action.openPopup();
    if (p && typeof p.catch === "function") p.catch(complain);
  } catch (e) {
    complain(e);
  }
}
function setBadge(text) {
  chrome.action.setBadgeBackgroundColor({ color: "#14b8a6" });
  chrome.action.setBadgeText({ text });
}
function notify(title, message) {
  chrome.notifications.create(
    { type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"), title, message },
    () => void chrome.runtime.lastError
  );
}
function injectIntoTab(tabId, code) {
  chrome.tabs.sendMessage(tabId, { type: "FILL_CODE", code }, () => void chrome.runtime.lastError);
}

// ----- messaging ------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "LOGIN_DETECTED") {
    startSearch(sender.tab && sender.tab.id, { automatic: true });
  } else if (msg.type === "MANUAL_FETCH") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) =>
      startSearch(tabs[0] && tabs[0].id, { fresh: !!msg.fresh })
    );
    sendResponse({ ok: true });
  } else if (msg.type === "STOP_SEARCH") {
    stopSearch();
    sendResponse({ ok: true });
  } else if (msg.type === "CONNECT_PROVIDER") {
    listAccounts().then((accounts) => {
      if (accounts.length >= MAX_ACCOUNTS) {
        sendResponse({ ok: false, error: `You can link up to ${MAX_ACCOUNTS} inboxes.` });
        return;
      }
      connectProvider(msg.provider).then(
        async ({ provider, email, token, expiresAt, extra }) => {
          await upsertAccount({ email, provider, token, extra: { expiresAt, ...(extra || {}) } });
          await setStatus("idle", { statusDetail: "" });
          console.log(`[OttoKey] Linked ${provider}: ${email}`);
          sendResponse({ ok: true, email, provider });
        },
        (err) => {
          console.error(`[OttoKey] ${msg.provider} sign-in failed:`, err.message);
          sendResponse({ ok: false, error: err.message });
        }
      );
    });
    return true;
  } else if (msg.type === "RECONNECT_ACCOUNT") {
    // One click: we already know the provider and the address, so re-run the
    // sign-in for exactly that inbox and pick the search back up.
    reconnectAccount(msg.id).then(
      (res) => sendResponse(res),
      (err) => sendResponse({ ok: false, error: err.message })
    );
    return true;
  } else if (msg.type === "REMOVE_ACCOUNT") {
    removeAccount(msg.id).then(async (rest) => {
      if (!rest.length) await setStatus("needs-auth");
      sendResponse({ ok: true });
    });
    return true;
  } else if (msg.type === "CLEAR_BADGE") {
    setBadge("");
  }
});

chrome.action.onClicked.addListener(() => setBadge(""));
