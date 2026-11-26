import assert from "node:assert/strict";
import test from "node:test";
import { documentRevision, EditorTabBudget } from "../src/editorState.js";

test("document revisions are stable for a snapshot, unique to a live model, and change with content", () => {
  const first = { version: 1 };
  const second = { version: 1 };
  const initial = documentRevision(first);
  assert.ok(Number.isSafeInteger(initial) && initial > 0);
  assert.equal(documentRevision(first), initial);
  assert.notEqual(documentRevision(second), initial);
  first.version++;
  const edited = documentRevision(first);
  assert.notEqual(edited, initial);
  assert.equal(documentRevision(first), edited);
});

test("tab capacity counts reserved openings and is recovered after completion or a tab closes", () => {
  let tabCount = 31;
  const budget = new EditorTabBudget(() => tabCount);
  const release = budget.reserve();
  assert.throws(() => budget.reserve(), { code: "LIMIT_EXCEEDED" });
  release();
  tabCount = 32;
  assert.throws(() => budget.reserve(), { code: "LIMIT_EXCEEDED" });
  tabCount = 31;
  const next = budget.reserve();
  release();
  assert.throws(() => budget.reserve(), { code: "LIMIT_EXCEEDED" });
  next();
  budget.reserve()();
});
