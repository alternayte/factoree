// The one-time setup token from the API log. It lives in sessionStorage, so it leaves with the tab.
const KEY = "factoree.setupToken";

export function readSetupToken(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function writeSetupToken(token: string) {
  try {
    sessionStorage.setItem(KEY, token);
  } catch {
    // A blocked sessionStorage keeps the token for this page load only.
    memory = token;
  }
}

export function clearSetupToken() {
  memory = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}

let memory: string | null = null;

export function setupToken(): string | null {
  return readSetupToken() ?? memory;
}
