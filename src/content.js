// Content script: detect OTP fields, wake the worker, and fill the code when it
// arrives. Pierces open Shadow DOM, runs in all frames, and mimics real typing.
//
// Detection is deliberately tiered, because plenty of sites label the field
// nothing useful at all:
//   definite  - autocomplete="one-time-code", an OTP-ish name/label, or a row of
//               single-character boxes.
//   probable  - a short numeric input (maxlength 4-8, numeric inputmode/pattern)
//               that also has code-ish wording around it.
// Only "definite", or a "probable" backed up by the page wording, wakes the
// worker.

const TEXT_TYPES = ["text", "tel", "number", "password", ""];
const OTP_POS = /(otp|one[\s-]?time|verif|2fa|two[\s-]?factor|pass[\s-]?code|security[\s-]?code|auth(?:entication)?[\s-]?code|confirmation[\s-]?code|sms|token|challenge|\bcode\b|\bpin\b)/i;
const OTP_NEG = /(zip|postal|post[\s-]?code|country|area[\s-]?code|promo|coupon|voucher|discount|gift|currency|dial|phone|\btel\b|address|street|city|state|sort[\s-]?code|\bcard\b|cvv|cvc|captcha|birth|\bdob\b|expiry|expir|\bmonth\b|\byear\b|\bday\b|quantity|\bqty\b|amount|price|search)/i;
// Wording that shows up on a page waiting for a code. Used to promote a short
// numeric field that carries no useful attributes of its own.
const PAGE_HINT = /(\d\s*-?\s*digit|verification code|security code|one[\s-]?time|confirmation code|authentication code|enter the code|enter your code|enter code|code we (?:sent|emailed)|code sent to|check your (?:email|inbox)|sent you a code|2-step|two-step|2fa|resend code|didn't (?:get|receive) (?:a |the )?code)/i;

// Re-notify only when something genuinely changed, or when the user reaches for
// the field themselves. A plain timer would restart the search forever on any
// page that mutates in the background.
const INTERACTION_COOLDOWN_MS = 5000;
let lastSignature = "";
let lastNotifyAt = 0;
let scanScheduled = false;
let sawShadowRoot = false;

// ----- DOM helpers (Shadow-DOM aware) ---------------------------------------
// The deep walk is what makes component-library code boxes work, but walking
// every element on every mutation is wasteful on a big page, so the cheap flat
// query goes first and the walk only runs when it finds nothing (or when this
// page has already been seen using shadow DOM).
function allInputs() {
  const flat = Array.from(document.querySelectorAll("input"));
  if (flat.length && !sawShadowRoot) return flat;
  const deep = walkInputs(document);
  return deep.length ? deep : flat;
}

function walkInputs(root) {
  let out = [];
  let nodes;
  try { nodes = root.querySelectorAll("*"); } catch { return out; }
  for (const el of nodes) {
    if (el.tagName === "INPUT") out.push(el);
    if (el.shadowRoot) { sawShadowRoot = true; out = out.concat(walkInputs(el.shadowRoot)); }
  }
  return out;
}

function isVisible(el) {
  if (el.disabled || el.readOnly) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0; // rendered (works inside shadow roots too)
}
function isTextLike(el) {
  return el.tagName === "INPUT" && TEXT_TYPES.includes((el.type || "").toLowerCase());
}
function fieldHay(el) {
  let label = "";
  try { if (el.labels && el.labels[0]) label = el.labels[0].textContent || ""; } catch { /* ignore */ }
  return [
    el.name, el.id, el.className, el.placeholder,
    el.getAttribute("aria-label"), el.getAttribute("autocomplete"), label
  ].join(" ");
}

// Short + numeric: the shape of a code box even when it is named "answer".
function isShortNumeric(el) {
  const len = el.maxLength;
  if (!(len >= 4 && len <= 8)) return false;
  const mode = (el.getAttribute("inputmode") || "").toLowerCase();
  const type = (el.type || "").toLowerCase();
  const pattern = el.getAttribute("pattern") || "";
  return mode === "numeric" || mode === "tel" || type === "tel" || type === "number" ||
    /\[?0-9|\\d/.test(pattern);
}

// Text around the field, walked up a few levels. innerText forces layout, so it
// is only ever called for the handful of "probable" candidates.
function nearbyText(el) {
  let cur = el.parentElement;
  let text = "";
  for (let hops = 0; cur && hops < 4 && text.length < 400; hops++) {
    text = cur.innerText || cur.textContent || "";
    cur = cur.parentElement;
  }
  return text.slice(0, 800);
}

// 2 = definite, 1 = probable (needs page wording), 0 = not a code field.
function otpRank(el) {
  if (!isTextLike(el) || !isVisible(el)) return 0;
  if ((el.autocomplete || "").toLowerCase() === "one-time-code") return 2;
  const hay = fieldHay(el);
  if (OTP_NEG.test(hay)) return 0;
  if (OTP_POS.test(hay)) return 2;
  if (isShortNumeric(el)) return 1;
  return 0;
}

// A single-character "digit box" - accept maxlength=1, or a narrow numeric input
// with no length cap (some component libraries don't set maxlength).
function isBoxLike(el) {
  if (!isTextLike(el) || !isVisible(el)) return false;
  if (OTP_NEG.test(fieldHay(el))) return false;
  if (el.maxLength === 1) return true;
  if (el.maxLength > 1) return false;
  const narrow = el.getBoundingClientRect().width < 70;
  const mode = (el.getAttribute("inputmode") || "").toLowerCase();
  const type = (el.type || "").toLowerCase();
  return narrow && (mode === "numeric" || mode === "tel" || type === "tel" || type === "number");
}
function boxGroup(inputs) {
  const boxes = inputs.filter(isBoxLike);
  return boxes.length >= 4 && boxes.length <= 8 ? boxes : [];
}

function findOtpFields() {
  const inputs = allInputs().filter((el) => isTextLike(el) && isVisible(el));
  if (!inputs.length) return [];

  const boxes = boxGroup(inputs);          // prefer split digit-box groups
  if (boxes.length) return boxes;

  const definite = inputs.filter((el) => otpRank(el) === 2);
  if (definite.length) return definite;

  // Nothing named itself. Promote a short numeric field when the surrounding
  // page is clearly asking for a code.
  const probable = inputs.filter((el) => otpRank(el) === 1);
  const confirmed = probable.filter((el) => PAGE_HINT.test(nearbyText(el)));
  if (confirmed.length) return confirmed;

  // A lone short numeric field, with code wording anywhere on the page.
  if (probable.length === 1 && PAGE_HINT.test((document.body && document.body.innerText) || "")) {
    return probable;
  }
  return [];
}

// ----- detection ------------------------------------------------------------
// Identity of the current form, so a second step on the same page counts as new
// while scrolling or a re-render does not.
function signatureOf(fields) {
  return location.pathname + "|" + fields.length + "|" +
    fields.map((f) => `${f.name || ""}/${f.id || ""}/${f.autocomplete || ""}/${f.maxLength}`).join(",");
}

function maybeNotify(reason) {
  const fields = findOtpFields();
  if (!fields.length) return;
  const sig = signatureOf(fields);
  const now = Date.now();
  const changed = sig !== lastSignature;
  const userAsked = reason === "interaction" && now - lastNotifyAt > INTERACTION_COOLDOWN_MS;
  if (!changed && !userAsked) return;
  lastSignature = sig;
  lastNotifyAt = now;
  chrome.runtime.sendMessage({ type: "LOGIN_DETECTED", origin: location.origin }, () => void chrome.runtime.lastError);
}

function scheduleNotify() {
  if (scanScheduled) return;
  scanScheduled = true;
  setTimeout(() => { scanScheduled = false; maybeNotify("mutation"); }, 350); // throttle
}

const observer = new MutationObserver(scheduleNotify);
observer.observe(document.documentElement, { childList: true, subtree: true });

// Explicit user intent: focusing or clicking the field, or coming back to the
// tab to type the code in.
document.addEventListener("focusin", (e) => {
  if (e.target instanceof HTMLInputElement && otpRank(e.target) > 0) maybeNotify("interaction");
}, true);
document.addEventListener("pointerdown", (e) => {
  if (e.target instanceof HTMLInputElement && otpRank(e.target) > 0) maybeNotify("interaction");
}, true);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) maybeNotify("interaction");
});

