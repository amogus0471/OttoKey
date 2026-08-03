<div align="center">

<img src="icons/icon128.png" width="88" height="88" alt="OttoKey">

# OttoKey

**Your 2FA codes, fetched from your own inbox — on your own machine.**

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-install-14b8a6)](https://chromewebstore.google.com/detail/jcdhckalhfmfpmnookfioojejooblhmg)
[![License: MIT](https://img.shields.io/badge/license-MIT-14b8a6)](LICENSE)
[![No backend](https://img.shields.io/badge/backend-none-14b8a6)](#why-you-can-verify-the-privacy-claim-yourself)

</div>

OttoKey is a Chrome extension (Manifest V3) that notices when a site is asking
for a verification code, reads that code out of your Gmail or Outlook inbox,
and types it into the page. No copy-paste, no tab switching.

**There is no OttoKey server.** Every request goes straight from the extension
in your browser to Google's or Microsoft's mail API. Your email, your codes and
your access tokens never touch a machine belonging to the developer, because
there is no such machine. This repository exists so you don't have to take that
on faith.

---

## Why you can verify the privacy claim yourself

You do not need to read all of the code to check the important claim. Three
things are enough:

1. **`manifest.json` lists every host the extension may talk to.**
   `host_permissions` is exactly two entries: `gmail.googleapis.com` and
   `graph.microsoft.com`. Chrome enforces this — the extension physically
   cannot reach any other server for these APIs.
2. **Search the source for network calls.** Every `fetch()` in this repo is in
   [`src/providers.js`](src/providers.js), and every one of them points at those
   two Google/Microsoft hosts. There is no analytics script, no telemetry, no
   error reporter, no third-party bundle.
3. **Watch it work.** Open `chrome://extensions`, click *service worker*, and
   look at the Network tab while you fetch a code. You will see calls to Gmail
   or Graph and nothing else.

Everything the extension stores lives in `chrome.storage.local` on your disk:
the linked inbox addresses, their access tokens, your settings, and a short
history of recent codes. Uninstalling the extension deletes all of it.

## How it works

| Concern | Approach |
| --- | --- |
| **Detection** | [`src/content.js`](src/content.js) watches for a one-time-code field (including `autocomplete="one-time-code"`, split digit boxes, and fields inside open shadow roots) and pings the service worker. |
| **Fetching** | **Polling, not push.** Push (`users.watch`) needs Google Cloud Pub/Sub and a public webhook — that means a backend, which defeats the whole point. Instead a detected login triggers a *bounded burst*: poll every 2.5s for up to 2 minutes, then stop. Idle cost is zero. |
| **Extraction** | [`src/extractor.js`](src/extractor.js) scores every code-shaped token by keyword proximity, shape, repetition and position, and rejects order numbers, invoices, prices, dates, phone numbers, meeting IDs and tracking codes. Runs entirely in the worker. |
| **Injection** | [`src/content.js`](src/content.js) writes through the native value setter (so React/Vue tracked inputs notice) and dispatches real `input`/`change`/key events. Multi-box UIs get one character per box. **It never submits the form** — you always press sign in yourself. |
| **Tidy-up** | Optional and off by default. When enabled, the email the code came from is moved to Trash (recoverable for 30 days). Enabling it requires an explicit confirmation. |

### Files

```
manifest.json          MV3 config, permissions, icons
src/background.js      the engine: poll inboxes, extract, fill, trash
src/providers.js       per-provider auth + fetch + trash (Gmail, Outlook)
src/accounts.js        connected_accounts storage (UUID per inbox, 5 max)
src/extractor.js       keyword-scored code extraction, no network
src/content.js         login detection + safe code injection
popup/                 popup UI (code, history, settings, provider picker)
icons/                 generated extension icons
tools/make-icons.cjs   regenerates icons/ from the vector mark
tools/test-extractor.mjs  extractor test suite
```

## Run it from source

```bash
git clone https://github.com/amogus0471/OttoKey.git
```

Then `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
select the folder. There is no build step and no dependencies.

Run the extractor test suite (needs Node 18+, no packages):

```bash
node tools/test-extractor.mjs
```

Regenerate the icons after changing the mark:

```bash
node tools/make-icons.cjs
```

## OAuth setup for forks

The client IDs in `src/providers.js` are **public** OAuth client identifiers,
not secrets — there is no client secret anywhere in this repo, because the
implicit flow used here does not have one. They are, however, tied to the
published extension's ID, so a fork loaded unpacked gets a different ID, a
different redirect URI, and needs its own clients:

1. Load the extension and note the generated **Extension ID**. Your redirect
   URI is `https://<extension-id>.chromiumapp.org/` (the worker logs it on
   startup).
2. **Google** — [Cloud Console](https://console.cloud.google.com): enable the
   Gmail API, then create an OAuth client of type **Web application** (not
   "Chrome App" — `launchWebAuthFlow` will not work with that) and register the
   redirect URI above. Add scope `.../auth/gmail.modify`. Add yourself as a test
   user on the consent screen.
3. **Microsoft** — [Entra portal](https://entra.microsoft.com): register an app,
   add the redirect URI as a **Single-page application** redirect, and grant
   delegated `Mail.ReadWrite` and `User.Read`.
4. Put your client IDs in `GOOGLE_CLIENT` / `MS_CLIENT` in
   [`src/providers.js`](src/providers.js).

## Scopes, and why they are what they are

| Scope | Needed for |
| --- | --- |
| Gmail `gmail.modify` | Reading the message that holds your code, and moving it to Trash when tidy-up is on. It cannot permanently delete, and it cannot send mail. |
| Microsoft `Mail.ReadWrite` | The same two things for Outlook/Hotmail. Microsoft has no narrower scope that can move a message. |
| `User.Read` / `openid email profile` | Just to show you which address you linked. |

If you don't want tidy-up at all, swap Gmail's scope for `gmail.readonly` and
everything else still works.

## Honest trade-offs

- **This weakens 2FA by design.** Auto-filling a code on the same device that is
  logging in collapses the second factor into one factor. That is a reasonable
  trade for low-risk personal accounts — it is what iOS SMS autofill does — but
  think twice before pointing it at your bank or your primary email.
- **Tokens live in local storage.** Anything with local access to your Chrome
  profile can read them, exactly as with any other signed-in extension. Revoke
  access from your [Google](https://myaccount.google.com/permissions) or
  [Microsoft](https://account.microsoft.com/privacy) account at any time.
- **Access tokens are short-lived and renewed silently.** If the silent renewal
  fails, OttoKey says "reconnect", instead of pretending no code arrived.
- `chrome.action.openPopup()` needs Chrome 127+ and a focused window. If it is
  blocked, the badge and the notification are the fallback and the code is still
  filled in.

## Contributing

Bug reports are welcome, especially "OttoKey missed the code in this email".
The most useful report is the **email template with the code digits changed** —
add it as a case in `tools/test-extractor.mjs` and the fix becomes obvious.
Please don't paste real codes or real tokens into an issue.

## Links

- Website — <https://jeanlucponsard.dev/otto>
- [Privacy policy](https://jeanlucponsard.dev/otto/privacy) ·
  [Terms of service](https://jeanlucponsard.dev/otto/terms)
- Chrome Web Store —
  <https://chromewebstore.google.com/detail/jcdhckalhfmfpmnookfioojejooblhmg>

## License

[MIT](LICENSE) © Jeanluc Ponsard
