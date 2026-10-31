import { User, WebStorageStateStore } from "oidc-client-ts";

const API_URL = import.meta.env.VITE_API_URL;
const AUTHORITY = import.meta.env.VITE_COGNITO_AUTHORITY;
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID;
const DOMAIN = import.meta.env.VITE_COGNITO_DOMAIN;

// Settings for react-oidc-context
export const oidcConfig = {
  authority: AUTHORITY,
  client_id: CLIENT_ID,
  redirect_uri: window.location.origin + "/", // must match a callback URL in auth.tf
  response_type: "code",
  scope: "openid email profile",
  userStore: new WebStorageStateStore({ store: window.localStorage }), // stay signed in across tabs and reloads
  // After coming back from Cognito, remove ?code=... from the address bar
  onSigninCallback: () =>
    window.history.replaceState({}, document.title, window.location.pathname),
};

// The signed-in user's access token, read from where the library stores it
function getAccessToken(): string | undefined {
  const raw = localStorage.getItem(`oidc.user:${AUTHORITY}:${CLIENT_ID}`);
  return raw ? User.fromStorageString(raw).access_token : undefined;
}

// Like fetch, but for our API: adds the base URL and the token
export function apiFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  const token = getAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${API_URL}${path}`, { ...init, headers });
}

// The message to show when a write fails: the API's own message for a refused request
// (like the read-only demo account), otherwise `fallback`
export async function errorMessage(res: Response, fallback: string) {
  if (res.status !== 403) return fallback;
  try {
    const data = await res.json();
    return data.error || fallback;
  } catch {
    return fallback;
  }
}

// Cognito needs its own sign-out page to end the session there too
export function signOutUrl() {
  const back = encodeURIComponent(window.location.origin + "/");
  return `${DOMAIN}/logout?client_id=${CLIENT_ID}&logout_uri=${back}`;
}
