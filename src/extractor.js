// Code extraction. Runs locally in the service worker - no network, no backend.
//
// Pipeline:
//   1. HTML -> text. Inline tags are *joined* (so <span>1</span><span>2</span>
//      becomes "12"), block tags become line breaks, entities are decoded and
//      zero-width characters (a common anti-scraper trick) are removed.
//   2. Noise is stripped before anything is scored: URLs and email addresses,
//      which are where most false positives used to come from.
//   3. Codes split one character per cell ("1 2 3 4 5 6") are collapsed.
//   4. Every plausible candidate is scored on keyword proximity, shape,
//      repetition and position.
//   5. The winner is returned only if the message really looks like a
//      verification email.

// Does this message look like a verification email at all? Deliberately broad:
// the candidate scoring below is what stops a random number from winning.
const EMAIL_KEYWORDS = [
  "verification code", "verification", "verify", "verified",
  "one-time code", "one time code", "one-time password", "one time password",
  "one-time passcode", "single-use code", "single use code", "single-use",
  "security code", "login code", "log-in code", "log in code",
  "sign-in code", "sign in code", "signin code", "access code",
  "authentication code", "authenticate", "auth code", "confirmation code",
  "confirm your", "confirm that", "passcode", "pass code", "otp", "2fa",
  "two-factor", "two factor", "your code", "code is", "code:", "code below",
  "enter the code", "enter this code", "use the code", "use this code",
  "temporary code", "secret code", "activation code", "device code",
  "pairing code", "magic code", "did you request", "was this you",
  "unusual sign-in", "new sign-in", "finish signing in"
];

// Scored when they appear *near* a candidate.
const NEAR_KEYWORDS = [
  "verification code", "verification", "verify", "one-time code",
  "one time code", "one-time password", "one-time passcode", "single-use code",
  "security code", "login code", "sign-in code", "sign in code", "access code",
  "authentication code", "auth code", "confirmation code", "passcode",
  "your code", "code is", "code:", "code below", "enter the code",
  "enter this code", "use the code", "use this code", "temporary code",
  "activation code", "device code", "pairing code", "otp", "2fa",
  "two-factor", "two factor", "expires in", "expires at", "valid for",
  "do not share", "never share", "don't share"
];

// Only count against a candidate when they sit *just before* it (see NEAR_BEFORE
// below). Matching these anywhere in a 60-character window - what the previous
// version did - was the main reason real codes were being rejected: a footer
// with "unsubscribe" or a price was enough to kill a perfectly good code.
const NEGATIVE_BEFORE = [
  "order", "order #", "order no", "invoice", "receipt", "reference",
  "ref", "ref #", "tracking", "tracking #", "account number", "account no",
  "customer number", "customer no", "ticket", "ticket #", "case number",
  "member number", "policy number", "zip", "postal", "post code", "postcode",
  "phone", "telephone", "tel", "call us", "call ", "fax", "ext", "suite",
  "apt", "total", "subtotal", "amount", "price", "qty", "quantity", "usd",
  "eur", "gbp", "$", "£", "€",
  // Conference details look exactly like codes but never are.
  "meeting id", "meeting number", "conference id", "webinar id", "room id",
  "zoom id", "dial-in", "dial in"
];

// A bare mention of "code" is weak support on its own, but it is what carries
// wordings like "here's the Steam Guard code you need". Word-bounded so it does
// not fire on postcode / barcode / passcode.
const BARE_CODE_RE = /\bcodes?\b/;

