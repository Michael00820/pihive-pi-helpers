/**
 * Verifies a Pi user access token with the Pi Platform API (GET /v2/me, Bearer user token).
 *
 * This should be the ONLY source of a user's identity. Nothing the browser sends (uid, username,
 * wallet address, role) is trusted. /v2/me needs the user's token, not the server API key.
 */
import { z } from "zod";
import { PI_API_BASE_URL } from "../networks.js";

const DEFAULT_TIMEOUT_MS = 8_000;

export type PiIdentity = {
  uid: string;
  username: string | null;
  walletAddress: string | null;
};

export type PiAuthErrorKind = "invalid_token" | "unavailable";

export class PiAuthError extends Error {
  constructor(
    public readonly kind: PiAuthErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "PiAuthError";
  }
}

// UserDTO from the Pi docs. `username` needs the username scope. `wallet_address` is read if
// Pi includes it (wallet_address scope); unknown fields are ignored.
const userDtoSchema = z.object({
  uid: z.string().trim().min(1).max(255),
  username: z.string().trim().min(1).max(255).nullish(),
  wallet_address: z.string().trim().min(1).max(255).nullish(),
});

export type VerifyOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
};

export async function verifyPiAccessToken(accessToken: string, opts: VerifyOptions = {}): Promise<PiIdentity> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const url = `${opts.baseUrl ?? PI_API_BASE_URL}/v2/me`;

  let res: Response;
  try {
    res = await doFetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    throw new PiAuthError("unavailable", "Could not reach Pi to verify the sign-in");
  }

  if (res.status === 401 || res.status === 403) {
    throw new PiAuthError("invalid_token", "Pi rejected the access token");
  }
  if (res.status >= 500 || res.status === 429) {
    throw new PiAuthError("unavailable", `Pi returned ${res.status}`);
  }
  if (!res.ok) {
    throw new PiAuthError("invalid_token", `Pi returned ${res.status}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new PiAuthError("unavailable", "Pi returned an unreadable response");
  }
  const parsed = userDtoSchema.safeParse(body);
  if (!parsed.success) {
    throw new PiAuthError("unavailable", "Pi returned an unexpected user record");
  }
  return {
    uid: parsed.data.uid,
    username: parsed.data.username ?? null,
    walletAddress: parsed.data.wallet_address ?? null,
  };
}
