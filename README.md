# Hive Helpers for Pi

_Package and repository name: `pihive-pi-helpers`._

Reusable TypeScript helpers for [Pi Network](https://minepi.com) apps: Browser SDK sign-in, server-side `GET /v2/me` verification, user-to-app (U2A) payment approve/complete flow, and app-to-user (A2U) payouts with a read-only Horizon client.

This package is **not** the PiHive marketplace. It contains only the Pi integration pieces, extracted so other Pi apps can reuse them. The marketplace itself stays private.

It is licensed under the [PiOS License](https://github.com/pi-apps/PiOS/blob/main/LICENSE). That licence allows use, modification and distribution **only to develop, use and market applications for the official Pi Network**. See [LICENSE](./LICENSE).

Pi, Pi Network and the Pi logo are trademarks of the Pi Community Company.

## Install

```bash
npm install pihive-pi-helpers
```

Requires Node.js 18 or later. The browser helpers expect the official Pi JS SDK (`window.Pi`) inside the Pi Browser.

Import from the matching entry, so a browser bundle never pulls in the A2U signer or `@stellar/stellar-sdk`:

```ts
// Frontend (Pi Browser)
import { authenticatePioneer, payWithPi } from "pihive-pi-helpers/client";

// Backend
import { verifyPiAccessToken, createPiPlatform, createA2UFactory } from "pihive-pi-helpers/server";
```

`pihive-pi-helpers` and `pihive-pi-helpers/server` are the same server entry.

## What is in this package

| Area | Module | What it does |
|---|---|---|
| Client sign-in | `pihive-pi-helpers/client` | `initPiSdk`, `authenticatePioneer`, `ensurePaymentsScope` |
| Client U2A | `pihive-pi-helpers/client` | `payWithPi` wraps `Pi.createPayment` callbacks in a Promise |
| `/v2/me` | `verifyPiAccessToken` | Verifies the user's access token; this is the only trusted identity |
| U2A Platform API | `createPiPlatform` | `GET` / `approve` / `complete` / `cancel` with `Authorization: Key` |
| U2A flow | `approveU2APayment`, `completeU2APayment`, `cancelU2APayment`, `resolveIncompleteU2APayment` | Shared checks (payer, direction, network, wallet, amount) plus hooks for your own store |
| A2U + Horizon | `createA2UFactory`, `createHorizonReader` | Create, sign, submit and complete app-to-user payments; read transactions and balances |
| Amounts | `toUnits` / `fromUnits` | Integer units of 10^-7 Pi — never add Pi amounts as JS floats |
| Payout caps | `checkPayoutLimits` | Compare a payout to host-supplied per-tx, per-user and wallet caps |

There is **no** PiHive business logic here: no job fees, escrow schema, admin, or attachments. Persistence is done through small interfaces you implement (`onBeforeApprove`, `onVerified`, `onSigned`).

## Express usage example

The server is the only place that should hold a Pi API key or an app wallet seed. Pass them in; this package does not read `process.env` on its own.

```ts
import express from "express";
import {
  PI_NETWORK_NAMES,
  approveU2APayment,
  completeU2APayment,
  createPiPlatform,
  verifyPiAccessToken,
  U2AError,
} from "pihive-pi-helpers/server";

const app = express();
app.use(express.json());

const pi = createPiPlatform({ apiKey: process.env.PI_API_KEY! });
const expectedNetwork = PI_NETWORK_NAMES[(process.env.PI_NETWORK === "mainnet" ? "mainnet" : "testnet")];
const ctx = { pi, expectedNetwork, appWallet: process.env.APP_WALLET_PUBLIC_KEY };

app.post("/api/auth/pi", async (req, res) => {
  try {
    const identity = await verifyPiAccessToken(req.body.accessToken);
    // Create your own session from identity.uid. Never trust uid/username from the browser.
    res.json({ uid: identity.uid, username: identity.username });
  } catch (err) {
    const status = err instanceof Error && "kind" in err && err.kind === "unavailable" ? 503 : 401;
    res.status(status).json({ error: "auth_failed" });
  }
});

app.post("/api/payments/u2a/approve", async (req, res) => {
  try {
    const payment = await approveU2APayment(ctx, req.body.paymentId, {
      payerUid: req.user.piUid, // from your session, originally from /v2/me
      expectedAmount: req.intent.amount, // the amount *you* quoted
      expectedMemo: req.intent.memo,
      expectedMetadata: { intentId: req.intent.id },
      onBeforeApprove: async (payment) => {
        // Persist "approving" against this payment id (unique). If this throws, /approve is not called.
      },
    });
    res.json({ paymentId: payment.identifier });
  } catch (err) {
    if (err instanceof U2AError) return res.status(err.status).json({ code: err.code, error: err.message });
    throw err;
  }
});

app.post("/api/payments/u2a/complete", async (req, res) => {
  const { payment, completedOnPi } = await completeU2APayment(ctx, req.body.paymentId, req.body.txid, {
    payerUid: req.user.piUid,
    onVerified: async (payment, txid) => {
      // Credit the user here, *before* Pi /complete, and make it idempotent on payment id / txid.
    },
  });
  res.json({ paymentId: payment.identifier, completedOnPi });
});
```

On the client, after your server has created an intent:

```ts
import { payWithPi } from "pihive-pi-helpers/client";

const result = await payWithPi(intent, {
  approve: (paymentId) => post("/api/payments/u2a/approve", { paymentId }),
  complete: async (paymentId, txid) => (await post("/api/payments/u2a/complete", { paymentId, txid })).completedOnPi,
  cancel: (ref) => post("/api/payments/u2a/cancel", ref),
  reportIncomplete: (paymentId, txid) => post("/api/payments/u2a/incomplete", { paymentId, txid }),
});
```

A2U payouts:

```ts
import { checkPayoutLimits, createA2UFactory, toUnits } from "pihive-pi-helpers/server";

const a2u = createA2UFactory({
  network: "testnet", // or "mainnet"
  apiKey: process.env.PI_API_KEY,
  walletSecret: process.env.PI_APP_WALLET_SECRET,
  // horizonUrl is optional; it defaults to Pi's public Horizon for `network`
});

if (!a2u.status.enabled) throw new Error(a2u.status.reason);

const limit = checkPayoutLimits({
  amountU: toUnits("1.5"),
  maxPerTxU: toUnits("50"),
  userDailyUsedU: 0n,
  userDailyCapU: toUnits("500"),
  walletHourlyUsedU: 0n,
  walletHourlyCapU: toUnits("1000"),
  walletDailyUsedU: 0n,
  walletDailyCapU: toUnits("5000"),
});
if (!limit.ok) throw new Error(`payout blocked: ${limit.reason}`);

const client = a2u.createClient();
const id = await client.createPayment({ amount: 1.5, memo: "payout", metadata: { payoutId: "…" }, uid: recipientPiUid });
const txid = await client.submitPayment(id, {
  onSigned: async ({ hash, maxTime }) => {
    // Store the hash *before* the transaction is submitted, so you can look it up if submit is interrupted.
  },
});
await client.completePayment(id, txid);
```

## Security notes

- **Never expose the server API key or the app wallet seed.** They belong only in server environment variables (or a secret store), passed into `createPiPlatform` / `createA2UFactory`. Do not send them to the browser, log them, put them in this repo, or return them from any API. Error messages from `safeError` strip seeds and any extra secrets you pass in.
- **Never trust identity or payment details from the browser.** Call `verifyPiAccessToken` (Pi `GET /v2/me`) and look payments up with `createPiPlatform`. The client only drives the wallet; the server decides whether to approve.
- **Make money writes idempotent.** Use a unique constraint on Pi payment id and on txid. Call your credit/ledger write in `onVerified` *before* Pi `/complete`. If `/complete` then fails, retry only `/complete` — do not credit twice. `onSigned` for A2U must similarly persist the transaction hash before submit.
- **Enforce payout limits in the host app.** Use `checkPayoutLimits` (or your own caps) so a leaked session or a bug cannot drain the app wallet. Typical ceilings are a per-transaction maximum, a per-user daily cap, and rolling hourly/daily outflow caps for the app wallet. Load current totals from your own store; this package does not keep that state.
- **Pin the network.** Refuse payments whose `network` field does not match the app (`Pi Testnet` vs `Pi Network`). A2U signing also refuses a payment for the other network before anything is signed.
- **Do not cancel a U2A payment that already has a blockchain transaction.** Settle it instead (`completeU2APayment` / `resolveIncompleteU2APayment`).
- **Sandbox is only for desktop development** through `sandbox.minepi.com`. In the Pi Browser, call `initPiSdk({ sandbox: false })` (the default).

## Licence and trademarks

Copyright (C) 2026 Osahon Ikuobase. Licensed under the PiOS License; see [LICENSE](./LICENSE). The official licence text is at <https://github.com/pi-apps/PiOS/blob/main/LICENSE>.

This repository is currently private. Publishing it, and submitting it to the PiOS programme (a Brainstorm proposal and a pull request to [pi-apps/PiOS](https://github.com/pi-apps/PiOS)), needs the copyright holder's approval. The steps are in [PIOS-SUBMISSION.md](./PIOS-SUBMISSION.md). Nothing in this repo opens that pull request or posts on Brainstorm for you.

Pi, Pi Network and the Pi logo are trademarks of the Pi Community Company.
