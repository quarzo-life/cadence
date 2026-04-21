import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  base64urlEncodeString,
  createGoogleAuth,
  importPkcs8,
  type JwtClaims,
  signServiceAccountJwt,
} from "../google-auth.ts";

async function generateTestPem(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const kp = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
  let bin = "";
  for (const b of new Uint8Array(pkcs8)) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  const lines = b64.match(/.{1,64}/g)!.join("\n");
  const pem = `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
  return { pem, publicKey: kp.publicKey };
}

function base64urlDecode(s: string): Uint8Array {
  const pad = "===".slice((s.length + 3) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJwt(jwt: string): {
  header: Record<string, unknown>;
  payload: JwtClaims;
  signingInput: Uint8Array;
  signature: Uint8Array;
} {
  const [h, p, s] = jwt.split(".");
  const dec = (x: string) => new TextDecoder().decode(base64urlDecode(x));
  return {
    header: JSON.parse(dec(h)),
    payload: JSON.parse(dec(p)) as JwtClaims,
    signingInput: new TextEncoder().encode(`${h}.${p}`),
    signature: base64urlDecode(s),
  };
}

Deno.test("base64urlEncode — url-safe alphabet, no padding", () => {
  assertEquals(base64urlEncodeString(""), "");
  assertEquals(base64urlEncodeString("hi?"), "aGk_");
  assertEquals(base64urlEncodeString("sure."), "c3VyZS4");
});

Deno.test("importPkcs8 — rejects empty or malformed PEM", async () => {
  await assertRejects(
    () => importPkcs8("-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----\n"),
    Error,
    "PEM body is empty",
  );
  await assertRejects(() => importPkcs8("not a pem at all"), Error);
});

Deno.test("signServiceAccountJwt — produces a verifiable RS256 JWT", async () => {
  const { pem, publicKey } = await generateTestPem();
  const key = await importPkcs8(pem);
  const claims: JwtClaims = {
    iss: "sa@project.iam.gserviceaccount.com",
    sub: "alice@co.com",
    scope: "https://www.googleapis.com/auth/calendar",
    aud: "https://oauth2.googleapis.com/token",
    iat: 1_700_000_000,
    exp: 1_700_003_600,
  };
  const jwt = await signServiceAccountJwt(key, claims);
  const { header, payload, signingInput, signature } = decodeJwt(jwt);
  assertEquals(header, { alg: "RS256", typ: "JWT" });
  assertEquals(payload, claims);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    new Uint8Array(signature),
    new Uint8Array(signingInput),
  );
  assert(ok, "signature must verify against matching public key");
});

Deno.test("createGoogleAuth — caches token per sub within TTL", async () => {
  const { pem } = await generateTestPem();
  let fetchCalls = 0;
  const assertions: string[] = [];
  const fakeFetch: typeof fetch = (_url, init) => {
    fetchCalls++;
    const body = (init as RequestInit).body as URLSearchParams;
    assertions.push(body.get("assertion")!);
    return Promise.resolve(
      new Response(
        JSON.stringify({ access_token: `tok-${fetchCalls}`, expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  };
  let clock = 1_700_000_000_000;
  const auth = createGoogleAuth("sa@p.iam.gserviceaccount.com", pem, {
    now: () => clock,
    fetchFn: fakeFetch,
  });

  assertEquals(await auth.getAccessToken("alice@co.com"), "tok-1");
  assertEquals(await auth.getAccessToken("alice@co.com"), "tok-1");
  assertEquals(fetchCalls, 1);

  assertEquals(await auth.getAccessToken("bob@co.com"), "tok-2");
  assertEquals(fetchCalls, 2);

  const p1 = decodeJwt(assertions[0]).payload;
  const p2 = decodeJwt(assertions[1]).payload;
  assertEquals(p1.iss, "sa@p.iam.gserviceaccount.com");
  assertEquals(p1.sub, "alice@co.com");
  assertEquals(p1.aud, "https://oauth2.googleapis.com/token");
  assertEquals(p1.scope, "https://www.googleapis.com/auth/calendar");
  assertEquals(p1.exp - p1.iat, 3600);
  assertEquals(p2.sub, "bob@co.com");
});

Deno.test("createGoogleAuth — refreshes within 5-min buffer before expiry", async () => {
  const { pem } = await generateTestPem();
  let fetchCalls = 0;
  const fakeFetch: typeof fetch = () => {
    fetchCalls++;
    return Promise.resolve(
      new Response(
        JSON.stringify({ access_token: `tok-${fetchCalls}`, expires_in: 3600 }),
        { status: 200 },
      ),
    );
  };
  let clock = 1_700_000_000_000;
  const auth = createGoogleAuth("sa@p.iam.gserviceaccount.com", pem, {
    now: () => clock,
    fetchFn: fakeFetch,
  });

  await auth.getAccessToken("alice@co.com"); // tok-1, expires at clock + 3600s
  clock += (3600 - 5 * 60 - 1) * 1000; // just inside the safe window
  assertEquals(await auth.getAccessToken("alice@co.com"), "tok-1");
  assertEquals(fetchCalls, 1);

  clock += 2 * 1000; // now crossed into the refresh buffer
  assertEquals(await auth.getAccessToken("alice@co.com"), "tok-2");
  assertEquals(fetchCalls, 2);
});

Deno.test("createGoogleAuth — throws with context on non-2xx", async () => {
  const { pem } = await generateTestPem();
  const fakeFetch: typeof fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );
  const auth = createGoogleAuth("sa@p.iam.gserviceaccount.com", pem, {
    fetchFn: fakeFetch,
  });
  await assertRejects(
    () => auth.getAccessToken("alice@co.com"),
    Error,
    "google token exchange failed",
  );
});

Deno.test("createGoogleAuth — invalidate forces refresh", async () => {
  const { pem } = await generateTestPem();
  let fetchCalls = 0;
  const fakeFetch: typeof fetch = () => {
    fetchCalls++;
    return Promise.resolve(
      new Response(
        JSON.stringify({ access_token: `tok-${fetchCalls}`, expires_in: 3600 }),
        { status: 200 },
      ),
    );
  };
  const auth = createGoogleAuth("sa@p.iam.gserviceaccount.com", pem, {
    fetchFn: fakeFetch,
  });
  await auth.getAccessToken("alice@co.com");
  auth.invalidate("alice@co.com");
  await auth.getAccessToken("alice@co.com");
  assertEquals(fetchCalls, 2);
});

Deno.test("createGoogleAuth — rejects malformed token response body", async () => {
  const { pem } = await generateTestPem();
  const fakeFetch: typeof fetch = () =>
    Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
  const auth = createGoogleAuth("sa@p.iam.gserviceaccount.com", pem, {
    fetchFn: fakeFetch,
  });
  await assertRejects(
    () => auth.getAccessToken("alice@co.com"),
    Error,
    "invalid body",
  );
});
