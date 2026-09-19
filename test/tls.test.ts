import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { request } from "node:https";
import test from "node:test";
import { generate } from "selfsigned";
import {
  parseIdentity,
  rotateIdentity,
  storedIdentity,
  TLS_KEY,
} from "../src/tls";
import { TOKEN_KEY } from "../src/preferences";
import { startServer } from "../src/server";
import type { WorkspaceApi } from "../src/types";

function memorySecrets() {
  const values = new Map<string, string>();
  return {
    values,
    get: async (key: string) => values.get(key),
    store: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

test("server identity persists and explicit replacement preserves the bearer token", async () => {
  const secrets = memorySecrets();
  secrets.values.set(TOKEN_KEY, "a".repeat(64));
  const first = await storedIdentity(secrets);
  assert.deepEqual(await storedIdentity(secrets), first);
  const certificate = new X509Certificate(first.cert);
  assert.equal(certificate.ca, false);
  assert.equal(certificate.checkIP("127.0.0.1"), "127.0.0.1");
  assert.equal(certificate.publicKey.asymmetricKeyType, "ec");
  assert.equal(
    certificate.publicKey.asymmetricKeyDetails?.namedCurve,
    "prime256v1",
  );
  await rotateIdentity(secrets);
  assert.notEqual((await storedIdentity(secrets)).cert, first.cert);
  assert.equal(secrets.values.get(TOKEN_KEY), "a".repeat(64));
  secrets.values.set(TLS_KEY, "corrupt");
  await assert.rejects(storedIdentity(secrets), /invalid or expired/);
  assert.equal(secrets.values.get(TLS_KEY), "corrupt");
});

test("mismatched private key is refused without exposing key material", async () => {
  const first = await storedIdentity(memorySecrets());
  const second = await storedIdentity(memorySecrets());
  assert.throws(
    () => parseIdentity(JSON.stringify({ cert: first.cert, key: second.key })),
    /invalid or expired/,
  );
});

function httpsStatus(url: string, token: string, ca: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: "POST", ca, headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
}

test("TLS verifies pinned identity before accepting persistent credentials", async () => {
  const identity = await storedIdentity(memorySecrets());
  const attacker = await storedIdentity(memorySecrets());
  const server = await startServer({} as WorkspaceApi, { tls: identity });
  try {
    assert.match(server.url, /^https:\/\/127\.0\.0\.1:/);
    assert.notEqual(
      await httpsStatus(server.url, server.token, identity.cert),
      401,
    );
    assert.equal(await httpsStatus(server.url, "wrong", identity.cert), 401);
    await assert.rejects(httpsStatus(server.url, server.token, attacker.cert));
  } finally {
    await server.close();
  }
});

test("expired server identity is rejected rather than silently renewed", async () => {
  const generated = await generate([{ name: "commonName", value: "expired" }], {
    keyType: "ec",
    algorithm: "sha256",
    notBeforeDate: new Date("2020-01-01"),
    notAfterDate: new Date("2021-01-01"),
    extensions: [
      { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
    ],
  });
  const raw = JSON.stringify({ cert: generated.cert, key: generated.private });
  const secrets = memorySecrets();
  secrets.values.set(TLS_KEY, raw);
  await assert.rejects(storedIdentity(secrets), /invalid or expired/);
  assert.equal(secrets.values.get(TLS_KEY), raw);
});
