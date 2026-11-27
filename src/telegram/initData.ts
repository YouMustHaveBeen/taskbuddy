import { safeEqual, toHex } from "../core/crypto";

const encoder = new TextEncoder();

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

export async function verifyInitData(
  initData: string,
  botToken: string,
  now: number,
  maxAgeMs: number,
): Promise<number | undefined> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return undefined;
  params.delete("hash");
  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = await hmac(encoder.encode("WebAppData"), botToken);
  const expected = toHex(await hmac(secret, checkString));
  if (!(await safeEqual(expected, hash))) return undefined;

  const authDate = Number(params.get("auth_date")) * 1000;
  if (!Number.isFinite(authDate) || now - authDate > maxAgeMs) return undefined;

  try {
    const id = (JSON.parse(params.get("user") ?? "") as { id?: unknown }).id;
    return typeof id === "number" ? id : undefined;
  } catch {
    return undefined;
  }
}
