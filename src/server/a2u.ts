/**
 * App-to-user (A2U) payments: the only module that talks to the Pi Platform A2U API, signs
 * transactions, and holds the app wallet seed. The seed is kept in a closure and is never
 * returned, logged, or put on an object that could be serialised. Error messages that leave
 * this module go through `safeError`, which strips anything that looks like a seed or the API key.
 *
 * This is a small direct implementation (fetch + @stellar/stellar-sdk) of what the unmaintained
 * `pi-backend` 0.1.3 SDK did, with the same behaviour: create payment -> load app account ->
 * base fee -> 180 s time bounds -> one native payment with memo = payment id -> sign -> submit ->
 * complete.
 *
 * Before the signed transaction is sent, `onSigned` receives its hash and max time bound so the
 * host can store them first. If anything goes wrong after that, the host knows which transaction
 * to look for, and when it can no longer be included on chain.
 *
 * Pass the API key and wallet seed in explicitly. This module does not read process.env, so a
 * host app should pass its own configuration (and never ship those values in this package).
 */
import * as StellarNs from "@stellar/stellar-sdk";
import { z } from "zod";
import { PI_API_BASE_URL, PI_HORIZON_URLS, PI_NETWORK_NAMES, type PiNetwork, type PiNetworkName } from "../networks.js";
import { EnvError } from "./errors.js";

// ESM/CJS interop: depending on how it is loaded, the namespace may sit under `.default`.
const Stellar = ((StellarNs as unknown as { Horizon?: unknown }).Horizon ? StellarNs : (StellarNs as unknown as { default: unknown }).default) as typeof StellarNs;

/** pi-backend 0.1.3 signed with 180-second time bounds; we keep exactly that. */
const TX_TIMEBOUND_SECONDS = 180;
/** pi-backend's axios client used a 20 s timeout for Pi Platform API calls. */
const PI_API_TIMEOUT_MS = 20_000;

export type NetworkName = PiNetworkName;

/** Pi's PaymentDTO (what pi-backend returns). */
export type A2UPayment = {
  identifier: string;
  user_uid: string;
  amount: number | string;
  memo: string;
  metadata: Record<string, unknown> | null;
  from_address: string;
  to_address: string;
  direction: "user_to_app" | "app_to_user";
  status: { developer_approved: boolean; transaction_verified: boolean; developer_completed: boolean; cancelled: boolean; user_cancelled: boolean };
  transaction: { txid: string; verified: boolean; _link?: string } | null;
  created_at: string;
  network: string;
};

export type SignedInfo = { hash: string; maxTime: Date | null };

/** What a payout worker needs from Pi. Tests use an in-memory fake with the same shape. */
export interface A2UClient {
  readonly network: NetworkName;
  /** Public key of the app wallet (never the seed). */
  readonly appWallet: string;
  createPayment(args: { amount: number; memo: string; metadata: Record<string, unknown>; uid: string }): Promise<string>;
  getPayment(paymentId: string): Promise<A2UPayment>;
  /** Builds, signs and submits. `onSigned` runs (and must succeed) before anything is sent. */
  submitPayment(paymentId: string, hooks: { onSigned(info: SignedInfo): Promise<void> }): Promise<string>;
  completePayment(paymentId: string, txid: string): Promise<A2UPayment>;
  cancelPayment(paymentId: string): Promise<A2UPayment>;
  getIncompleteServerPayments(): Promise<A2UPayment[]>;
}

/** Read-only Horizon queries used to settle ambiguous outcomes and reconcile the wallet. */
export type HorizonTx = { hash: string; successful: boolean; memo: string | null; feeChargedU: bigint; payments: { to: string; amountU: bigint }[] };
export interface HorizonReader {
  /** null = Horizon answered 404 (no such transaction). Throws on any other failure. */
  getTransaction(hash: string): Promise<HorizonTx | null>;
  /** Most recent transactions of `account` with a text memo equal to `memo` (null if none). */
  findByMemo(account: string, memo: string): Promise<HorizonTx | null>;
  /** Native balance in units, or null if the account doesn't exist on this network. */
  nativeBalance(account: string): Promise<bigint | null>;
}

/** Thrown when the worker should treat a failure as "nothing was sent" (before signing). */
export class NotSentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotSentError";
  }
}

export type A2UConfig = {
  network: PiNetwork;
  /** Server API key of the Pi app. Without it, payouts are disabled. */
  apiKey?: string;
  /** App wallet secret seed (56 characters starting with S). Never log or return this. */
  walletSecret?: string;
  /** Optional Horizon base URL; defaults to Pi's public Horizon for `network`. */
  horizonUrl?: string;
};

