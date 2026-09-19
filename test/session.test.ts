import assert from "node:assert/strict";
import test from "node:test";
import { BridgeSession } from "../src/session";

test("stopping revokes old in-flight write authority permanently before the socket closes", async () => {
  let close!: () => void;
  const old = new BridgeSession({
    url: "unused",
    token: "unused",
    close: () =>
      new Promise((resolve) => {
        close = resolve;
      }),
  });
  old.enableWrites();
  assert.equal(old.canWrite(), true);
  const stopped = old.stop();
  assert.equal(old.canWrite(), false);
  const next = new BridgeSession({
    url: "new",
    token: "new",
    close: async () => {},
  });
  next.enableWrites();
  old.enableWrites();
  assert.equal(old.canWrite(), false);
  assert.equal(next.canWrite(), true);
  close();
  await stopped;
});