// Upper-case words that are not codes, so a pure-letter token isn't mistaken.
const STOPWORDS = new Set([
  "PLEASE", "VERIFY", "CONFIRM", "ACCOUNT", "SECURITY", "SECURE", "CODES",
  "LOGIN", "SIGNIN", "EMAIL", "ADDRESS", "THANK", "THANKS", "HELLO", "TEAM",
  "SUPPORT", "NEVER", "SHARE", "EXPIRE", "EXPIRES", "MINUTE", "MINUTES",
  "HOUR", "HOURS", "VALID", "ENTER", "BELOW", "ABOVE", "GOOGLE", "APPLE",
  "AMAZON", "PAYPAL", "GITHUB", "MICROSOFT", "OUTLOOK", "DISCORD", "SLACK",
  "NOTION", "STEAM", "NETFLIX", "SPOTIFY", "WELCOME", "HTTPS", "PASSWORD",
  "REQUEST", "RESET", "UPDATE", "NOTICE", "ALERT", "DEVICE", "BROWSER",
  "SOMEONE", "RECENTLY", "ACTION", "CONTINUE", "BUTTON", "CLICK", "ABOUT",
  "THERE", "THEIR", "WHICH", "WOULD", "OTHER", "USING", "ROBOT", "EMAILS",
  "NOTIFICATION", "MESSAGE", "SUBJECT", "REPLY", "SENDER", "UNSUBSCRIBE",
  "COPYRIGHT", "RIGHTS", "RESERVED", "PRIVACY", "POLICY", "TERMS", "SERVICE",
  "CONTACT", "CENTER", "CENTRE", "HELP", "LEARN", "MORE", "SIGN", "TODAY"
]);

// How far either side of a candidate we look for supporting keywords, and how
// far *before* it we look for the disqualifying ones.
const NEAR_WINDOW = 110;
const NEAR_BEFORE = 26;

const INLINE_TAGS =
  /<\/?(?:span|b|strong|em|i|u|font|small|big|a|label|code|tt|mark|sup|sub|abbr|bdi|wbr)(?:\s[^>]*)?\/?>/gi;
const BLOCK_CLOSERS =
  /<\/?(?:p|div|tr|td|th|li|ul|ol|h[1-6]|table|tbody|thead|section|header|footer|article|blockquote|center|pre|br|hr)(?:\s[^>]*)?\/?>/gi;

const NAMED_ENTITIES = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'",
  mdash: "-", ndash: "-", hellip: "...", zwnj: "", zwj: "", shy: "", nbsp_: " "
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => cp(parseInt(d, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, (m, name) => {
      const v = NAMED_ENTITIES[name.toLowerCase()];
      return v === undefined ? m : v;
    });
}
function cp(n) {
  try { return Number.isFinite(n) ? String.fromCodePoint(n) : ""; } catch { return ""; }
}

function htmlToText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(style|script|head|noscript|title)[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(INLINE_TAGS, "")        // join, so per-character spans become a code
    .replace(BLOCK_CLOSERS, "\n")    // break, so cells/rows don't run together
    .replace(/<[^>]*>/g, " ");
}

