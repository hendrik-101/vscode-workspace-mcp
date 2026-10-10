import { MAX_JSON_DEPTH, MAX_JSON_TOKENS } from "./limits.js";

export class JsonStructureError extends Error {}

/** Bound parsed allocations before JSON.parse; validity remains the parser's job. */
export class JsonStructureGuard {
  private tokens = 0;
  private depth = 0;
  private quoted = false;
  private escaped = false;
  private primitive = false;

  constructor(private readonly lines = false) {}

  push(bytes: Uint8Array): void {
    for (const byte of bytes) {
      // Stdio frames end at raw LF, including malformed quoted input. HTTP
      // permits whitespace within one JSON body and must not reset there.
      if (this.lines && byte === 10) {
        this.tokens = this.depth = 0;
        this.quoted = this.escaped = this.primitive = false;
        continue;
      }
      if (this.quoted) {
        if (this.escaped) this.escaped = false;
        else if (byte === 92) this.escaped = true;
        else if (byte === 34) this.quoted = false;
        continue;
      }
      if (byte === 34) {
        this.token();
        this.quoted = true;
        this.primitive = false;
      } else if (byte === 123 || byte === 91) {
        this.token();
        if (++this.depth > MAX_JSON_DEPTH) {
          throw new JsonStructureError(
            `JSON nesting exceeds the ${MAX_JSON_DEPTH} level limit. Send a less deeply nested operation.`,
          );
        }
        this.primitive = false;
      } else if (byte === 125 || byte === 93) {
        this.depth--;
        this.primitive = false;
      } else if (
        byte === 44 ||
        byte === 58 ||
        byte === 32 ||
        byte === 9 ||
        byte === 10 ||
        byte === 13
      ) {
        this.primitive = false;
      } else if (!this.primitive) {
        this.token();
        this.primitive = true;
      }
    }
  }

  private token(): void {
    if (++this.tokens > MAX_JSON_TOKENS) {
      throw new JsonStructureError(
        `JSON structure exceeds the ${MAX_JSON_TOKENS} token limit (containers, keys and values). Send fewer entries or remove excessive metadata.`,
      );
    }
  }
}
