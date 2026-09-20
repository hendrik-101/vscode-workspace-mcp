import assert from "node:assert/strict";
import test from "node:test";
import { BridgeSession } from "../src/session";

test("stopping revokes old in-flight write authority permanently before the socket closes", async () => {
  let close!: () => void;
  let aborted = 0;
  const old = new BridgeSession({
    url: "unused",
    token: "unused",
    abortRequests() {
      aborted++;
    },
    close: () =>
      new Promise((resolve) => {
        close = resolve;
      }),
  });
  old.enableWrites();
  assert.equal(old.canWrite(), true);
  const stopped = old.stop();
  assert.equal(old.canWrite(), false);
  assert.equal(aborted, 1);
  const next = new BridgeSession({
    url: "new",
    token: "new",
    abortRequests() {},
    close: async () => {},
  });
  next.enableWrites();
  old.enableWrites();
  assert.equal(old.canWrite(), false);
  assert.equal(next.canWrite(), true);
  close();
  await stopped;
});

test("denying an already read-only session preserves requests; revoking writes and Stop abort", async () => {
  let aborted = 0;
  const session = new BridgeSession({
    url: "unused",
    token: "unused",
    abortRequests() {
      aborted++;
    },
    close: async () => {},
  });
  session.disableWrites();
  assert.equal(aborted, 0);
  session.enableWrites();
  session.disableWrites();
  assert.equal(aborted, 1);
  assert.equal(session.canWrite(), false);
  session.disableWrites();
  assert.equal(aborted, 1);
  await session.stop();
  assert.equal(aborted, 2);
});
