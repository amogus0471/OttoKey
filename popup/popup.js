// OttoKey popup: state-driven views, settings panel, and live updates.

// Keep in step with DEFAULT_SETTINGS in src/background.js. Tidy-up is off until
// the user turns it on and confirms.
const DEFAULT_SETTINGS = { autofill: true, autoopen: true, notify: true, tidy: false };

const views = {
  loading: document.getElementById("view-loading"),
  code: document.getElementById("view-code"),
  empty: document.getElementById("view-empty"),
  auth: document.getElementById("view-auth"),
  timeout: document.getElementById("view-timeout"),
  reauth: document.getElementById("view-reauth"),
  error: document.getElementById("view-error")
};
const $ = (id) => document.getElementById(id);

const codeValue = $("code-value");
const codeMeta = $("code-meta");
const loadingText = $("loading-text");
const historyList = $("history-list");
const historyEmpty = $("history-empty");

// Rotating messages while the otter searches.
const SEARCH_MSGS = [
  "Sniffing out your code",
  "OttoKey is checking your inbox",
  "Paddling through new mail",
  "Fetching the key",
  "Almost there"
];
let msgTimer = null;
let msgIdx = 0;

function showView(name) {
  for (const [key, el] of Object.entries(views)) el.classList.toggle("hidden", key !== name);
}

function startMsgRotation() {
  if (msgTimer) return;
  msgIdx = 0;
  loadingText.textContent = SEARCH_MSGS[0];
  msgTimer = setInterval(() => {
    msgIdx = (msgIdx + 1) % SEARCH_MSGS.length;
    loadingText.style.opacity = "0";
    setTimeout(() => {
      loadingText.textContent = SEARCH_MSGS[msgIdx];
      loadingText.style.opacity = "1";
    }, 200);
  }, 2200);
}
function stopMsgRotation() {
  clearInterval(msgTimer);
  msgTimer = null;
}

// ----- otter director ------------------------------------------------------
// One randomly chosen animation per fetch (no mid-search class swaps, so there
// is no visual cut). "walk" keeps the same class and just glides to new spots.
const OTTER_ACTIONS = ["bob", "walk", "wiggle", "sniff", "chill", "bob", "walk"];
let otterActive = false;
let walkTimer = null;
let otterX = null;

function walkLoop() {
  const pos = $("otter-pos"), face = $("otter-face"), stage = $("stage");
  const maxX = Math.max(0, stage.clientWidth - 84);
  if (maxX <= 20) { $("otter").className = "otter a-bob"; return; }
  const target = Math.round(Math.random() * maxX);
  face.style.transform = `scaleX(${target >= otterX ? 1 : -1})`;
  const travel = Math.max(700, (Math.abs(target - otterX) || 1) * 9);
  pos.style.transition = `transform ${travel}ms linear`;
  pos.style.transform = `translateX(${target}px)`;
  otterX = target;
  walkTimer = setTimeout(walkLoop, travel + 400);
}

function startOtter() {
  if (otterActive) return;
  otterActive = true;
  const otter = $("otter"), pos = $("otter-pos"), stage = $("stage");
  if (!stage || !otter) return;
  const maxX = Math.max(0, stage.clientWidth - 84);
  if (otterX == null) {
    otterX = Math.round(maxX / 2);
    pos.style.transition = "none";
    pos.style.transform = `translateX(${otterX}px)`;
  }
  const action = OTTER_ACTIONS[Math.floor(Math.random() * OTTER_ACTIONS.length)];
  otter.className = "otter a-" + action;
  if (action === "walk") walkLoop();
}

function stopOtter() {
  otterActive = false;
  clearTimeout(walkTimer);
  walkTimer = null;
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const original = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = original), 1200);
  } catch { /* clipboard may be blocked */ }
}

// ----- render ---------------------------------------------------------------
function render(state) {
  const { status, latestCode, statusDetail = "", history = [] } = state;
  const accounts = state.connected_accounts || [];

  if (status === "searching") { showView("loading"); startMsgRotation(); startOtter(); }
  else {
    stopMsgRotation();
    stopOtter();
    if (status === "needs-auth" || accounts.length === 0) showView("auth");
    else if (status === "reauth") {
      showView("reauth");
      $("reauth-email").textContent = statusDetail ? ` for ${statusDetail}` : "";
      // Remember which inbox to fix, so Reconnect is a single click.
      reauthAccountId = state.reauthAccountId ||
        ((accounts.find((a) => a.needsReauth) || {}).id) || "";
    } else if (status === "error") {
      showView("error");
      $("error-detail").textContent = statusDetail;
    } else if (status === "timeout") {
      showView("timeout");
      $("timeout-detail").textContent = statusDetail;
    } else if (latestCode) {
      showView("code");
      codeValue.textContent = latestCode.code;
      codeMeta.textContent =
        `${latestCode.site || "Unknown sender"}` +
        `${latestCode.account ? " → " + latestCode.account : ""} · ${timeAgo(latestCode.time)}`;
    } else showView("empty");
  }
  renderHistory(history);
}

