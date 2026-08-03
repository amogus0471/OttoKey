# Security

## Reporting a vulnerability

Email **jeanlucponsard10@gmail.com** with "OttoKey security" in the subject.
Please don't open a public issue for anything exploitable, and don't include
real verification codes or access tokens in the report.

## What is and isn't a secret in this repo

The OAuth client IDs in `src/providers.js` are public identifiers. The OAuth
implicit flow used here has no client secret, so there is none to leak. If you
find anything that looks like a private key, a client secret or a bearer token
committed to this repository, that is a real finding — report it.

## Threat model, briefly

OttoKey holds a short-lived access token for each linked inbox in
`chrome.storage.local`, with the `gmail.modify` / `Mail.ReadWrite` scope. What
follows from that:

- **Local access is game over.** Anything that can read your Chrome profile can
  read those tokens, as with any signed-in extension. OttoKey does not and
  cannot protect against a compromised machine.
- **Auto-fill reduces the value of 2FA.** Delivering the second factor to the
  device that is already logging in is a deliberate convenience trade-off, not
  an oversight. It is documented in the README and on the website.
- **The extension never submits a form.** Filling a code always leaves the final
  click to you, so a wrong or malicious code cannot complete a sign-in on its
  own.
- **Extraction is local and offline.** `src/extractor.js` makes no network calls
  of any kind; it is pure string handling over text the worker already has.

## Revoking access

- Google — <https://myaccount.google.com/permissions>
- Microsoft — <https://account.microsoft.com/privacy>

Uninstalling the extension also ends its access and deletes all of its local
data.