maybeNotify("load");

// ----- injection ------------------------------------------------------------
function setNativeValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
function typeInto(el, value) {
  el.focus();
  const key = value.slice(-1) || "";
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  setNativeValue(el, value);
  el.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
}
function fillBoxes(boxes, code) {
  const chars = code.split("");
  boxes.forEach((box, i) => typeInto(box, chars[i] || ""));
  const last = boxes[Math.min(code.length, boxes.length) - 1];
  if (last) last.focus(); // do NOT auto-submit
}

function fillCode(code) {
  let fields = findOtpFields();
  if (!fields.length) {
    const af = document.activeElement;
    if (af && isTextLike(af) && isVisible(af) && !OTP_NEG.test(fieldHay(af))) fields = [af];
  }
  if (!fields.length) return false;
  // One character per box only for an actual row of boxes. Two ordinary fields
  // that both look like code inputs must not get one character each.
  const isBoxRow = fields.length >= 3 && fields.every(isBoxLike);
  if (isBoxRow) fillBoxes(fields, code);
  else typeInto(fields[0], code);
  return true;
}

// If filling fails, print the page's input fields so the markup can be tuned.
function logDiagnostics() {
  try {
    const inputs = allInputs().filter(isVisible);
    console.warn(`[OttoKey] No code field found. ${inputs.length} visible input(s):`);
    inputs.forEach((el) => console.warn("[OttoKey] field:", {
      type: el.type, name: el.name, id: el.id, class: el.className,
      maxLength: el.maxLength, placeholder: el.placeholder,
      ariaLabel: el.getAttribute("aria-label"), autocomplete: el.autocomplete,
      inputmode: el.getAttribute("inputmode"), rank: otpRank(el),
      width: Math.round(el.getBoundingClientRect().width)
    }));
  } catch { /* ignore */ }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "FILL_CODE") {
    console.log("[OttoKey] FILL_CODE received:", msg.code);
    let attempts = 0;
    const tryFill = () => {
      if (fillCode(msg.code)) { sendResponse({ filled: true }); return; }
      if (++attempts < 6) { setTimeout(tryFill, 400); return; }
      logDiagnostics();
      sendResponse({ filled: false });
    };
    tryFill();
    return true; // async sendResponse
  }
});