function renderHistory(history) {
  historyList.innerHTML = "";
  historyEmpty.classList.toggle("hidden", history.length > 0);
  for (const item of history) {
    const li = document.createElement("li");
    li.className = "history-item";
    const info = document.createElement("div");
    info.className = "history-info";
    const code = document.createElement("span");
    code.className = "history-code";
    code.textContent = item.code;
    const site = document.createElement("span");
    site.className = "history-site";
    site.textContent = `${item.site || "Unknown"} - ${timeAgo(item.time)}`;
    info.append(code, site);
    const btn = document.createElement("button");
    btn.className = "history-copy";
    btn.textContent = "Copy";
    btn.addEventListener("click", () => copy(item.code, btn));
    li.append(info, btn);
    historyList.append(li);
  }
}

const MAX_ACCOUNTS = 5;

// The inbox the "Reconnect" button on the home view should fix.
let reauthAccountId = "";

// Shared by the home-view button and the per-inbox buttons in Settings.
function reconnect(id, btn) {
  if (!id) { openProviders("home"); return; }   // nothing to target: fall back
  const label = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "Reconnecting…"; }
  chrome.runtime.sendMessage({ type: "RECONNECT_ACCOUNT", id }, (res) => {
    if (btn) { btn.disabled = false; btn.textContent = label; }
    if (chrome.runtime.lastError || !res || !res.ok) {
      // Couldn't target that inbox - let the user pick the provider manually.
      openProviders("home");
    }
  });
}

// Inline brand logos (no external requests - MV3 safe).
const PROVIDER_LOGO = {
  gmail: `<svg viewBox="0 0 48 48"><path fill="#4caf50" d="M45 16.2l-5 2.75-5 4.75L35 40h7a3 3 0 0 0 3-3z"/><path fill="#1e88e5" d="M3 16.2l3.61 1.71L13 23.7V40H6a3 3 0 0 1-3-3z"/><polygon fill="#e53935" points="35,11.2 24,19.45 13,11.2 12,17 13,23.7 24,31.95 35,23.7 36,17"/><path fill="#c62828" d="M3 12.3v3.9l10 7.5V11.2L9.88 8.86A2.99 2.99 0 0 0 3 12.3z"/><path fill="#fbc02d" d="M45 12.3v3.9l-10 7.5V11.2l3.12-2.34A2.99 2.99 0 0 1 45 12.3z"/></svg>`,
  outlook: `<svg viewBox="0 0 48 48"><path fill="#0364b8" d="M30 14h11a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H30z"/><path fill="#28a8ea" d="M30 16h12v4H30zm0 6h12v4H30z" opacity=".55"/><rect x="6" y="12" width="22" height="24" rx="2" fill="#0078d4"/><ellipse cx="17" cy="24" rx="6.2" ry="7" fill="#fff"/><ellipse cx="17" cy="24" rx="3" ry="4" fill="#0078d4"/></svg>`
};
function logoSpan(provider, cls = "provider-logo") {
  const s = document.createElement("span");
  s.className = cls;
  s.innerHTML = PROVIDER_LOGO[provider] || "";
  return s;
}

function renderSettings(settings, accounts) {
  $("set-autofill").checked = settings.autofill;
  $("set-autoopen").checked = settings.autoopen;
  $("set-notify").checked = settings.notify;
  $("set-tidy").checked = settings.tidy;
  renderAccounts(accounts);
}

