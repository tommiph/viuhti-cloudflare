import type { Env } from "../cloudflare.config";

const COOKIE_NAME = "viuhti_session";
const SESSION_TTL_SEC = 30 * 24 * 60 * 60; // 30 days
const textEncoder = new TextEncoder();

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function fromHex(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(input));
  return new Uint8Array(digest);
}

async function hmacSignHex(secret: string, message: string): Promise<string> {
  const keyBytes = await sha256(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, textEncoder.encode(message));
  return toHex(sig);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  // Cloudflare Workers supports crypto.subtle.timingSafeEqual
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (x: BufferSource, y: BufferSource) => boolean;
  };
  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(a, b);
  }
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function getPassphrase(env: Env): string {
  return String(env.APP_PASSPHRASE || "").trim();
}

function getSigningSecret(env: Env): string {
  const s = String(env.SESSION_SECRET || "").trim();
  if (s) return s;
  const p = getPassphrase(env);
  return p ? `viuhti-derived:${p}` : "";
}

export function isAuthLockEnabled(env: Env): boolean {
  return Boolean(getPassphrase(env));
}

export function parseCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export async function verifyPassphrase(env: Env, candidate: string): Promise<boolean> {
  const expected = getPassphrase(env);
  if (!expected) return true;
  const [a, b] = await Promise.all([sha256(expected), sha256(String(candidate || ""))]);
  return constantTimeEqual(a, b);
}

export async function createSessionCookie(request: Request, env: Env): Promise<string> {
  const secret = getSigningSecret(env);
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const payload = `v1.${exp}`;
  const sig = await hmacSignHex(secret, payload);
  const token = `${payload}.${sig}`;
  const isHttps = new URL(request.url).protocol === "https:";
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SEC}`,
    ...(isHttps ? ["Secure"] : []),
  ].join("; ");
}

export function clearSessionCookie(request: Request): string {
  const isHttps = new URL(request.url).protocol === "https:";
  return [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    ...(isHttps ? ["Secure"] : []),
  ].join("; ");
}

export async function isSessionAuthenticated(request: Request, env: Env): Promise<boolean> {
  if (!isAuthLockEnabled(env)) return true;
  const secret = getSigningSecret(env);
  if (!secret) return false;
  const raw = parseCookie(request, COOKIE_NAME);
  if (!raw) return false;
  const parts = raw.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const actualBytes = fromHex(parts[2]);
  if (!actualBytes) return false;
  const expectedHex = await hmacSignHex(secret, `${parts[0]}.${parts[1]}`);
  const expectedBytes = fromHex(expectedHex);
  if (!expectedBytes) return false;
  return constantTimeEqual(actualBytes, expectedBytes);
}

export async function createIcsFeedToken(env: Env): Promise<string | null> {
  if (!isAuthLockEnabled(env)) return null;
  const secret = getSigningSecret(env);
  if (!secret) return null;
  const sig = await hmacSignHex(secret, "viuhti-ics-feed-v1");
  return sig.slice(0, 32);
}

export async function isIcsTokenValid(request: Request, env: Env): Promise<boolean> {
  if (!isAuthLockEnabled(env)) return true;
  const url = new URL(request.url);
  const candidate = String(url.searchParams.get("token") || "").trim();
  if (!candidate) return false;
  const expected = await createIcsFeedToken(env);
  if (!expected) return false;
  return constantTimeEqual(textEncoder.encode(candidate), textEncoder.encode(expected));
}
