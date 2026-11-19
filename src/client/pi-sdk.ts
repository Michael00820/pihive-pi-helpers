/**
 * Browser helpers around the Pi Network JS SDK (`window.Pi`).
 *
 * The server must still be the only source of identity (verify the access token with /v2/me)
 * and the only place that approves or completes payments. This module never sees an API key
 * or a wallet seed.
 *
 * Pi, Pi Network and the Pi logo are trademarks of the Pi Community Company.
 */

export interface PiUserAuth {
  accessToken: string;
  user: {
    uid: string;
    username: string;
    // The Pi SDK uses snake_case. Display only: the server takes identity from Pi /v2/me.
    wallet_address?: string;
  };
}

/** The subset of Pi's PaymentDTO we forward to the server for incomplete payments. */
export interface PiIncompletePayment {
  identifier: string;
  transaction?: { txid?: string } | null;
}

export interface PiPaymentCallbacks {
  onReadyForServerApproval: (paymentId: string) => Promise<void> | void;
  onReadyForServerCompletion: (paymentId: string, txid: string) => Promise<void> | void;
  onCancel: (paymentId: string) => void;
  onError: (error: Error, payment?: PiIncompletePayment) => void;
}

export interface PiPaymentData {
  amount: number;
  memo: string;
  metadata?: Record<string, unknown>;
}

export interface PiSdk {
  init: (config: { version: string; sandbox?: boolean }) => void;
  authenticate: (
    scopes: string[],
    onIncompletePaymentFound?: (payment: PiIncompletePayment) => void,
  ) => Promise<PiUserAuth>;
  // The real SDK returns void immediately; the outcome arrives through the callbacks.
  createPayment: (paymentData: PiPaymentData, callbacks: PiPaymentCallbacks) => void;
}

declare global {
  interface Window {
    Pi?: PiSdk;
  }
}

/** What the server returns when it creates a payment intent the client should pay. */
export interface PaymentIntent {
  intentId: string;
  /** Exact amount as a 7-decimal Pi string, computed by the server. */
  amount: string;
  memo: string;
  metadata?: Record<string, unknown>;
}

/** Server calls payWithPi makes from inside the Pi SDK callbacks. */
export interface PayWithPiServer {
  approve: (paymentId: string) => Promise<void>;
  /** Resolves true once the server recorded the payment, false if it is still confirming. */
  complete: (paymentId: string, txid: string) => Promise<boolean>;
  cancel: (ref: { paymentId?: string; intentId?: string }) => Promise<void>;
  reportIncomplete: (paymentId: string, txid: string | null) => Promise<void>;
}

export interface PayWithPiResult {
  paymentId: string;
  txid: string;
  /** False when the blockchain confirmation is still pending; the server finishes it later. */
  recorded: boolean;
}

export class PiPaymentCancelled extends Error {
  constructor() {
    super("Payment cancelled. Nothing was charged.");
    this.name = "PiPaymentCancelled";
  }
}

/** The Pi account on this page is not the one our session was signed in as. */
export class PiSessionChangedError extends Error {
  constructor(public readonly user: { id: string }) {
    super("Your Pi account changed, so you were signed in again as that account. Please check the page and try again.");
    this.name = "PiSessionChangedError";
  }
}

export const PI_PAYMENT_SCOPES = ["username", "payments", "wallet_address"] as const;

export type IncompletePaymentReporter = (paymentId: string, txid: string | null) => Promise<void>;

/** Queue of incomplete payments reported by Pi.authenticate before a session exists. */
export function createIncompletePaymentQueue(report: IncompletePaymentReporter) {
  const pending = new Map<string, string | null>();
  return {
    remember(payment: PiIncompletePayment) {
      if (!payment?.identifier) return;
      pending.set(payment.identifier, payment.transaction?.txid ?? null);
    },
    async flush(): Promise<void> {
      for (const [paymentId, txid] of Array.from(pending)) {
        try {
          await report(paymentId, txid);
          pending.delete(paymentId);
        } catch {
          // Leave it queued; the next sign-in or payment attempt will retry.
        }
      }
    },
    get size() {
      return pending.size;
    },
  };
}

let initialized = false;

export function isInsidePiBrowser(): boolean {
  if (typeof window === "undefined") return false;
  return /PiBrowser/i.test(navigator.userAgent) || !!window.Pi;
}

/**
 * Initialise the Pi JS SDK. `sandbox` should be true only for desktop development through
 * sandbox.minepi.com. In the Pi Browser (Testnet or Mainnet app) it must be false.
 */
export function initPiSdk(opts: { sandbox?: boolean } = {}): void {
  if (typeof window === "undefined" || initialized) return;
  if (!window.Pi) return;
  window.Pi.init({ version: "2.0", sandbox: opts.sandbox ?? false });
  initialized = true;
}

/** For tests: forget that the SDK was initialised on this page. */
export function resetPiSdk(): void {
  initialized = false;
  paymentsAuth = null;
  paymentsAuthSynced = false;
}