function renderAccounts(accounts = []) {
  const list = $("account-list");
  list.innerHTML = "";
  $("account-empty").style.display = accounts.length ? "none" : "";

  // Enforce the 5-inbox cap in the UI.
  const atCap = accounts.length >= MAX_ACCOUNTS;
  const addBtn = $("add-account");
  addBtn.disabled = atCap;
  addBtn.textContent = atCap ? `Max ${MAX_ACCOUNTS} reached` : "Add account";

  for (const a of accounts) {
    const li = document.createElement("li");
    li.className = "account-row" + (a.needsReauth ? " stale" : "");

    const meta = document.createElement("div");
    meta.className = "account-meta";
    const addr = document.createElement("p");
    addr.className = "account-addr";
    addr.textContent = a.email || "(address hidden)";
    const prov = document.createElement("p");
    prov.className = a.needsReauth ? "account-stale-note" : "account-provider";
    prov.textContent = a.needsReauth ? "Signed out - reconnect" : a.provider;
    meta.append(addr, prov);

    // Fix a stale inbox without leaving Settings.
    let fix = null;
    if (a.needsReauth) {
      fix = document.createElement("button");
      fix.className = "account-reconnect";
      fix.textContent = "Reconnect";
      fix.addEventListener("click", () => reconnect(a.id, fix));
    }

    const rm = document.createElement("button");
    rm.className = "account-remove";
    rm.textContent = "×";
    rm.title = "Remove inbox";
    rm.addEventListener("click", () =>
      chrome.runtime.sendMessage({ type: "REMOVE_ACCOUNT", id: a.id })
    );

    li.append(logoSpan(a.provider), meta);
    if (fix) li.append(fix);
    li.append(rm);
    list.append(li);
  }
}

// ----- home actions ---------------------------------------------------------
$("copy-btn").addEventListener("click", () => copy(codeValue.textContent, $("copy-btn")));
$("fetch-btn").addEventListener("click", () => chrome.runtime.sendMessage({ type: "MANUAL_FETCH" }));
$("retry-btn").addEventListener("click", () => chrome.runtime.sendMessage({ type: "MANUAL_FETCH" }));
$("error-retry").addEventListener("click", () => chrome.runtime.sendMessage({ type: "MANUAL_FETCH" }));
// "Fetch new code" waits for the next email instead of handing back the one it
// already found - which is what you want after asking the site to resend.
$("refetch-btn").addEventListener("click", () => chrome.runtime.sendMessage({ type: "MANUAL_FETCH", fresh: true }));
$("reauth-btn").addEventListener("click", (e) => reconnect(reauthAccountId, e.currentTarget));
$("stop-btn").addEventListener("click", () => chrome.runtime.sendMessage({ type: "STOP_SEARCH" }));
$("clear-btn").addEventListener("click", () => chrome.storage.local.set({ history: [] }));

// ----- panel switching (home / settings / providers are mutually exclusive) -
function showPanel(name) {
  $("home").classList.toggle("hidden", name !== "home");
  $("settings").classList.toggle("hidden", name !== "settings");
  $("providers").classList.toggle("hidden", name !== "providers");
}

let providersReturn = "settings";
function openProviders(origin) {
  providersReturn = origin;
  showPanel("providers");
  $("provider-status").textContent = "";
  $("gmail-warning").classList.add("hidden");
  renderProviderBadges(currentAccounts);
}
function backFromProviders() { showPanel(providersReturn); }
$("auth-add").addEventListener("click", () => openProviders("home"));
$("add-account").addEventListener("click", () => openProviders("settings"));
$("close-providers").addEventListener("click", backFromProviders);

// Paint the brand logos into the pills.
document.querySelectorAll(".provider-logo[data-logo]").forEach((el) => {
  el.innerHTML = PROVIDER_LOGO[el.dataset.logo] || "";
});

let currentAccounts = [];

// Emerald "[X] connected" badge per provider, counted from connected_accounts.
function renderProviderBadges(accounts = []) {
  for (const prov of ["gmail", "outlook"]) {
    const badge = document.querySelector(`.provider-badge[data-badge="${prov}"]`);
    if (!badge) continue;
    const count = accounts.filter((a) => a.provider === prov).length;
    badge.classList.remove("red");
    badge.textContent = count > 0 ? `${count} connected` : "";
  }
}

function gmailCount() {
  return currentAccounts.filter((a) => a.provider === "gmail").length;
}

function connect(provider, btn) {
  const nameEl = btn.querySelector(".provider-name");
  const label = nameEl.textContent;
  const all = document.querySelectorAll(".provider-btn");
  all.forEach((b) => (b.disabled = true));
  btn.classList.add("loading");
  nameEl.textContent = "Connecting…";
  $("provider-status").textContent = "Opening the sign-in window…";
  chrome.runtime.sendMessage({ type: "CONNECT_PROVIDER", provider }, (res) => {
    btn.classList.remove("loading");
    nameEl.textContent = label;
    all.forEach((b) => (b.disabled = false));
    if (chrome.runtime.lastError) {
      $("provider-status").textContent = "Could not reach the extension.";
      return;
    }
    if (res && res.ok) {
      $("provider-status").textContent = `Linked ${res.email || res.provider}.`;
      setTimeout(backFromProviders, 700);
    } else {
      $("provider-status").textContent = (res && res.error) || "Sign-in failed.";
    }
  });
}

