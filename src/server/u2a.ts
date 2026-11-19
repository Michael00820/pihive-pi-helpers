/**
 * Generic user-to-app (U2A) approve / complete / cancel / incomplete-payment helpers.
 *
 * These call the Pi Platform API and run shared safety checks (payer, direction, network,
 * destination wallet, optional amount and metadata). Persistence is left to the host app
 * through small hooks — there is no database schema, job, escrow, or fee logic here.
 *
 * Typical order for a successful payment:
 *   1. The browser calls payWithPi() with a server-made intent.
 *   2. onReadyForServerApproval -> approveU2APayment() (GET, checks, then POST /approve).
 *   3. The user signs in the wallet.
 *   4. onReadyForServerCompletion -> completeU2APayment() (GET, checks, onVerified, then POST /complete).
 *
 * Record the payment in onVerified *before* Pi /complete is called, and make that write
 * idempotent (unique payment id / txid). If /complete then fails, the money is already on
 * chain; retry /complete later. Never cancel a payment that already has a blockchain tx.
 */
import { toUnits } from "../money.js";
import { PiApiError, type PiPayment, type PiPlatform } from "./platform.js";

export class U2AError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "U2AError";
  }
}

/** Checks the host app supplies for every U2A call. */
export type U2AContext = {
  pi: PiPlatform;
  /** Must match PaymentDTO.network, e.g. "Pi Testnet" or "Pi Network". */
  expectedNetwork: string;
  /** If set, PaymentDTO.to_address must equal this app wallet public key. */
  appWallet?: string;
};

export type U2AExpectations = {
  /** Signed-in user's Pi uid from /v2/me, never a value the browser claimed. */
  payerUid: string;
  /** If set, the payment amount must equal this (string or number, compared in 1e-7 units). */
  expectedAmount?: string | number;
  /** If set, the payment memo must equal this. */
  expectedMemo?: string;
  /** If set, each key must be present on the payment metadata with this exact value. */
  expectedMetadata?: Record<string, string>;
};

function metaString(p: PiPayment, key: string): string | null {
  const v = p.metadata?.[key];
  return typeof v === "string" ? v : null;
}

function amountsEqual(paymentAmount: number, expected: string | number): boolean {
  try {
    return toUnits(paymentAmount) === toUnits(expected);
  } catch {
    return false;
  }
}

/** Maps a Pi Platform client error to a U2AError the host can turn into an HTTP response. */
export async function getU2APayment(ctx: U2AContext, paymentId: string): Promise<PiPayment> {
  try {
    return await ctx.pi.getPayment(paymentId);
  } catch (err) {
    if (err instanceof PiApiError && err.kind === "not_found") {
      throw new U2AError(404, "unknown_payment", "Pi doesn't know this payment");
    }
    if (err instanceof PiApiError && err.kind === "rejected") {
      throw new U2AError(502, "pi_rejected", "Pi refused to show this payment");
    }
    throw new U2AError(503, "pi_unavailable", "Pi Network is not responding. Please try again shortly.");
  }
}

/**
 * Direction, network, payer and optional destination-wallet checks shared by every endpoint.
 * Does not approve or complete anything on its own.
 */
export function assertOwnU2APayment(ctx: U2AContext, payment: PiPayment, payerUid: string): void {
  if (payment.user_uid !== payerUid) {
    throw new U2AError(403, "wrong_payer", "This payment belongs to a different Pi account");
  }
  if (payment.direction !== "user_to_app") {
    throw new U2AError(400, "wrong_direction", "This is not a user-to-app payment");
  }
  if (payment.network !== ctx.expectedNetwork) {
    throw new U2AError(400, "wrong_network", `This payment is on ${payment.network}, but this server is set up for ${ctx.expectedNetwork}`);
  }
  if (ctx.appWallet && payment.to_address !== ctx.appWallet) {
    throw new U2AError(400, "wrong_recipient", "This payment is not addressed to this app's wallet");
  }
}

export function assertU2AExpectations(payment: PiPayment, expected: Omit<U2AExpectations, "payerUid">): void {
  if (expected.expectedAmount !== undefined && !amountsEqual(payment.amount, expected.expectedAmount)) {
    throw new U2AError(400, "wrong_amount", "This payment amount does not match what the server quoted");
  }
  if (expected.expectedMemo !== undefined && payment.memo !== expected.expectedMemo) {
    throw new U2AError(400, "wrong_memo", "This payment memo does not match what the server quoted");
  }
  if (expected.expectedMetadata) {
    for (const [key, value] of Object.entries(expected.expectedMetadata)) {
      if (metaString(payment, key) !== value) {
        throw new U2AError(400, "wrong_metadata", `This payment metadata does not match (${key})`);
      }
    }
  }
}

export type ApproveU2AOptions = U2AExpectations & {
  /**
   * Called after the payment has passed every check and before POST /approve.
   * Use it to persist "approving" state. If this throws, /approve is not called.
   */
  onBeforeApprove?: (payment: PiPayment) => Promise<void>;
};

