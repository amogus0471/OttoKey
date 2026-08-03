// src/accounts.js
// Concurrent multi-account storage. Schema in chrome.storage.local:
//   { connected_accounts: [ { id, email, provider, token, ...extra } ] }

const KEY = "connected_accounts";
export const MAX_ACCOUNTS = 5; // current cap; paid plans can raise this later.

export async function listAccounts() {
  const { [KEY]: accounts = [] } = await chrome.storage.local.get(KEY);
  return accounts;
}

// Add a new inbox, or refresh the token if this provider+email is already linked.
export async function upsertAccount({ email, provider, token, extra = {} }) {
  const accounts = await listAccounts();
  const match = accounts.find(
    (a) => a.provider === provider && (a.email || "").toLowerCase() === (email || "").toLowerCase()
  );
  if (match) {
    match.token = token;
    Object.assign(match, extra);
  } else {
    if (accounts.length >= MAX_ACCOUNTS) {
      throw new Error(`You can link up to ${MAX_ACCOUNTS} inboxes.`);
    }
    accounts.push({ id: crypto.randomUUID(), email, provider, token, ...extra });
  }
  await chrome.storage.local.set({ [KEY]: accounts });
  return accounts;
}

export async function removeAccount(id) {
  const accounts = (await listAccounts()).filter((a) => a.id !== id);
  await chrome.storage.local.set({ [KEY]: accounts });
  return accounts;
}

export async function updateToken(id, token, extra = {}) {
  const accounts = await listAccounts();
  const a = accounts.find((x) => x.id === id);
  if (a) {
    a.token = token;
    Object.assign(a, extra);
    await chrome.storage.local.set({ [KEY]: accounts });
  }
}