document.querySelectorAll(".provider-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const provider = btn.dataset.provider;

    // Gmail binds to the active Chrome profile, so only one Gmail at a time.
    if (provider === "gmail" && gmailCount() >= 1) {
      const badge = document.querySelector('.provider-badge[data-badge="gmail"]');
      badge.classList.add("red");
      btn.classList.remove("shake");
      void btn.offsetWidth; // restart the animation
      btn.classList.add("shake");
      $("gmail-warning").classList.remove("hidden");
      return; // do NOT trigger the authorization sequence
    }

    connect(provider, btn);
  });
});

// "Switch Account" - drop the stored Gmail inbox, then run the OAuth picker.
// gmailConnect now uses launchWebAuthFlow with prompt=select_account, so the
// native Google account chooser always opens (getAuthToken never did).
$("gmail-switch").addEventListener("click", (e) => {
  e.preventDefault();
  $("gmail-warning").classList.add("hidden");
  const gmailBtn = document.querySelector('.provider-btn[data-provider="gmail"]');
  currentAccounts = currentAccounts.filter((a) => a.provider !== "gmail");
  chrome.storage.local.set({ connected_accounts: currentAccounts }, () => {
    connect("gmail", gmailBtn);
  });
});

// ----- settings panel -------------------------------------------------------
$("open-settings").addEventListener("click", () => { closeTidyConfirm(); showPanel("settings"); });
$("close-settings").addEventListener("click", () => showPanel("home"));

async function saveSetting(patch) {
  const { settings = {} } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...settings, ...patch } });
}

$("set-autofill").addEventListener("change", (e) => saveSetting({ autofill: e.target.checked }));
$("set-autoopen").addEventListener("change", (e) => saveSetting({ autoopen: e.target.checked }));
$("set-notify").addEventListener("change", (e) => saveSetting({ notify: e.target.checked }));

// ----- tidy up inbox: confirm before it is ever switched on ------------------
// Turning this on lets OttoKey delete mail, so the switch springs back and waits
// for an explicit "Yes, enable". Turning it off is immediate.
const tidyToggle = $("set-tidy");
const tidyConfirm = $("tidy-confirm");

function closeTidyConfirm() {
  tidyConfirm.classList.add("hidden");
}
tidyToggle.addEventListener("change", (e) => {
  if (e.target.checked) {
    e.target.checked = false;          // stays off until the dialog is accepted
    tidyConfirm.classList.remove("hidden");
  } else {
    closeTidyConfirm();
    saveSetting({ tidy: false });
  }
});
$("tidy-cancel").addEventListener("click", () => {
  tidyToggle.checked = false;
  closeTidyConfirm();
});
$("tidy-enable").addEventListener("click", () => {
  tidyToggle.checked = true;
  closeTidyConfirm();
  saveSetting({ tidy: true });
});

// ----- one-time consent (shown once for the lifetime of the install) --------
const consentScreen = $("consent-screen");
const consentAgree = $("consent-agree");
const consentContinue = $("consent-continue");
consentAgree.addEventListener("change", (e) => { consentContinue.disabled = !e.target.checked; });
consentContinue.addEventListener("click", () => {
  chrome.storage.local.set({ consentAccepted: true });
  consentScreen.classList.add("hidden");
});
chrome.storage.local.get("consentAccepted").then(({ consentAccepted }) => {
  if (!consentAccepted) consentScreen.classList.remove("hidden");
});

// ----- live state -----------------------------------------------------------
const KEYS = ["status", "statusDetail", "reauthAccountId", "latestCode", "history", "settings", "connected_accounts"];
function refresh() {
  chrome.storage.local.get(KEYS).then((s) => {
    currentAccounts = s.connected_accounts || [];
    render(s);
    renderSettings({ ...DEFAULT_SETTINGS, ...(s.settings || {}) }, currentAccounts);
    renderProviderBadges(currentAccounts);
  });
}
refresh();
chrome.storage.onChanged.addListener((_c, area) => { if (area === "local") refresh(); });

chrome.runtime.sendMessage({ type: "CLEAR_BADGE" });
