/**
 * The real A2U client against local fake Pi API and Horizon servers: real signing with a
 * throwaway keypair, network pinning, the hash being saved before submit, and the wallet
 * seed never leaking through statuses or errors. No process.env secrets are read.
 */
import * as StellarNs from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { toUnits } from "../src/money.js";
import { EnvError } from "../src/server/errors.js";
import { a2uStatus, checkPayoutLimits, createA2UFactory, NotSentError, safeError, type A2UConfig, type SignedInfo } from "../src/server/a2u.js";
import { startFakeHorizon, startFakePiApi } from "./sdk-fakes.js";

const Stellar = ((StellarNs as unknown as { Keypair?: unknown }).Keypair ? StellarNs : (StellarNs as unknown as { default: unknown }).default) as typeof StellarNs;
const appKp = Stellar.Keypair.random();
const userKp = Stellar.Keypair.random();
const WALLET_SECRET = appKp.secret();
const API_KEY = "test-api-key-local-only";

let horizon: Awaited<ReturnType<typeof startFakeHorizon>>;
let piApi: Awaited<ReturnType<typeof startFakePiApi>>;

const config = (): A2UConfig => ({
  apiKey: API_KEY,
  network: "testnet",
  horizonUrl: horizon.url,
  walletSecret: WALLET_SECRET,
});
const factory = () => createA2UFactory(config(), { piApiBaseUrl: piApi.url });

beforeAll(async () => {
  horizon = await startFakeHorizon({ appWallet: appKp.publicKey(), networkPassphrase: "Pi Testnet" });
  piApi = await startFakePiApi({ apiKey: API_KEY, appWallet: appKp.publicKey(), userWallet: () => userKp.publicKey() });
});
afterAll(async () => {
  await horizon?.close();
  await piApi?.close();
});

describe("A2U client", () => {
  it("creates, signs (Pi Testnet passphrase, memo = payment id, 180 s bounds), saves the hash first, submits and completes", async () => {
    const f = factory();
    expect(f.status).toMatchObject({ enabled: true, network: "Pi Testnet", appWallet: appKp.publicKey(), horizonUrl: horizon.url });
    const client = f.createClient();
    const id = await client.createPayment({ amount: 1.5, memo: "example payout", metadata: { payoutId: "p1" }, uid: "uid-1" });
    let signed: SignedInfo | null = null;
    let postsAtSign = -1;
    const before = Math.floor(Date.now() / 1000);
    const txid = await client.submitPayment(id, {
      onSigned: async (info) => {
        signed = info;
        postsAtSign = horizon.state.posts;
      },
    });
    expect(postsAtSign).toBe(0);
    expect(signed!.hash).toBe(txid);
    const tx = horizon.txs.get(txid)!;
    expect(tx).toMatchObject({ memo: id, source: appKp.publicKey(), to: userKp.publicKey(), amount: "1.5000000", signatureValid: true });
    expect(tx.maxTime).toBeGreaterThanOrEqual(before + 179);
    expect(tx.maxTime).toBeLessThanOrEqual(before + 182);
    expect(signed!.maxTime!.getTime()).toBe(tx.maxTime * 1000);

    const done = await client.completePayment(id, txid);
    expect(done.status.developer_completed).toBe(true);
    expect(await client.getIncompleteServerPayments()).toEqual([]);

    expect(await f.horizon.getTransaction(txid)).toMatchObject({ hash: txid, successful: true, memo: id, feeChargedU: 100_000n, payments: [{ amountU: toUnits("1.5") }] });
    expect((await f.horizon.findByMemo(appKp.publicKey(), id))?.hash).toBe(txid);
    expect(await f.horizon.getTransaction("0".repeat(64))).toBeNull();
    expect(await f.horizon.nativeBalance(appKp.publicKey())).toBe(toUnits("1000"));
  });

  it("refuses a payment on the other network before signing anything", async () => {
    piApi.state.network = "Pi Network";
    try {
      const client = factory().createClient();
      const id = await client.createPayment({ amount: 1, memo: "m", metadata: { payoutId: "p2" }, uid: "uid-2" });
      const posts = horizon.state.posts;
      const hook = vi.fn(async () => undefined);
      await expect(client.submitPayment(id, { onSigned: hook })).rejects.toBeInstanceOf(NotSentError);
      expect(hook).not.toHaveBeenCalled();
      expect(horizon.state.posts).toBe(posts);
      await client.cancelPayment(id);
    } finally {
      piApi.state.network = "Pi Testnet";
    }
  });

  it("an error after the hash was saved is NOT reported as 'not sent' (it is ambiguous)", async () => {
    const client = factory().createClient();
    const id = await client.createPayment({ amount: 1, memo: "m", metadata: { payoutId: "p3" }, uid: "uid-3" });
    horizon.state.submitStatus = 400;
    try {
      const err = await client.submitPayment(id, { onSigned: async () => undefined }).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(NotSentError);
      expect(err.resultCodes).toEqual(["tx_failed", "op_no_destination"]);
    } finally {
      horizon.state.submitStatus = 200;
      await client.cancelPayment(id);
    }
  });

  it("a failing onSigned hook stops the submit (nothing is sent)", async () => {
    const client = factory().createClient();
    const id = await client.createPayment({ amount: 1, memo: "m", metadata: { payoutId: "p4" }, uid: "uid-4" });
    const posts = horizon.state.posts;
    await expect(client.submitPayment(id, { onSigned: async () => Promise.reject(new Error("db down")) })).rejects.toBeInstanceOf(NotSentError);
    expect(horizon.state.posts).toBe(posts);
    await client.cancelPayment(id);
  });
});

describe("the wallet seed never leaks", () => {
  it("not through statuses, clients or startup errors", () => {
    const f = factory();
    const client = f.createClient();
    expect(JSON.stringify(f.status)).not.toContain(WALLET_SECRET);
    expect(JSON.stringify(client)).not.toContain(WALLET_SECRET);
    expect(Object.values(client).map(String).join(" ")).not.toContain(WALLET_SECRET);
    expect(() => a2uStatus({ network: "testnet", apiKey: API_KEY, walletSecret: "SNOTAVALIDSEED" })).toThrow(EnvError);
    const bad = `S${"A".repeat(54)}x`;
    try {
      a2uStatus({ network: "testnet", apiKey: API_KEY, walletSecret: bad });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(bad);
    }
    expect(safeError(new Error(`boom ${WALLET_SECRET} key ${API_KEY}`), [API_KEY])).toBe("boom [redacted] key [redacted]");
  });
});

describe("checkPayoutLimits", () => {
  const base = {
    amountU: 10n,
    maxPerTxU: 50n,
    userDailyUsedU: 0n,
    userDailyCapU: 100n,
    walletHourlyUsedU: 0n,
    walletHourlyCapU: 200n,
    walletDailyUsedU: 0n,
    walletDailyCapU: 500n,
  };

  it("allows a payout within every cap and refuses one that would exceed any of them", () => {
    expect(checkPayoutLimits(base)).toEqual({ ok: true });
    expect(checkPayoutLimits({ ...base, amountU: 51n })).toEqual({ ok: false, reason: "max_per_tx" });
    expect(checkPayoutLimits({ ...base, userDailyUsedU: 95n })).toEqual({ ok: false, reason: "user_daily_cap" });
    expect(checkPayoutLimits({ ...base, walletHourlyUsedU: 195n })).toEqual({ ok: false, reason: "wallet_hourly_cap" });
    expect(checkPayoutLimits({ ...base, walletDailyUsedU: 495n })).toEqual({ ok: false, reason: "wallet_daily_cap" });
  });
});
