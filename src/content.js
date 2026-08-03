// Content script: detect OTP fields, wake the worker, and fill the code when it
// arrives. Pierces open Shadow DOM, runs in all frames, and mimics real typing.

const TEXT_TYPES = ["text", "tel", "number", "password", ""];
const OTP_POS = /(otp|one[\s-]?time|verif|2fa|two[\s-]?factor|pass[\s-]?code|security[\s-]?code|auth(?:entication)?[\s-]?code|confirmation[\s-]?code|sms|token|\bcode\b|\bpin\b)/i;
const OTP_NEG = /(zip|postal|post[\s-]?code|country|area[\s-]?code|promo|coupon|voucher|discount|gift|currency|dial|phone|\btel\b|address|street|city|state|sort[\s-]?code|\bcard\b|cvv|cvc)/i;

let notified = false;
let scanScheduled = false;

// ----- DOM helpers (Shadow-DOM aware) ---------------------------------------
// Collect <input>s across the document and any OPEN shadow roots.
function allInputs(root = document) {
  let out = [];
  let nodes;
  try { nodes = root.querySelectorAll("*"); } catch { return out; }
  for (const el of nodes) {
    if (el.tagName === "INPUT") out.push(el);
    if (el.shadowRoot) out = out.concat(allInputs(el.shadowRoot));
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
    el.getAttribute("aria-label"), el.getAttribute("inputmode"), label
  ].join(" ");
}

function looksLikeOtp(el) {
  if (!isTextLike(el) || !isVisible(el)) return false;
  if ((el.autocomplete || "").toLowerCase() === "one-time-code") return true;
  const hay = fieldHay(el);
  if (OTP_NEG.test(hay)) return false;
  return OTP_POS.test(hay);
}

// A single-character "digit box" - accept maxlength=1 OR a narrow input with no
// length cap (Slack-style boxes don't always set maxlength).
function isBoxLike(el) {
  if (!isTextLike(el) || !isVisible(el)) return false;
  if (el.maxLength === 1) return true;
  return el.maxLength <= 0 && el.getBoundingClientRect().width < 90;
}
function boxGroup(inputs) {
  const boxes = inputs.filter(isBoxLike);
  return boxes.length >= 4 && boxes.length <= 8 ? boxes : [];
}

function findOtpFields() {
  const inputs = allInputs().filter(isVisible);
  const boxes = boxGroup(inputs);          // prefer split digit-box groups
  if (boxes.length) return boxes;
  return inputs.filter(looksLikeOtp);
}

// ----- detection ------------------------------------------------------------
function maybeNotify() {
  if (notified) return;
  if (findOtpFields().length) {
    notified = true;
    chrome.runtime.sendMessage({ type: "LOGIN_DETECTED", origin: location.origin });
  }
}
function scheduleNotify() {
  if (notified || scanScheduled) return;
  scanScheduled = true;
  setTimeout(() => { scanScheduled = false; maybeNotify(); }, 300); // throttle
}

const observer = new MutationObserver(scheduleNotify);
observer.observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener("focusin", (e) => {
  if (e.target instanceof HTMLInputElement && looksLikeOtp(e.target)) maybeNotify();
});
maybeNotify();

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
  if (fields.length > 1) fillBoxes(fields, code);
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
