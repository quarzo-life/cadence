const DEFAULT_SCOPE = "https://www.googleapis.com/auth/calendar";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const JWT_LIFETIME_SEC = 3600; // Google's hard ceiling
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

export interface GoogleAuth {
  getAccessToken(userEmail: string): Promise<string>;
  invalidate(userEmail: string): void;
}

export interface GoogleAuthOptions {
  scope?: string;
  now?: () => number;
  fetchFn?: typeof fetch;
}

export function createGoogleAuth(
  saEmail: string,
  saPrivateKeyPem: string,
  options: GoogleAuthOptions = {},
): GoogleAuth {
  const scope = options.scope ?? DEFAULT_SCOPE;
  const now = options.now ?? (() => Date.now());
  const fetchFn = options.fetchFn ?? fetch;

  const cache = new Map<string, CachedToken>();
  let keyPromise: Promise<CryptoKey> | null = null;

  function getKey(): Promise<CryptoKey> {
    if (!keyPromise) keyPromise = importPkcs8(saPrivateKeyPem);
    return keyPromise;
  }

  async function exchange(userEmail: string): Promise<CachedToken> {
    const key = await getKey();
    const nowSec = Math.floor(now() / 1000);
    const jwt = await signServiceAccountJwt(key, {
      iss: saEmail,
      sub: userEmail,
      scope,
      aud: TOKEN_ENDPOINT,
      iat: nowSec,
      exp: nowSec + JWT_LIFETIME_SEC,
    });

    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    });

    let res: Response;
    try {
      res = await fetchFn(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch (err) {
      throw new Error(
        `google token exchange network error for sub=${userEmail}: ${(err as Error).message}`,
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `google token exchange failed for sub=${userEmail}: ${res.status} ${text}`,
      );
    }

    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token || typeof json.expires_in !== "number") {
      throw new Error(`google token exchange returned invalid body for sub=${userEmail}`);
    }

    return {
      accessToken: json.access_token,
      expiresAt: now() + json.expires_in * 1000,
    };
  }

  return {
    async getAccessToken(userEmail) {
      const cached = cache.get(userEmail);
      if (cached && cached.expiresAt - now() > REFRESH_BUFFER_MS) {
        return cached.accessToken;
      }
      const fresh = await exchange(userEmail);
      cache.set(userEmail, fresh);
      return fresh.accessToken;
    },
    invalidate(userEmail) {
      cache.delete(userEmail);
    },
  };
}

// -- JWT primitives (exported for testing) ----------------------------------

export interface JwtClaims {
  iss: string;
  sub: string;
  scope: string;
  aud: string;
  iat: number;
  exp: number;
}

export function base64urlEncode(data: Uint8Array): string {
  let bin = "";
  for (const b of data) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlEncodeString(s: string): string {
  return base64urlEncode(new TextEncoder().encode(s));
}

export async function importPkcs8(pem: string): Promise<CryptoKey> {
  const cleaned = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  if (cleaned.length === 0) {
    throw new Error("importPkcs8: PEM body is empty (check BEGIN/END markers and newlines)");
  }
  let bin: string;
  try {
    bin = atob(cleaned);
  } catch (err) {
    throw new Error(`importPkcs8: PEM base64 decode failed: ${(err as Error).message}`);
  }
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function signServiceAccountJwt(
  key: CryptoKey,
  claims: JwtClaims,
): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const encHeader = base64urlEncodeString(JSON.stringify(header));
  const encPayload = base64urlEncodeString(JSON.stringify(claims));
  const signingInput = `${encHeader}.${encPayload}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64urlEncode(new Uint8Array(sig))}`;
}
