import {
  MAX_RESPONSE_BYTES,
  MAX_IN_FLIGHT_RESPONSE_BYTES,
  MemoryLimitError,
} from "./limits.js";

/** Measure JSON without allocating its escaped text. Duplicate MCP content also
 * needs the escaped JSON string alongside the structured JSON value. */
export function jsonBytes(value: unknown, duplicate = false): number {
  let bytes = 0;
  let escaped = 0;
  const ancestors = new Set<object>();
  const add = (plain: number, nested = plain) => {
    bytes += plain;
    escaped += nested;
    const size = bytes + (duplicate ? escaped + 2 : 0);
    if (size > MAX_RESPONSE_BYTES) throw new MemoryLimitError("response", size);
  };
  const string = (text: string) => {
    add(2, 4);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 34 || code === 92) add(2, 4);
      else if (
        code === 8 ||
        code === 9 ||
        code === 10 ||
        code === 12 ||
        code === 13
      )
        add(2, 3);
      else if (code < 32) add(6, 7);
      else if (code >= 0xd800 && code <= 0xdfff) {
        const next = text.charCodeAt(i + 1);
        if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
          add(4);
          i++;
        } else add(6, 7);
      } else add(code < 128 ? 1 : code < 2048 ? 2 : 3);
    }
  };
  const visit = (input: unknown, key: string, depth: number) => {
    if (depth > 128) throw new TypeError("Response nesting exceeds its limit.");
    let current = input;
    if (
      current &&
      typeof current === "object" &&
      "toJSON" in current &&
      typeof current.toJSON === "function"
    )
      current = current.toJSON(key);
    if (current === null) add(4);
    else if (typeof current === "string") string(current);
    else if (typeof current === "number")
      add(Number.isFinite(current) ? String(current).length : 4);
    else if (typeof current === "boolean") add(current ? 4 : 5);
    else if (typeof current === "object") {
      if (ancestors.has(current)) throw new TypeError("Cyclic response.");
      ancestors.add(current);
      add(1);
      let entries = 0;
      if (Array.isArray(current)) {
        for (let i = 0; i < current.length; i++) {
          if (entries++) add(1);
          const item: unknown = current[i];
          visit(
            item === undefined ||
              typeof item === "function" ||
              typeof item === "symbol"
              ? null
              : item,
            String(i),
            depth + 1,
          );
        }
      } else {
        for (const name in current) {
          if (!Object.hasOwn(current, name)) continue;
          const item: unknown = (current as Record<string, unknown>)[name];
          if (
            item === undefined ||
            typeof item === "function" ||
            typeof item === "symbol"
          )
            continue;
          if (entries++) add(1);
          string(name);
          add(1);
          visit(item, name, depth + 1);
        }
      }
      add(1);
      ancestors.delete(current);
    } else throw new TypeError("Response is not JSON data.");
  };
  visit(value, "", 0);
  return bytes + (duplicate ? escaped + 2 : 0);
}

/** Reservations live until the transport finishes writing, including backpressure. */
export class ResponseBudget {
  private inFlight = 0;

  reserve(bytes: number): () => void {
    if (bytes > MAX_RESPONSE_BYTES)
      throw new MemoryLimitError("response", bytes);
    if (this.inFlight + bytes > MAX_IN_FLIGHT_RESPONSE_BYTES)
      throw new MemoryLimitError("responsesInFlight", this.inFlight + bytes);
    this.inFlight += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= bytes;
    };
  }
}
