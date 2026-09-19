import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PORT,
  portPreference,
  storedToken,
  rotateToken,
  TOKEN_KEY,
  writeDecision,
  WRITE_CHOICES,
  writePreference,
} from "../src/preferences";

test("credentials persist until explicitly rotated; invalid storage fails closed", async () => {
  const values = new Map<string, string>();
  let writes = 0;
  const secrets = {
    get: async (key: string) => values.get(key),
    store: async (key: string, value: string) => {
      writes++;
      values.set(key, value);
    },
  };
  const token = await storedToken(secrets);
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(await storedToken(secrets), token);
  assert.equal(writes, 1);
  await rotateToken(secrets);
  assert.notEqual(await storedToken(secrets), token);
  values.set(TOKEN_KEY, "corrupt");
  await assert.rejects(storedToken(secrets), /invalid/);
  assert.equal(writes, 2);
});

test("write policy has four choices and dismissed/unknown choices deny", () => {
  assert.deepEqual(WRITE_CHOICES.map(writeDecision), [
    { allow: true },
    { allow: false },
    { allow: true, persist: "allow" },
    { allow: false, persist: "deny" },
  ]);
  assert.deepEqual(writeDecision(undefined), { allow: false });
  assert.deepEqual(writeDecision("unknown"), { allow: false });
  assert.equal(writePreference(undefined), "ask");
  assert.equal(writePreference("other"), "ask");
});

test("fixed port preference rejects privileged, ephemeral and invalid ports", () => {
  assert.equal(portPreference(undefined), DEFAULT_PORT);
  for (const value of [0, 1023, 65536, "39117", 1024.5, NaN])
    assert.throws(() => portPreference(value));
  assert.equal(portPreference(65535), 65535);
});
