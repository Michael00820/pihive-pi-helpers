import { describe, expect, it, vi } from "vitest";
import { createPiPlatform, PiApiError } from "../src/server/platform.js";

const dto = {
  identifier: "pay_1",
  user_uid: "u1",
  amount: 2.575,
  memo: "m",
  metadata: { purpose: "EXAMPLE" },
  from_address: "G1",
  to_address: "G2",
  direction: "user_to_app",
  created_at: "2026-10-08T10:00:00Z",
  network: "Pi Testnet",
  status: { developer_approved: false, transaction_verified: false, developer_completed: false, cancelled: false, user_cancelled: false },
  transaction: null,
};

describe("Pi platform client", () => {
  it("uses the server API key and the right endpoints", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(dto), { status: 200 }));
    const pi = createPiPlatform({ apiKey: "k-123456789", fetchImpl: fetchImpl as unknown as typeof fetch });
    const p = await pi.getPayment("pay_1");
    expect(p.amount).toBe(2.575);
    await pi.approvePayment("pay_1");
    await pi.completePayment("pay_1", "a".repeat(64));
    await pi.cancelPayment("pay_1");
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([u, i]) => `${i.method} ${u}`)).toEqual([
      "GET https://api.minepi.com/v2/payments/pay_1",
      "POST https://api.minepi.com/v2/payments/pay_1/approve",
      "POST https://api.minepi.com/v2/payments/pay_1/complete",
      "POST https://api.minepi.com/v2/payments/pay_1/cancel",
    ]);
    for (const [, init] of calls) expect(new Headers(init.headers).get("authorization")).toBe("Key k-123456789");
    expect(JSON.parse(String(calls[2]?.[1].body))).toEqual({ txid: "a".repeat(64) });
  });

  it("refuses ids that could change the URL, and maps errors", async () => {
    const pi = createPiPlatform({ apiKey: "k-123456789", fetchImpl: vi.fn() as unknown as typeof fetch });
    await expect(pi.getPayment("../me")).rejects.toThrow();
    await expect(pi.getPayment("a/b")).rejects.toThrow();

    const mk = (status: number, body = "{}") =>
      createPiPlatform({ apiKey: "k-123456789", fetchImpl: (async () => new Response(body, { status })) as unknown as typeof fetch });
    await expect(mk(404).getPayment("p")).rejects.toMatchObject({ kind: "not_found" });
    await expect(mk(400).approvePayment("p")).rejects.toMatchObject({ kind: "rejected" });
    await expect(mk(503).getPayment("p")).rejects.toMatchObject({ kind: "unavailable" });
    await expect(mk(200, '{"weird":true}').getPayment("p")).rejects.toBeInstanceOf(PiApiError);
    const down = createPiPlatform({
      apiKey: "k-123456789",
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await expect(down.getPayment("p")).rejects.toMatchObject({ kind: "unavailable" });
  });
});
