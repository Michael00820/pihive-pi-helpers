import { describe, expect, it, vi } from "vitest";
import { PiApiError, type PiPayment, type PiPlatform } from "../src/server/platform.js";
import {
  approveU2APayment,
  cancelU2APayment,
  completeU2APayment,
  resolveIncompleteU2APayment,
  U2AError,
  type U2AContext,
} from "../src/server/u2a.js";

const base = (): PiPayment => ({
  identifier: "pay_1",
  user_uid: "uid-alice",
  amount: 2.575,
  memo: "example memo",
  metadata: { intentId: "int-1", purpose: "EXAMPLE" },
  from_address: "GFROM",
  to_address: "GAPP",
  direction: "user_to_app",
  created_at: "2026-10-08T10:00:00Z",
  network: "Pi Testnet",
  status: { developer_approved: false, transaction_verified: false, developer_completed: false, cancelled: false, user_cancelled: false },
  transaction: null,
});

function ctx(payment: PiPayment, overrides: Partial<PiPlatform> = {}): U2AContext {
  const pi: PiPlatform = {
    getPayment: vi.fn(async () => structuredClone(payment)),
    approvePayment: vi.fn(async () => ({ ...payment, status: { ...payment.status, developer_approved: true } })),
    completePayment: vi.fn(async () => ({ ...payment, status: { ...payment.status, developer_completed: true } })),
    cancelPayment: vi.fn(async () => ({ ...payment, status: { ...payment.status, cancelled: true } })),
    ...overrides,
  };
  return { pi, expectedNetwork: "Pi Testnet", appWallet: "GAPP" };
}

const expected = {
  payerUid: "uid-alice",
  expectedAmount: "2.5750000",
  expectedMemo: "example memo",
  expectedMetadata: { intentId: "int-1" },
};

describe("U2A flow helpers", () => {
  it("approves a payment after payer, network, amount and metadata checks", async () => {
    const c = ctx(base());
    const before = vi.fn(async () => undefined);
    const approved = await approveU2APayment(c, "pay_1", { ...expected, onBeforeApprove: before });
    expect(before).toHaveBeenCalledOnce();
    expect(approved.status.developer_approved).toBe(true);
    expect(c.pi.approvePayment).toHaveBeenCalledWith("pay_1");
  });

  it("refuses a payment from the wrong payer or network, and never calls /approve", async () => {
    await expect(approveU2APayment(ctx(base()), "pay_1", { ...expected, payerUid: "uid-mallory" })).rejects.toMatchObject({
      code: "wrong_payer",
    });
    const otherNet = base();
    otherNet.network = "Pi Network";
    const c = ctx(otherNet);
    await expect(approveU2APayment(c, "pay_1", expected)).rejects.toMatchObject({ code: "wrong_network" });
    expect(c.pi.approvePayment).not.toHaveBeenCalled();
  });

  it("credits via onVerified before /complete, and reports completedOnPi=false if /complete fails", async () => {
    const payment = base();
    payment.status.developer_approved = true;
    payment.status.transaction_verified = true;
    payment.transaction = { txid: "tx_1", verified: true };
    const c = ctx(payment, {
      completePayment: vi.fn(async () => {
        throw new PiApiError("unavailable", 503, "down");
      }),
    });
    const onVerified = vi.fn(async () => undefined);
    const result = await completeU2APayment(c, "pay_1", "tx_1", { ...expected, onVerified });
    expect(onVerified).toHaveBeenCalledOnce();
    expect(result.completedOnPi).toBe(false);
  });

  it("will not cancel a payment that already has a blockchain transaction", async () => {
    const payment = base();
    payment.transaction = { txid: "tx_1", verified: false };
    const c = ctx(payment);
    await expect(cancelU2APayment(c, "pay_1", "uid-alice")).rejects.toMatchObject({ code: "has_transaction" });
    expect(c.pi.cancelPayment).not.toHaveBeenCalled();
  });

  it("resolveIncomplete completes a verified payment and cancels one with no tx", async () => {
    const verified = base();
    verified.status.transaction_verified = true;
    verified.transaction = { txid: "tx_1", verified: true };
    const done = await resolveIncompleteU2APayment(ctx(verified), "pay_1", { ...expected, onVerified: async () => undefined });
    expect(done.action).toBe("completed");

    const unsigned = await resolveIncompleteU2APayment(ctx(base()), "pay_1", { ...expected, onVerified: async () => undefined });
    expect(unsigned.action).toBe("cancelled");
  });

  it("maps a missing payment to unknown_payment", async () => {
    const c = ctx(base(), {
      getPayment: vi.fn(async () => {
        throw new PiApiError("not_found", 404, "missing");
      }),
    });
    await expect(approveU2APayment(c, "pay_1", expected)).rejects.toBeInstanceOf(U2AError);
    await expect(approveU2APayment(c, "pay_1", expected)).rejects.toMatchObject({ code: "unknown_payment", status: 404 });
  });
});
