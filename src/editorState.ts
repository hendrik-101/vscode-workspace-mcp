import { randomBytes } from "node:crypto";
import { WorkspaceError } from "./types.js";

type Model = { readonly version: number };
const revisions = new WeakMap<Model, { native: number; revision: number }>();
// Also make accidental reuse after an extension-host restart unlikely.
let revision = randomBytes(6).readUIntBE(0, 6);

/** A native version is only meaningful within one live text model. */
export function documentRevision(document: Model): number {
  const native = document.version;
  const previous = revisions.get(document);
  if (previous?.native === native) return previous.revision;
  if (revision === Number.MAX_SAFE_INTEGER)
    throw new WorkspaceError(
      "LIMIT_EXCEEDED",
      "Document revision space exhausted.",
    );
  const next = ++revision;
  revisions.set(document, { native, revision: next });
  return next;
}

type NativeTabLimit = {
  perEditorGroup: boolean;
  value: number;
  tabCounts: readonly number[];
};

/** Count existing user tabs without assuming we own or may close any of them. */
export class EditorTabBudget {
  private pending = 0;

  constructor(
    private readonly count: () => number,
    private readonly nativeLimit: () => NativeTabLimit | undefined,
  ) {}

  reserve(): () => void {
    const count = this.count();
    const limit = this.nativeLimit();
    // An open can be routed to another group, e.g. if the active group is locked.
    const nativeCount = limit?.perEditorGroup
      ? limit.tabCounts.reduce((maximum, count) => Math.max(maximum, count), 0)
      : count;
    if (
      count + this.pending >= 32 ||
      (limit && limit.value > 0 && nativeCount + this.pending + 1 > limit.value)
    )
      throw new WorkspaceError(
        "LIMIT_EXCEEDED",
        "The editor tab limit is reached. Close a tab or wait for another reveal to finish.",
      );
    this.pending++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pending--;
    };
  }
}
