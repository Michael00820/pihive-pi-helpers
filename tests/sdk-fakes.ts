/**
 * Local HTTP stand-ins for the Pi Platform API (A2U endpoints) and Horizon, so the real
 * @stellar/stellar-sdk client can be exercised end to end: create -> sign -> submit -> complete.
 * They listen on 127.0.0.1 only. Nothing here talks to the internet.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as StellarNs from "@stellar/stellar-sdk";

const Stellar = ((StellarNs as unknown as { TransactionBuilder?: unknown }).TransactionBuilder ? StellarNs : (StellarNs as unknown as { default: unknown }).default) as typeof StellarNs;

type Json = Record<string, unknown>;
const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", date: new Date().toUTCString() });
  res.end(JSON.stringify(body));
};
async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export type SubmittedTx = { hash: string; memo: string; source: string; to: string; amount: string; maxTime: number; signatureValid: boolean; networkPassphrase: string };

export async function startFakeHorizon(opts: { appWallet: string; networkPassphrase: string }) {
  const txs = new Map<string, SubmittedTx & { xdr: string }>();
  const state = { submitStatus: 200 as number, posts: 0, sequence: 1000n };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    if (req.method === "GET" && path === "/") return send(res, 200, {});
    if (req.method === "GET" && path === "/fee_stats") return send(res, 200, { last_ledger_base_fee: "100000" });
    let m = /^\/accounts\/([^/]+)$/.exec(path);
    if (req.method === "GET" && m) {
      if (m[1] !== opts.appWallet) return send(res, 404, { status: 404 });
      return send(res, 200, {
        id: m[1],
        account_id: m[1],
        sequence: state.sequence.toString(),
        subentry_count: 0,
        balances: [{ asset_type: "native", balance: "1000.0000000" }],
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
        flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
        signers: [{ key: m[1], weight: 1, type: "ed25519_public_key" }],
        data: {},
        _links: {},
      });
    }
    m = /^\/accounts\/([^/]+)\/transactions$/.exec(path);
    if (req.method === "GET" && m) {
      const records = [...txs.values()].reverse().map((t) => ({ hash: t.hash, successful: true, memo: t.memo, memo_type: "text", fee_charged: "100000" }));
      return send(res, 200, { _embedded: { records } });
    }
    m = /^\/transactions\/([0-9a-f]{64})(\/operations)?$/.exec(path);
    if (req.method === "GET" && m && m[1]) {
      const t = txs.get(m[1]);
      if (!t) return send(res, 404, { status: 404 });
      if (m[2]) return send(res, 200, { _embedded: { records: [{ type: "payment", to: t.to, amount: t.amount }] } });
      return send(res, 200, { hash: t.hash, successful: true, memo: t.memo, memo_type: "text", fee_charged: "100000" });
    }
    if (req.method === "POST" && path === "/transactions") {
      state.posts += 1;
      const body = new URLSearchParams(await readBody(req));
      const xdr = body.get("tx") ?? "";
      if (state.submitStatus !== 200) return send(res, state.submitStatus, { title: "Transaction Failed", extras: { result_codes: { transaction: "tx_failed", operations: ["op_no_destination"] } } });
      const tx = Stellar.TransactionBuilder.fromXDR(xdr, opts.networkPassphrase) as StellarNs.Transaction;
      const op = tx.operations[0] as StellarNs.Operation.Payment;
      const hash = Buffer.from(tx.hash()).toString("hex");
      const kp = Stellar.Keypair.fromPublicKey(tx.source);
      const signatureValid = tx.signatures.some((s) => kp.verify(tx.hash(), (typeof s.signature === "function" ? (s.signature as unknown as () => Buffer)() : (s.signature as unknown as Buffer))));
      txs.set(hash, {
        hash,
        xdr,
        memo: typeof tx.memo.value === "string" ? tx.memo.value : Buffer.from(tx.memo.value as Uint8Array).toString("utf8"),
        source: tx.source,
        to: op.destination,
        amount: op.amount,
        maxTime: Number(tx.timeBounds?.maxTime ?? 0),
        signatureValid,
        networkPassphrase: opts.networkPassphrase,
      });
      state.sequence += 1n;
      return send(res, 200, { id: hash, hash, ledger: 1, successful: true, envelope_xdr: xdr });
    }
    send(res, 404, { status: 404, path });
  });
  const url = await listen(server);
  return { url, txs, state, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export async function startFakePiApi(opts: { apiKey: string; appWallet: string; userWallet: (uid: string) => string; network?: string }) {
  const payments = new Map<string, Json & { identifier: string; status: Json; transaction: Json | null }>();
  const state = { network: opts.network ?? "Pi Testnet", errorEcho: null as string | null, seq: 0 };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.headers.authorization !== `Key ${opts.apiKey}`) return send(res, 401, { error: "unauthorized" });
    // A misbehaving upstream that echoes secrets back must not leak them through our errors/logs.
    if (state.errorEcho) return send(res, 500, { error: "internal", error_message: state.errorEcho });
    const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};
    if (req.method === "GET" && url.pathname === "/v2/payments/incomplete_server_payments") {
      const list = [...payments.values()].filter((p) => !(p.status as Json).developer_completed && !(p.status as Json).cancelled);
      return send(res, 200, { incomplete_server_payments: list });
    }
    if (req.method === "POST" && url.pathname === "/v2/payments") {
      state.seq += 1;
      const pay = body.payment;
      const p = {
        identifier: `sdk_${state.seq}`,
        user_uid: pay.uid,
        amount: pay.amount,
        memo: pay.memo,
        metadata: pay.metadata,
        from_address: opts.appWallet,
        to_address: opts.userWallet(pay.uid),
        direction: "app_to_user",
        created_at: new Date().toISOString(),
        network: state.network,
        status: { developer_approved: true, transaction_verified: false, developer_completed: false, cancelled: false, user_cancelled: false },
        transaction: null,
      };
      payments.set(p.identifier, p);
      return send(res, 200, p);
    }
    const m = /^\/v2\/payments\/([^/]+)(?:\/(complete|cancel))?$/.exec(url.pathname);
    const p = m?.[1] ? payments.get(m[1]) : undefined;
    if (!p) return send(res, 404, { error: "payment_not_found" });
    if (req.method === "GET" && !m![2]) return send(res, 200, p);
    if (m![2] === "complete") {
      if ((p.status as Json).developer_completed) return send(res, 400, { error: "already_completed" });
      p.transaction = { txid: body.txid, verified: true, _link: "" };
      (p.status as Json).developer_completed = true;
      (p.status as Json).transaction_verified = true;
      return send(res, 200, p);
    }
    if (m![2] === "cancel") {
      (p.status as Json).cancelled = true;
      return send(res, 200, p);
    }
    send(res, 404, { error: "not found" });
  });
  const url = await listen(server);
  return { url, payments, state, close: () => new Promise<void>((r) => server.close(() => r())) };
}