/** GET the payment, run checks, optionally persist, then POST /approve. */
export async function approveU2APayment(ctx: U2AContext, paymentId: string, opts: ApproveU2AOptions): Promise<PiPayment> {
  const payment = await getU2APayment(ctx, paymentId);
  assertOwnU2APayment(ctx, payment, opts.payerUid);
  assertU2AExpectations(payment, opts);
  if (payment.status.cancelled || payment.status.user_cancelled) {
    throw new U2AError(409, "cancelled", "This payment was cancelled");
  }
  if (payment.status.developer_completed) {
    return payment;
  }
  if (payment.status.developer_approved) {
    return payment;
  }
  if (opts.onBeforeApprove) await opts.onBeforeApprove(payment);
  try {
    return await ctx.pi.approvePayment(payment.identifier);
  } catch (err) {
    if (err instanceof PiApiError && err.kind === "rejected") {
      throw new U2AError(502, "pi_rejected", "Pi refused to approve this payment");
    }
    throw new U2AError(503, "pi_unavailable", "Pi Network is not responding. Please try again shortly.");
  }
}

export type CompleteU2AOptions = U2AExpectations & {
  /**
   * Called once the payment is verified on Pi, *before* POST /complete.
   * Persist the credit here and make the write idempotent on payment id / txid.
   * If this throws, /complete is not called.
   */
  onVerified: (payment: PiPayment, txid: string) => Promise<void>;
};

export type CompleteU2AResult = { payment: PiPayment; completedOnPi: boolean };

/**
 * GET the payment, run checks, credit the user via onVerified, then POST /complete.
 * Safe to retry: a payment already completed on Pi is returned without calling onVerified
 * again only if you also make onVerified idempotent — this helper still calls it when
 * transaction.verified is true and developer_completed is still false.
 */
export async function completeU2APayment(
  ctx: U2AContext,
  paymentId: string,
  txid: string,
  opts: CompleteU2AOptions,
): Promise<CompleteU2AResult> {
  const payment = await getU2APayment(ctx, paymentId);
  assertOwnU2APayment(ctx, payment, opts.payerUid);
  assertU2AExpectations(payment, opts);
  if (payment.status.cancelled || payment.status.user_cancelled) {
    throw new U2AError(409, "cancelled", "This payment was cancelled");
  }
  const actualTxid = payment.transaction?.txid;
  if (actualTxid && actualTxid !== txid) {
    throw new U2AError(400, "wrong_txid", "This payment's transaction id does not match");
  }
  if (payment.status.developer_completed) {
    return { payment, completedOnPi: true };
  }
  if (!payment.transaction?.txid || !payment.status.transaction_verified) {
    throw new U2AError(409, "not_verified", "Pi has not yet verified this payment's transaction");
  }
  await opts.onVerified(payment, payment.transaction.txid);
  try {
    const completed = await ctx.pi.completePayment(payment.identifier, payment.transaction.txid);
    return { payment: completed, completedOnPi: true };
  } catch {
    // The credit was already recorded. The host should retry /complete later.
    return { payment, completedOnPi: false };
  }
}

/** Cancel a payment that has no blockchain transaction. If it already has a tx, do not cancel it. */
export async function cancelU2APayment(ctx: U2AContext, paymentId: string, payerUid: string): Promise<PiPayment> {
  const payment = await getU2APayment(ctx, paymentId);
  assertOwnU2APayment(ctx, payment, payerUid);
  if (payment.transaction?.txid) {
    throw new U2AError(409, "has_transaction", "This payment already has a blockchain transaction and must be settled, not cancelled");
  }
  if (payment.status.cancelled || payment.status.user_cancelled || payment.status.developer_completed) {
    return payment;
  }
  try {
    return await ctx.pi.cancelPayment(payment.identifier);
  } catch {
    return payment;
  }
}

export type IncompleteU2AResult =
  | { action: "completed"; result: CompleteU2AResult }
  | { action: "cancelled"; payment: PiPayment }
  | { action: "pending"; payment: PiPayment };

/**
 * Handle a payment Pi.authenticate reported as incomplete (browser closed after signing, etc.).
 * Verified transaction -> onVerified + /complete; no transaction -> cancel; not yet verified -> pending.
 */
export async function resolveIncompleteU2APayment(
  ctx: U2AContext,
  paymentId: string,
  opts: CompleteU2AOptions,
): Promise<IncompleteU2AResult> {
  const payment = await getU2APayment(ctx, paymentId);
  assertOwnU2APayment(ctx, payment, opts.payerUid);
  if (payment.status.developer_completed) {
    return { action: "completed", result: { payment, completedOnPi: true } };
  }
  if (payment.transaction?.txid && payment.status.transaction_verified) {
    const result = await completeU2APayment(ctx, paymentId, payment.transaction.txid, opts);
    return { action: "completed", result };
  }
  if (payment.transaction?.txid) {
    return { action: "pending", payment };
  }
  const cancelled = await cancelU2APayment(ctx, paymentId, opts.payerUid);
  return { action: "cancelled", payment: cancelled };
}
