import { randomBytes } from "node:crypto";

export const TOKEN_KEY = "workspaceMcp.bearerToken";
export const DEFAULT_PORT = 39117;
export type WritePolicy = "ask" | "allow" | "deny";
export const WRITE_CHOICES = [
  "Allow for this session",
  "Deny for this session",
  "Always allow",
  "Always deny",
] as const;

export function writeDecision(choice: string | undefined): {
  allow: boolean;
  persist?: WritePolicy;
} {
  switch (choice) {
    case WRITE_CHOICES[0]:
      return { allow: true };
    case WRITE_CHOICES[2]:
      return { allow: true, persist: "allow" };
    case WRITE_CHOICES[3]:
      return { allow: false, persist: "deny" };
    default:
      return { allow: false };
  }
}

export function portPreference(value: unknown): number {
  const port = value ?? DEFAULT_PORT;
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535
  )
    throw new Error(
      "Workspace MCP port must be an integer from 1024 to 65535.",
    );
  return port;
}

export function writePreference(value: unknown): WritePolicy {
  return value === "allow" || value === "deny" ? value : "ask";
}

export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
}

export async function storedToken(secrets: SecretStore): Promise<string> {
  let token = await secrets.get(TOKEN_KEY);
  if (token === undefined) {
    token = randomBytes(32).toString("hex");
    await secrets.store(TOKEN_KEY, token);
    // SecretStorage has no compare-and-swap. Use the last stored value and
    // invalidate running listeners when another window changes this secret.
    token = await secrets.get(TOKEN_KEY);
  }
  if (!token || !/^[a-f0-9]{64}$/.test(token))
    throw new Error(
      "Stored Workspace MCP token is invalid. Use Rotate Token to replace it.",
    );
  return token;
}

export async function rotateToken(secrets: SecretStore): Promise<void> {
  await secrets.store(TOKEN_KEY, randomBytes(32).toString("hex"));
}