export type A2UStatus = { enabled: boolean; reason?: string; appWallet?: string; network: NetworkName; horizonUrl: string };

const seedSchema = z
  .string()
  .trim()
  .regex(/^S[A-Z2-7]{55}$/, "must be a Stellar secret seed (56 characters starting with S)");

/**
 * Checks the wallet seed without exposing it. Throws EnvError (naming only the setting) if
 * it is set but malformed, so a bad deploy fails at startup instead of at the first payout.
 */
export function a2uStatus(config: A2UConfig): A2UStatus {
  const network = PI_NETWORK_NAMES[config.network];
  const horizonUrl = (config.horizonUrl ?? PI_HORIZON_URLS[config.network]).replace(/\/+$/, "");
  const seed = config.walletSecret?.trim() || undefined;
  if (!seed) return { enabled: false, reason: "walletSecret is not set", network, horizonUrl };
  const parsed = seedSchema.safeParse(seed);
  if (!parsed.success) throw new EnvError(`Invalid walletSecret: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  let appWallet: string;
  try {
    appWallet = Stellar.Keypair.fromSecret(parsed.data).publicKey();
  } catch {
    throw new EnvError("Invalid walletSecret: not a valid Stellar secret seed");
  }
  if (!config.apiKey) return { enabled: false, reason: "apiKey is not set", appWallet, network, horizonUrl };
  return { enabled: true, appWallet, network, horizonUrl };
}

/** App wallet public key derived from the seed, or undefined if unset/invalid. Never returns the secret. */
export function appWalletPublicKey(config: A2UConfig): string | undefined {
  try {
    return a2uStatus(config).appWallet;
  } catch {
    return undefined;
  }
}

const SEED_RE = /S[A-Z2-7]{55}/g;

/** A short, log-safe description of an error from Pi, Horizon or the signing client. */
export function safeError(err: unknown, secrets: string[] = []): string {
  const e = err as {
    message?: string;
    response?: { status?: number; data?: { error?: string; error_message?: string; title?: string; extras?: { result_codes?: unknown } } };
  };
  let msg: string;
  if (e?.response?.status) {
    const d = e.response.data ?? {};
    const codes = d.extras?.result_codes ? ` ${JSON.stringify(d.extras.result_codes)}` : "";
    msg = `HTTP ${e.response.status}: ${d.error_message ?? d.error ?? d.title ?? "request failed"}${codes}`;
  } else {
    msg = typeof e?.message === "string" ? e.message : String(err);
  }
  msg = msg.replace(SEED_RE, "[redacted]");
  for (const s of secrets) if (s && s.length >= 8) msg = msg.split(s).join("[redacted]");
  return msg.slice(0, 500);
}

/** Horizon result codes from a failed submit (e.g. ["op_no_destination"]), if any. */
export function resultCodes(err: unknown): string[] {
  const rc = (err as { response?: { data?: { extras?: { result_codes?: { transaction?: string; operations?: string[] } } } } })?.response?.data?.extras
    ?.result_codes;
  if (!rc) return [];
  return [rc.transaction, ...(rc.operations ?? [])].filter((x): x is string => typeof x === "string");
}

export function normaliseIncomplete(r: unknown): A2UPayment[] {
  // The SDK types say PaymentDTO[], but the API returns { incomplete_server_payments: [...] }.
  if (Array.isArray(r)) return r as A2UPayment[];
  const list = (r as { incomplete_server_payments?: unknown })?.incomplete_server_payments;
  return Array.isArray(list) ? (list as A2UPayment[]) : [];
}

export type A2UFactory = {
  status: A2UStatus;
  /** A fresh client for one worker run. Throws if payouts aren't configured. */
  createClient(): A2UClient;
  horizon: HorizonReader;
};

/**
 * Builds the factory from explicit configuration. `piApiBaseUrl` exists only so tests can point
 * the client at a local fake; production always uses https://api.minepi.com.
 */
export function createA2UFactory(
  config: A2UConfig,
  opts: { piApiBaseUrl?: string; fetchImpl?: typeof fetch } = {},
): A2UFactory {
  const status = a2uStatus(config);
  const horizon = createHorizonReader(status.horizonUrl, opts.fetchImpl);
  return {
    status,
    horizon,
    createClient() {
      if (!status.enabled) throw new Error(`A2U payouts are not configured: ${status.reason}`);
      const seed = config.walletSecret!.trim();
      const apiKey = config.apiKey!;
      return createDirectClient(seed, apiKey, {
        network: status.network,
        appWallet: status.appWallet!,
        horizonUrl: status.horizonUrl,
        piApiBaseUrl: (opts.piApiBaseUrl ?? PI_API_BASE_URL).replace(/\/+$/, ""),
        fetchImpl: opts.fetchImpl,
        secrets: [seed, apiKey],
      });
    },
  };
}

/** An error shaped like the axios errors pi-backend threw, so safeError/resultCodes keep working. */
class PiHttpError extends Error {
  constructor(public readonly response: { status: number; data: unknown }) {
    super(`Pi API request failed with status code ${response.status}`);
  }
}

function createDirectClient(
  seed: string,
  apiKey: string,
  cfg: { network: NetworkName; appWallet: string; horizonUrl: string; piApiBaseUrl: string; fetchImpl?: typeof fetch; secrets: string[] },
): A2UClient {
  // The keypair lives only in this closure; it is never put on the returned object.
  const keypair = Stellar.Keypair.fromSecret(seed);
  const allowHttp = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(cfg.horizonUrl);

  const piRequest = async <T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
    const f = cfg.fetchImpl ?? fetch;
    const res = await f(`${cfg.piApiBaseUrl}${path}`, {
      method,
      headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(PI_API_TIMEOUT_MS),
      redirect: "error",
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* keep raw text */
    }
    if (!res.ok) throw new PiHttpError({ status: res.status, data });
    return data as T;
  };

  const clean = (err: unknown): Error => {
    if (err instanceof NotSentError) return new NotSentError(safeError(err, cfg.secrets));
    const out = new Error(safeError(err, cfg.secrets)) as Error & { status?: number; resultCodes?: string[] };
    out.status = (err as { response?: { status?: number } })?.response?.status;
    out.resultCodes = resultCodes(err);
    return out;
  };
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw clean(err);
    }
  };

  const getPayment = (id: string) => piRequest<A2UPayment>("GET", `/v2/payments/${encodeURIComponent(id)}`);

  return {
    network: cfg.network,
    appWallet: cfg.appWallet,
    createPayment: (args) =>
      call(async () => {
        if (!args.amount) throw new Error("Missing amount");
        if (!args.memo) throw new Error("Missing memo");
        if (!args.metadata) throw new Error("Missing metadata");
        if (!args.uid) throw new Error("Missing uid");
        const p = await piRequest<A2UPayment>("POST", "/v2/payments", { payment: args });
        return p.identifier;
      }),
    getPayment: (id) => call(() => getPayment(id)),
    async submitPayment(id, hooks) {
      let signedHash: string | null = null;
      try {
        const payment = await getPayment(id);
        if (payment.transaction?.txid) throw new NotSentError(JSON.stringify({ message: "This payment already has a linked txid", paymentId: id, txid: payment.transaction.txid }));
        // Pin Horizon and the passphrase to the configured network: a payment for the other network is refused.
        if (payment.network !== cfg.network) throw new NotSentError(`payment is on "${payment.network}", this server is set up for "${cfg.network}"`);
        if (payment.from_address !== keypair.publicKey()) throw new NotSentError("You should use a private seed of your app wallet!");
        const server = new Stellar.Horizon.Server(cfg.horizonUrl, { allowHttp });
        const account = await server.loadAccount(keypair.publicKey());
        const baseFee = await server.fetchBaseFee();
        const timebounds = await server.fetchTimebounds(TX_TIMEBOUND_SECONDS);
        const tx = new Stellar.TransactionBuilder(account, { fee: baseFee.toString(), networkPassphrase: cfg.network, timebounds })
          .addOperation(Stellar.Operation.payment({ destination: payment.to_address, asset: Stellar.Asset.native(), amount: payment.amount.toString() }))
          .addMemo(Stellar.Memo.text(payment.identifier))
          .build();
        tx.sign(keypair);
        const hash = Buffer.from(tx.hash()).toString("hex");
        const maxTime = tx.timeBounds?.maxTime ? new Date(Number(tx.timeBounds.maxTime) * 1000) : null;
        // Persist the hash first. If this fails, nothing has been sent.
        await hooks.onSigned({ hash, maxTime });
        signedHash = hash;
        const res = (await server.submitTransaction(tx)) as { id?: string; hash?: string };
        // Horizon returns the transaction id (= hash); fall back to the hash we signed.
        return res.id || res.hash || hash;
      } catch (err) {
        // Anything that failed before the hash was stored can't have reached the chain.
        const e = clean(err);
        if (!signedHash && !(e instanceof NotSentError)) throw new NotSentError(e.message);
        throw e;
      }
    },
    completePayment: (id, txid) => call(() => piRequest<A2UPayment>("POST", `/v2/payments/${encodeURIComponent(id)}/complete`, { txid })),
    cancelPayment: (id) => call(() => piRequest<A2UPayment>("POST", `/v2/payments/${encodeURIComponent(id)}/cancel`)),
    getIncompleteServerPayments: () => call(async () => normaliseIncomplete(await piRequest<unknown>("GET", "/v2/payments/incomplete_server_payments"))),
  };
}

// ---------------------------------------------------------------------------
// Horizon (read-only, plain fetch)
// ---------------------------------------------------------------------------

const toU = (amount: string): bigint => {
  const parts = amount.split(".");
  const w = parts[0] ?? "0";
  const f = parts[1] ?? "";
  return BigInt(w) * 10_000_000n + BigInt((f + "0000000").slice(0, 7));
};

export function createHorizonReader(baseUrl: string, fetchImpl?: typeof fetch): HorizonReader {
  const base = baseUrl.replace(/\/+$/, "");
  const get = async (path: string): Promise<unknown | null> => {
    const f = fetchImpl ?? fetch;
    const res = await f(`${base}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Horizon ${res.status} for ${path.split("?")[0]}`);
    return res.json();
  };
  type TxRecord = { hash: string; successful: boolean; memo?: string; memo_type?: string; fee_charged: string | number };
  const withPayments = async (t: TxRecord): Promise<HorizonTx> => {
    const ops = (await get(`/transactions/${t.hash}/operations?limit=20`)) as { _embedded?: { records?: { type: string; to?: string; amount?: string }[] } } | null;
    return {
      hash: t.hash,
      successful: t.successful !== false,
      memo: t.memo ?? null,
      feeChargedU: BigInt(String(t.fee_charged ?? 0)),
      payments: (ops?._embedded?.records ?? []).filter((o) => o.type === "payment" && o.to && o.amount).map((o) => ({ to: o.to!, amountU: toU(o.amount!) })),
    };
  };
  return {
    async getTransaction(hash) {
      if (!/^[0-9a-f]{64}$/i.test(hash)) throw new Error("not a transaction hash");
      const t = (await get(`/transactions/${hash}`)) as TxRecord | null;
      return t ? withPayments(t) : null;
    },
    async findByMemo(account, memo) {
      const page = (await get(`/accounts/${encodeURIComponent(account)}/transactions?order=desc&limit=200`)) as {
        _embedded?: { records?: TxRecord[] };
      } | null;
      const hit = page?._embedded?.records?.find((r) => r.memo === memo);
      return hit ? withPayments(hit) : null;
    },
    async nativeBalance(account) {
      const a = (await get(`/accounts/${encodeURIComponent(account)}`)) as { balances?: { asset_type: string; balance: string }[] } | null;
      const native = a?.balances?.find((b) => b.asset_type === "native");
      return native ? toU(native.balance) : null;
    },
  };
}

/**
 * Host-supplied payout ceilings. The host should load current rolling totals from its own store
 * and refuse (or queue) a payout that would exceed any of these. This helper only compares
 * integers; it does not read environment variables or a database.
 */
export type PayoutLimitCheck = {
  amountU: bigint;
  maxPerTxU: bigint;
  userDailyUsedU: bigint;
  userDailyCapU: bigint;
  walletHourlyUsedU: bigint;
  walletHourlyCapU: bigint;
  walletDailyUsedU: bigint;
  walletDailyCapU: bigint;
};

export type PayoutLimitResult = { ok: true } | { ok: false; reason: "max_per_tx" | "user_daily_cap" | "wallet_hourly_cap" | "wallet_daily_cap" };

export function checkPayoutLimits(check: PayoutLimitCheck): PayoutLimitResult {
  if (check.amountU > check.maxPerTxU) return { ok: false, reason: "max_per_tx" };
  if (check.userDailyUsedU + check.amountU > check.userDailyCapU) return { ok: false, reason: "user_daily_cap" };
  if (check.walletHourlyUsedU + check.amountU > check.walletHourlyCapU) return { ok: false, reason: "wallet_hourly_cap" };
  if (check.walletDailyUsedU + check.amountU > check.walletDailyCapU) return { ok: false, reason: "wallet_daily_cap" };
  return { ok: true };
}
