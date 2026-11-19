/**
 * Minimal client for the Pi Platform API's U2A payment endpoints, authorised with the server
 * API key only (`Authorization: Key <apiKey>`). It never sees a wallet seed.
 *
 *   GET  /v2/payments/:id            PaymentDTO
 *   POST /v2/payments/:id/approve    server-side approval
 *   POST /v2/payments/:id/complete   { txid } server-side completion
 *   POST /v2/payments/:id/cancel     cancel
 *
 * Everything Pi returns is validated with zod. Nothing the browser sends is used except ids.
 */
import { z } from "zod";
import { PI_API_BASE_URL } from "../networks.js";

const DEFAULT_TIMEOUT_MS = 10_000;

/** Pi payment ids and txids are opaque tokens; refuse anything that could change the URL path. */
export const piIdSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/, "invalid id");

export const paymentDtoSchema = z.object({
  identifier: z.string().min(1),
  user_uid: z.string().min(1),
  amount: z.number().positive(),
  memo: z.string().default(""),
  metadata: z.record(z.string(), z.unknown()).nullish().transform((m) => m ?? {}),
  from_address: z.string().nullish(),
  to_address: z.string().nullish(),
  direction: z.string(),
  created_at: z.string().nullish(),
  network: z.string(),
  status: z.object({
    developer_approved: z.boolean(),
    transaction_verified: z.boolean(),
    developer_completed: z.boolean(),
    cancelled: z.boolean(),
    user_cancelled: z.boolean(),
  }),
  transaction: z
    .object({ txid: z.string().min(1), verified: z.boolean(), _link: z.string().nullish() })
    .nullish()
    .transform((t) => t ?? null),
});
export type PiPayment = z.infer<typeof paymentDtoSchema>;

export type PiApiErrorKind = "not_found" | "rejected" | "unavailable";

export class PiApiError extends Error {
  constructor(
    public readonly kind: PiApiErrorKind,
    public readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "PiApiError";
  }
}

export type PiPlatformOptions = {
  apiKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
};

export interface PiPlatform {
  getPayment(paymentId: string): Promise<PiPayment>;
  approvePayment(paymentId: string): Promise<PiPayment>;
  completePayment(paymentId: string, txid: string): Promise<PiPayment>;
  cancelPayment(paymentId: string): Promise<PiPayment>;
}

export function createPiPlatform(opts: PiPlatformOptions): PiPlatform {
  const base = `${opts.baseUrl ?? PI_API_BASE_URL}/v2/payments`;

  async function call(method: "GET" | "POST", paymentId: string, action?: string, body?: unknown): Promise<PiPayment> {
    const id = piIdSchema.parse(paymentId);
    const url = `${base}/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;
    const doFetch = opts.fetchImpl ?? globalThis.fetch;
    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers: {
          Authorization: `Key ${opts.apiKey}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch {
      throw new PiApiError("unavailable", null, `Could not reach Pi (${action ?? "get"} payment)`);
    }
    if (res.status === 404) throw new PiApiError("not_found", 404, "Pi doesn't know this payment");
    if (res.status >= 500 || res.status === 429) throw new PiApiError("unavailable", res.status, `Pi returned ${res.status}`);
    if (!res.ok) throw new PiApiError("rejected", res.status, `Pi refused ${action ?? "get"} (${res.status})`);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new PiApiError("unavailable", res.status, "Pi returned an unreadable response");
    }
    const parsed = paymentDtoSchema.safeParse(json);
    if (!parsed.success) throw new PiApiError("unavailable", res.status, "Pi returned an unexpected payment record");
    return parsed.data;
  }

  return {
    getPayment: (id) => call("GET", id),
    approvePayment: (id) => call("POST", id, "approve"),
    completePayment: (id, txid) => call("POST", id, "complete", { txid: piIdSchema.parse(txid) }),
    cancelPayment: (id) => call("POST", id, "cancel"),
  };
}
