import { createPrivateKey, X509Certificate } from "node:crypto";
import { generate } from "selfsigned";
import type { SecretStore } from "./preferences";

export const TLS_KEY = "workspaceMcp.serverIdentity";
export interface ServerIdentity {
  cert: string;
  key: string;
}

/** Validates the persisted identity without silently replacing client trust. */
export function parseIdentity(raw: string): ServerIdentity {
  try {
    if (raw.length > 16384) throw new Error();
    const identity: unknown = JSON.parse(raw);
    if (!identity || typeof identity !== "object") throw new Error();
    const { cert, key } = identity as Partial<ServerIdentity>;
    if (typeof cert !== "string" || typeof key !== "string") throw new Error();
    const certificate = new X509Certificate(cert);
    const now = Date.now();
    if (
      !certificate.checkPrivateKey(createPrivateKey(key)) ||
      !certificate.verify(certificate.publicKey) ||
      certificate.checkIP("127.0.0.1") !== "127.0.0.1" ||
      Date.parse(certificate.validFrom) > now ||
      Date.parse(certificate.validTo) <= now
    )
      throw new Error();
    return { cert, key };
  } catch {
    throw new Error(
      "Stored Workspace MCP server identity is invalid or expired. Use Rotate Server Identity, then update client configuration.",
    );
  }
}

async function generateIdentity(): Promise<ServerIdentity> {
  const now = Date.now();
  const generated = await generate(
    [{ name: "commonName", value: "Workspace MCP" }],
    {
      keyType: "ec",
      curve: "P-256",
      algorithm: "sha256",
      notBeforeDate: new Date(now - 5 * 60 * 1000),
      notAfterDate: new Date(now + 3650 * 24 * 60 * 60 * 1000),
      extensions: [
        { name: "basicConstraints", cA: false, critical: true },
        { name: "keyUsage", digitalSignature: true, critical: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
      ],
    },
  );
  return parseIdentity(
    JSON.stringify({ cert: generated.cert, key: generated.private }),
  );
}

/** Generates once, then reads back the winning identity if another window races. */
export async function storedIdentity(
  secrets: SecretStore,
): Promise<ServerIdentity> {
  let raw = await secrets.get(TLS_KEY);
  if (raw === undefined) {
    await secrets.store(TLS_KEY, JSON.stringify(await generateIdentity()));
    raw = await secrets.get(TLS_KEY);
  }
  return parseIdentity(raw ?? "");
}

/** Replaces server identity only after explicit user confirmation. */
export async function rotateIdentity(secrets: SecretStore): Promise<void> {
  await secrets.store(TLS_KEY, JSON.stringify(await generateIdentity()));
}
