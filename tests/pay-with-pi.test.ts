import { afterEach, describe, expect, it, vi } from "vitest";
import { payWithPi, PiPaymentCancelled, resetPiSdk, type PaymentIntent, type PiPaymentCallbacks } from "../src/client/pi-sdk.js";

const intent: PaymentIntent = {
  intentId: "11111111-1111-4111-8111-111111111111",
  amount: "2.5750000",
  memo: "example memo",
  metadata: { purpose: "EXAMPLE", intentId: "11111111-1111-4111-8111-111111111111" },
};

function setup(drive: (cb: PiPaymentCallbacks) => void) {
  const createPayment = vi.fn((_data: unknown, cb: PiPaymentCallbacks) => {
    setTimeout(() => drive(cb), 0);
  });
  vi.stubGlobal("window", { Pi: { init: vi.fn(), authenticate: vi.fn(), createPayment } });
  const server = {
    approve: vi.fn(async () => {}),
    complete: vi.fn(async () => true),
    cancel: vi.fn(async () => {}),
    reportIncomplete: vi.fn(async () => {}),
  };
  return { createPayment, server };
}

afterEach(() => {
  resetPiSdk();
  vi.unstubAllGlobals();
});

describe("payWithPi", () => {
  it("passes the server's exact amount and metadata, then approve → complete", async () => {
    const { createPayment, server } = setup((cb) => {
      cb.onReadyForServerApproval("pay_1");
      setTimeout(() => cb.onReadyForServerCompletion("pay_1", "tx_1"), 0);
    });
    await expect(payWithPi(intent, server)).resolves.toEqual({ paymentId: "pay_1", txid: "tx_1", recorded: true });
    expect(createPayment.mock.calls[0]?.[0]).toEqual({ amount: 2.575, memo: intent.memo, metadata: intent.metadata });
    expect(server.approve).toHaveBeenCalledWith("pay_1");
    expect(server.complete).toHaveBeenCalledWith("pay_1", "tx_1");
  });

  it("a failed complete call still resolves (the server's retry job records it)", async () => {
    const { server } = setup((cb) => cb.onReadyForServerCompletion("pay_1", "tx_1"));
    server.complete.mockRejectedValueOnce(new Error("network"));
    await expect(payWithPi(intent, server)).resolves.toMatchObject({ recorded: false });
  });

  it("onCancel tells the server and rejects with PiPaymentCancelled", async () => {
    const { server } = setup((cb) => cb.onCancel("pay_1"));
    await expect(payWithPi(intent, server)).rejects.toBeInstanceOf(PiPaymentCancelled);
    expect(server.cancel).toHaveBeenCalledWith({ paymentId: "pay_1", intentId: undefined });
  });

  it("onError without a payment resets the intent; with a payment it is reported as incomplete", async () => {
    const a = setup((cb) => cb.onError(new Error("boom")));
    await expect(payWithPi(intent, a.server)).rejects.toThrow("boom");
    expect(a.server.cancel).toHaveBeenCalledWith({ intentId: intent.intentId });

    const b = setup((cb) => cb.onError(new Error("boom"), { identifier: "pay_2", transaction: { txid: "tx_2" } }));
    await expect(payWithPi(intent, b.server)).rejects.toThrow("boom");
    expect(b.server.reportIncomplete).toHaveBeenCalledWith("pay_2", "tx_2");
  });

  it("refuses outside the Pi Browser", async () => {
    vi.stubGlobal("window", {});
    await expect(
      payWithPi(intent, { approve: vi.fn(), complete: vi.fn(), cancel: vi.fn(), reportIncomplete: vi.fn() }),
    ).rejects.toThrow(/Pi Browser/);
  });
});
