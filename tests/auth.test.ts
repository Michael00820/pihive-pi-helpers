import { describe, expect, it, vi } from "vitest";
import { PiAuthError, verifyPiAccessToken } from "../src/server/auth.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("verifyPiAccessToken (Pi /v2/me, mocked)", () => {
  it("calls GET /v2/me with the user's Bearer token and returns Pi's identity", async () => {
    const fetchImpl = vi.fn(async () => json(200, { uid: "uid-123", username: "alice", wallet_address: "GABC", credentials: {} }));
    const id = await verifyPiAccessToken("user-token", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(id).toEqual({ uid: "uid-123", username: "alice", walletAddress: "GABC" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.minepi.com/v2/me");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer user-token");
    expect(init.method).toBe("GET");
  });

  it("works without username or wallet scopes", async () => {
    const fetchImpl = vi.fn(async () => json(200, { uid: "uid-9" }));
    expect(await verifyPiAccessToken("t", { fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({
      uid: "uid-9",
      username: null,
      walletAddress: null,
    });
  });

  it.each([401, 403, 400, 404])("treats HTTP %i as an invalid token", async (status) => {
    const fetchImpl = vi.fn(async () => json(status, { error: "nope" }));
    await expect(verifyPiAccessToken("t", { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toMatchObject({
      kind: "invalid_token",
    });
  });

  it.each([500, 502, 503, 429])("treats HTTP %i as Pi being unavailable", async (status) => {
    const fetchImpl = vi.fn(async () => json(status, {}));
    await expect(verifyPiAccessToken("t", { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("treats network errors, timeouts and odd responses as unavailable (never as success)", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(verifyPiAccessToken("t", { fetchImpl: down as unknown as typeof fetch })).rejects.toBeInstanceOf(PiAuthError);

    const hang = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    await expect(verifyPiAccessToken("t", { fetchImpl: hang as unknown as typeof fetch, timeoutMs: 20 })).rejects.toMatchObject({
      kind: "unavailable",
    });

    const noUid = vi.fn(async () => json(200, { username: "mallory" }));
    await expect(verifyPiAccessToken("t", { fetchImpl: noUid as unknown as typeof fetch })).rejects.toMatchObject({
      kind: "unavailable",
    });

    const html = vi.fn(async () => new Response("<html>", { status: 200 }));
    await expect(verifyPiAccessToken("t", { fetchImpl: html as unknown as typeof fetch })).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
});