// Zero-width and formatting characters, non-breaking spaces, then URLs and email
// addresses (tracking links are full of code-shaped numbers).
function normalize(text) {
  return decodeEntities(text)
    .replace(/[\u200b-\u200f\u2060\ufeff\u00ad]/g, "")
    .replace(/[\u00a0\u2007\u202f\u2009\u3000]/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\bwww\.\S+/gi, " ")
    .replace(/[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

// "1 2 3 4 5 6" / "A B C D E F" split across table cells -> "123456" / "ABCDEF".
// Restricted to digits and upper-case so ordinary prose is left alone.
function collapseSpacedChars(text) {
  return text
    .replace(/(?<![A-Za-z0-9])(?:\d[ \t\n]){3,7}\d(?![A-Za-z0-9])/g, (m) => m.replace(/\s+/g, ""))
    .replace(/(?<![A-Za-z0-9])(?:[A-Z0-9][ \t\n]){3,7}[A-Z0-9](?![A-Za-z0-9])/g, (m) => m.replace(/\s+/g, ""));
}

// Candidate sources:
//  - alphanumeric tokens with optional -._/ separators (G-4F2K9A, ABCD-1234)
//  - space-separated digit groups (12 34 56)
//  - plain digit runs (so "839201" competes with "G-839201")
const TOKEN_RE = /[A-Za-z0-9]+(?:[-._/][A-Za-z0-9]+){0,3}/g;
const DIGIT_GROUP_RE = /\d{2,4}(?: \d{2,4}){1,3}/g;
const DIGITS_RE = /\d{4,10}/g;

const PHONE_RE = /^\+?\d{1,3}?[-. ]?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}$/;
const DATE_RE = /^\d{1,4}[-./]\d{1,2}[-./]\d{2,4}$/;
const MONEY_RE = /\.\d{2}$/;
const PREFIXED_RE = /^([A-Za-z]{1,2})[-. ](\d{4,8})$/;

const stripSep = (raw) => raw.replace(/[-._/\s]/g, "");
const isWordChar = (ch) => !!ch && /[A-Za-z0-9]/.test(ch);

function scoreCandidate(text, lower, idx, raw, subjectEnd, subjectHasKeyword) {
  // Reject anything glued to more word characters - it is part of a longer run.
  if (isWordChar(text[idx - 1]) || isWordChar(text[idx + raw.length])) return null;

  let core = stripSep(raw);
  let prefixed = false;
  const pre = PREFIXED_RE.exec(raw);
  if (pre) { core = pre[2]; prefixed = true; }   // "G-839201" -> you type 839201

  if (core.length < 4 || core.length > 10) return null;
  if (PHONE_RE.test(raw) || DATE_RE.test(raw) || MONEY_RE.test(raw)) return null;

  const upper = core.toUpperCase();
  const hasDigit = /\d/.test(core);
  const hasLetter = /[A-Za-z]/.test(core);
  if (!hasDigit && !hasLetter) return null;
  if (!hasDigit && STOPWORDS.has(upper)) return null;      // a word, not a code
  if (!hasDigit && /[a-z]/.test(core)) return null;         // lowercase word
  if (/^0+$/.test(core)) return null;

  const before = lower.slice(Math.max(0, idx - NEAR_WINDOW), idx);
  const after = lower.slice(idx + raw.length, idx + raw.length + NEAR_WINDOW);
  const ctx = before + " " + after;
  const justBefore = lower.slice(Math.max(0, idx - NEAR_BEFORE), idx);

  let score = 0;
  let kwNear = 0;
  for (const kw of NEAR_KEYWORDS) {
    if (!ctx.includes(kw)) continue;
    kwNear++;
    score += kwNear === 1 ? 4 : 2;
    if (kwNear >= 3) break;
  }
  if (!kwNear && BARE_CODE_RE.test(ctx)) { kwNear = 1; score += 2; }
  // A keyword right next to the code is worth much more than one 100 chars away.
  if (/(?:code|otp|pin|passcode|password|token)\W{0,20}$/.test(justBefore)) score += 3;
  if (/^\W{0,6}(?:is|:|=)?\W{0,10}(?:your|the)?\W{0,3}(?:verification|security|login|sign|one-time|otp|confirmation|access)/.test(after)) score += 3;

  // Disqualifiers, but only when they sit immediately before the number.
  for (const neg of NEGATIVE_BEFORE) {
    if (justBefore.includes(neg)) { score -= 7; break; }
  }
  if (/[$£€]\s*$/.test(justBefore)) score -= 7;
  if (/^\s*(?:%|usd|eur|gbp|dollars|off\b)/.test(after)) score -= 5;

  // Shape. Six digits is by far the most common verification code.
  if (hasDigit && !hasLetter) {
    if (core.length === 6) score += 5;
    else if (core.length === 4 || core.length === 5 || core.length === 7 || core.length === 8) score += 3;
    else score -= 1;                                       // 9-10 digits: unusual
  } else if (hasDigit && hasLetter) {
    score += core.length >= 4 && core.length <= 8 ? 4 : 1;
    if (!/[a-z]/.test(core)) score += 1;                   // upper-case alnum
  } else {
    score += core.length >= 4 && core.length <= 8 ? 1 : 0; // letters only: weak
  }
  if (prefixed) score += 3;                                 // "G-123456" style
  if (/[-. ]/.test(raw)) score += 1;                        // grouped: 123-456

  // Years, repeated digits, and round numbers are almost never codes.
  if (/^\d{4}$/.test(core)) {
    const n = +core;
    if (n >= 1900 && n <= 2099) score -= 5;
    if (n % 100 === 0) score -= 2;
  }
  if (/^(.)\1+$/.test(upper)) score -= 3;

  // Position: the subject line and the top of the message are where codes live.
  if (idx < subjectEnd) score += subjectHasKeyword ? 4 : 1;
  else if (text.length > 200 && idx < subjectEnd + (text.length - subjectEnd) * 0.45) score += 1;

  return { code: prefixed ? core : (hasDigit || hasLetter ? core : raw), raw, idx, score, kwNear };
}

function gather(text, lower, subjectEnd, subjectHasKeyword) {
  const seen = new Set();
  const out = [];
  const add = (idx, raw) => {
    const key = idx + ":" + raw;
    if (seen.has(key)) return;
    seen.add(key);
    const c = scoreCandidate(text, lower, idx, raw, subjectEnd, subjectHasKeyword);
    if (c) out.push(c);
  };
  for (const m of text.matchAll(TOKEN_RE)) add(m.index, m[0]);
  for (const m of text.matchAll(DIGIT_GROUP_RE)) add(m.index, m[0]);
  for (const m of text.matchAll(DIGITS_RE)) add(m.index, m[0]);
  return out;
}

/**
 * Extract the most likely verification code from an email.
 * @param {string} subject  Subject line (may be empty).
 * @param {string} [body]   Plain-text or HTML body. When omitted, `subject` is
 *                          treated as the whole message and its first line as
 *                          the subject.
 * @returns {{code: string, raw: string, score: number} | null}
 */
export function extractCode(subject, body) {
  let subjectText = subject || "";
  let bodyText = body || "";
  if (body === undefined) {
    const nl = subjectText.indexOf("\n");
    if (nl > -1) { bodyText = subjectText.slice(nl + 1); subjectText = subjectText.slice(0, nl); }
  }

  if (/<[a-z!/][\s\S]*>/i.test(bodyText)) bodyText = htmlToText(bodyText);
  if (/<[a-z!/][\s\S]*>/i.test(subjectText)) subjectText = htmlToText(subjectText);

  subjectText = normalize(subjectText);
  bodyText = normalize(bodyText);
  if (!subjectText && !bodyText) return null;

  let text = collapseSpacedChars(subjectText + "\n" + bodyText);
  const subjectEnd = subjectText.length;
  const lower = text.toLowerCase();
  const subjectHasKeyword = EMAIL_KEYWORDS.some((k) => lower.slice(0, subjectEnd).includes(k));
  // Two gates: a phrase match ("verification code", "one-time password") is
  // strong enough to relax the scoring, a bare "code" only opens the door.
  const strongGate = subjectHasKeyword || EMAIL_KEYWORDS.some((k) => lower.includes(k));
  const looksLikeCodeEmail = strongGate || BARE_CODE_RE.test(lower);

  const candidates = gather(text, lower, subjectEnd, subjectHasKeyword);
  if (!candidates.length) return null;

  // A code that appears more than once (subject *and* body, or repeated in a
  // "copy this" block) is a strong signal. Score the group, not the instance.
  const byCode = new Map();
  for (const c of candidates) {
    const g = byCode.get(c.code);
    if (!g || c.score > g.score) byCode.set(c.code, { ...c, seen: (g ? g.seen : 0) + 1 });
    else g.seen++;
  }
  const ranked = [...byCode.values()].map((c) => (c.seen > 1 ? { ...c, score: c.score + 2 } : c));
  ranked.sort((a, b) => b.score - a.score || a.idx - b.idx);
  const best = ranked[0];

  // Accept when a keyword backs the code up, or when the message is clearly a
  // verification email and the winner is properly code-shaped.
  if (best.kwNear > 0 && best.score >= 6) return pick(best);
  if (looksLikeCodeEmail && best.score >= 7) return pick(best);

  // Last resort: a verification email with exactly one code-shaped number in it.
  // This is what rescues "Here is your code\n\n482913\n\nThanks" style layouts,
  // where the keyword is too far away to score and nothing else competes.
  if (strongGate) {
    const plausible = ranked.filter((c) => /^\d{4,8}$/.test(c.code) || /^[A-Z0-9]{4,8}$/.test(c.code));
    if (plausible.length === 1 && plausible[0].score >= 4) return pick(plausible[0]);
  }
  return null;
}

const pick = (c) => ({ code: c.code, raw: c.raw, score: c.score });

// Exposed for the test harness in tools/test-extractor.mjs.
export const __test = { htmlToText, normalize, collapseSpacedChars, gather };
