// Test harness for src/extractor.js. Run with:  node tools/test-extractor.mjs
// Samples are shaped like the real emails OttoKey has to cope with: HTML
// wrappers, preheader text, tracking links, split digit cells, and a set of
// non-verification emails that must never produce a code.

import { extractCode } from "../src/extractor.js";

const CASES = [
  // ---------- real-world verification emails ----------
  {
    name: "Google G- prefixed",
    subject: "G-471952 is your Google verification code",
    body: "Use the code G-471952 to verify it's you. Google will never ask for this code.",
    expect: "471952"
  },
  {
    name: "Microsoft account security code",
    subject: "Microsoft account security code",
    body: `Please use this security code for the Microsoft account je*****@outlook.com.
Security code: 7492013
If you don't recognise this activity, click here to review your recent activity.
Thanks, The Microsoft account team`,
    expect: "7492013"
  },
  {
    name: "Discord (HTML)",
    subject: "Discord Verification Code",
    body: `<html><head><style>.x{color:#fff}</style></head><body>
      <div style="display:none">Verify your new login location</div>
      <table><tr><td><h2>Hi Jeanluc,</h2>
      <p>Your Discord verification code is:</p>
      <p style="font-size:32px"><b>293841</b></p>
      <p>This code expires in 10 minutes.</p></td></tr></table>
      <a href="https://discord.com/unsubscribe?u=38291043">Unsubscribe</a></body></html>`,
    expect: "293841"
  },
  {
    name: "GitHub device verification",
    subject: "[GitHub] Please verify your device",
    body: `Hey jeanluc!
A sign in attempt requires further verification. To complete the sign in, enter the verification code on the unrecognized device.

Verification code: 830261

If you did not attempt to sign in, someone may be trying to access your account.`,
    expect: "830261"
  },
  {
    name: "Apple",
    subject: "Your Apple Account verification code",
    body: "Your Apple Account code is: 918273. Do not share it with anyone.",
    expect: "918273"
  },
  {
    name: "Amazon OTP",
    subject: "amazon.com: Sign-in attempt",
    body: "To verify your identity, enter the OTP: 482913. Amazon will never ask for it.",
    expect: "482913"
  },
  {
    name: "PayPal one-time PIN",
    subject: "Your one-time PIN",
    body: "Your one-time PIN is 748291. It expires in 5 minutes. Never share this PIN with anyone, including PayPal staff.",
    expect: "748291"
  },
  {
    name: "Steam Guard (letters + digits)",
    subject: "Your Steam account: Access from new web or mobile device",
    body: "Here's the Steam Guard code you need to login to your account: AB4KD",
    expect: "AB4KD"
  },
  {
    name: "Uber (code in subject only)",
    subject: "2985 is your Uber verification code",
    body: "Reply STOP to unsubscribe.",
    expect: "2985"
  },
  {
    name: "Slack grouped code",
    subject: "Slack confirmation code: 421-980",
    body: "Confirm your email address by entering this code: 421-980",
    expect: "421980"
  },
  {
    name: "Netflix 4-digit",
    subject: "Netflix: your sign-in code",
    body: "Enter this code to finish signing in: 1234. It expires in 15 minutes.",
    expect: "1234"
  },
  {
    name: "Code split one digit per table cell",
    subject: "Your verification code",
    body: `<table><tr>
      <td style="border:1px solid #ccc">4</td><td>8</td><td>2</td>
      <td>9</td><td>1</td><td>3</td></tr></table>
      <p>Enter the code above to continue.</p>`,
    expect: "482913"
  },
  {
    name: "Code spaced out in text",
    subject: "Confirm your email",
    body: "Your code: 1 2 3 4 5 6 — it is valid for ten minutes.",
    expect: "123456"
  },
  {
    name: "Per-character spans (inline tags joined)",
    subject: "Your login code",
    body: "<p>Your login code is <span>5</span><span>5</span><span>2</span><span>3</span><span>1</span><span>0</span></p>",
    expect: "552310"
  },
  {
    name: "Zero-width characters inside the code",
    subject: "Verification code",
    body: "Your code is 4​8​2​9​1​3 — do not share it.",
    expect: "482913"
  },
  {
    name: "HTML entities around the code",
    subject: "Verify your account",
    body: "Your verification code is&nbsp;<b>552310</b>&nbsp;and expires shortly.",
    expect: "552310"
  },
  {
    name: "Code with a legal/marketing footer (used to be rejected)",
    subject: "Your verification code",
    body: `Your verification code is 552310. If you did not request this, ignore this email.
Unsubscribe | Privacy | © 2026 Acme Inc, 1600 Market St, Philadelphia PA 19103
Questions? Call us at 555-123-4567. Order support available 24/7.`,
    expect: "552310"
  },
  {
    name: "Code buried past the 255-character preview cut-off",
    subject: "Your security code",
    body: `<div style="display:none">Do not reply to this automated message. View this email in your browser if images are not displayed correctly. This message was sent to you because you have an account with us and requested to sign in from a new device or browser session today.</div>
      <p>Hello,</p><p>We received a request to sign in to your account. Use the security code below to continue.</p>
      <h1>604517</h1><p>This code expires in 10 minutes.</p>`,
    expect: "604517"
  },
  {
    name: "Lowercase alphanumeric code",
    subject: "Your one-time code",
    body: "Enter this one-time code to sign in: a1b2c3",
    expect: "a1b2c3"
  },
  {
    name: "Tracking link full of digits nearby",
    subject: "Verify your email address",
    body: `<a href="https://click.acme.com/u/38291043982?e=9f8a7b6c5d">View in browser</a>
      <p>Your verification code is 771204.</p>`,
    expect: "771204"
  },
  {
    name: "Code first, keyword after",
    subject: "Sign-in code",
    body: "620914 is your verification code for Acme. It expires in 10 minutes.",
    expect: "620914"
  },
  {
    name: "8-digit code",
    subject: "Your access code",
    body: "Access code: 39104782. Valid for one hour.",
    expect: "39104782"
  },

  // ---------- must NOT return a code ----------
  { name: "Order shipped", subject: "Your order #1148392 has shipped",
    body: "Tracking number 9405511899223197428060. Total charged $124.99. Estimated delivery 08/07/2026.",
    expect: null },
  { name: "Invoice", subject: "Invoice 88213 from Acme Ltd",
    body: "Amount due $45.00 by 09/01/2026. Reference 4471902. Questions? Call 555-982-1120.",
    expect: null },
  { name: "Newsletter", subject: "10 tips for a better 2026",
    body: "Read our top 10 articles this week. 4500 readers joined in July. Unsubscribe anytime.",
    expect: null },
  { name: "Meeting invite", subject: "Standup at 10:30",
    body: "Join the call. Meeting ID 8391 4402 771. Passcode not required for this room.",
    expect: null },
  { name: "Password changed notice", subject: "Your password was changed",
    body: "Your password was changed on 03 August 2026 at 14:22 from Chrome on Windows. If this wasn't you, reset it now.",
    expect: null },
  { name: "Empty message", subject: "", body: "", expect: null }
];

let pass = 0;
const failures = [];
for (const c of CASES) {
  const got = extractCode(c.subject, c.body);
  const code = got ? got.code : null;
  const ok = code === c.expect;
  if (ok) pass++;
  else failures.push({ ...c, code, score: got ? got.score : null });
  const mark = ok ? "PASS" : "FAIL";
  const shown = code === null ? "(none)" : code;
  console.log(
    `${mark}  ${c.name.padEnd(46)} expected ${String(c.expect ?? "(none)").padEnd(10)} got ${shown}` +
    (got ? `  [score ${got.score}]` : "")
  );
}

console.log(`\n${pass}/${CASES.length} passed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f.name}: expected ${f.expect ?? "(none)"}, got ${f.code ?? "(none)"}`);
  process.exitCode = 1;
}