export async function authenticatePioneer(
  scopes: readonly string[] = PI_PAYMENT_SCOPES,
  onIncompletePaymentFound?: (payment: PiIncompletePayment) => void,
): Promise<PiUserAuth> {
  if (typeof window === "undefined" || !window.Pi) {
    throw new Error("Pi SDK not available. Please open this app inside the official Pi Browser.");
  }
  try {
    return await window.Pi.authenticate([...scopes], onIncompletePaymentFound);
  } catch (err: unknown) {
    const message = err instanceof Error && err.message ? err.message : "Pi authentication failed or was cancelled";
    throw new Error(message);
  }
}

/**
 * Runs one user-to-app payment for a server-made intent. Pi.createPayment returns nothing; the
 * outcome only arrives through its callbacks, so they are wrapped in a Promise here.
 * The server checks everything (amount, payer, metadata) before approving; this code never decides.
 */
export function payWithPi(intent: PaymentIntent, server: PayWithPiServer, opts: { sandbox?: boolean } = {}): Promise<PayWithPiResult> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || !window.Pi) {
      reject(new Error("Open this app in the Pi Browser to pay with Pi."));
      return;
    }
    initPiSdk({ sandbox: opts.sandbox });
    let settled = false;
    let currentPaymentId: string | null = null;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const fail = (err: unknown) => finish(() => reject(err instanceof Error ? err : new Error(String(err))));

    const callbacks: PiPaymentCallbacks = {
      onReadyForServerApproval: (paymentId) => {
        currentPaymentId = paymentId;
        // If approval fails the Pi wallet times out and the payment is cancelled by Pi.
        server.approve(paymentId).catch(fail);
      },
      onReadyForServerCompletion: (paymentId, txid) => {
        currentPaymentId = paymentId;
        server
          .complete(paymentId, txid)
          .then((recorded) => finish(() => resolve({ paymentId, txid, recorded })))
          // The money has left the wallet. The server's retry job (and the next sign-in's
          // incomplete-payment check) will record it, so this is not a failure for the user.
          .catch(() => finish(() => resolve({ paymentId, txid, recorded: false })));
      },
      onCancel: (paymentId) => {
        void server.cancel({ paymentId: paymentId || undefined, intentId: paymentId ? undefined : intent.intentId }).catch(() => {});
        fail(new PiPaymentCancelled());
      },
      onError: (error, payment) => {
        const id: string | undefined = payment?.identifier || currentPaymentId || undefined;
        if (id) {
          // Let the server look the payment up on Pi: it completes it if it was paid, else cancels.
          void server.reportIncomplete(id, payment?.transaction?.txid ?? null).catch(() => {});
        } else {
          void server.cancel({ intentId: intent.intentId }).catch(() => {});
        }
        fail(error instanceof Error ? error : new Error("Pi payment failed"));
      },
    };

    try {
      window.Pi.createPayment({ amount: Number(intent.amount), memo: intent.memo, metadata: intent.metadata }, callbacks);
    } catch (err) {
      void server.cancel({ intentId: intent.intentId }).catch(() => {});
      fail(err);
    }
  });
}

export interface EnsurePaymentsScopeDeps {
  /** Sends the Pi access token to the host server (verified there with Pi /v2/me). */
  verify: (accessToken: string) => Promise<{ user: { id: string } }>;
  /** The signed-in user before syncing. */
  getMe: () => Promise<{ id: string } | null>;
  /** Re-run Pi.authenticate even if it already ran on this page. */
  force?: boolean;
  sandbox?: boolean;
  onIncompletePaymentFound?: (payment: PiIncompletePayment) => void;
}

let paymentsAuth: Promise<PiUserAuth> | null = null;
let paymentsAuthSynced = false;

/** Sign-in already ran Pi.authenticate with these scopes and verified the token with the server. */
export function notePaymentsAuth(auth: PiUserAuth): void {
  paymentsAuth = Promise.resolve(auth);
  paymentsAuthSynced = true;
}

/**
 * The Pi SDK keeps granted scopes in memory for the current page load only. A session restored
 * from a cookie never ran Pi.authenticate on this page, so Pi.createPayment would fail with
 * 'Cannot create a payment without "payments" scope'. This runs Pi.authenticate once per page
 * load (no dialog once granted) and re-syncs the host session with this page's Pi token.
 */
export async function ensurePaymentsScope(deps: EnsurePaymentsScopeDeps): Promise<PiUserAuth> {
  if (typeof window === "undefined" || !window.Pi) {
    throw new Error("Open this app in the Pi Browser to pay with Pi.");
  }
  initPiSdk({ sandbox: deps.sandbox });
  if (!paymentsAuth || deps.force) {
    const p = authenticatePioneer(PI_PAYMENT_SCOPES, deps.onIncompletePaymentFound);
    paymentsAuth = p;
    p.catch(() => {
      if (paymentsAuth === p) paymentsAuth = null;
    });
  }
  const auth = await paymentsAuth;

  if (!paymentsAuthSynced) {
    const before = await deps.getMe().catch(() => null);
    const res = await deps.verify(auth.accessToken);
    paymentsAuthSynced = true;
    if (before && res.user && before.id !== res.user.id) {
      throw new PiSessionChangedError(res.user);
    }
  }
  return auth;
}
