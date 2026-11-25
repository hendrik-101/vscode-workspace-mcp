import { createHash } from "node:crypto";
import { z } from "zod";
import { WorkspaceError } from "./types.js";

export interface CommandHost {
  getCommands(): PromiseLike<string[]>;
  extensions(): readonly { id: string; packageJSON: unknown }[];
  state(): {
    trusted: boolean;
    authorized: boolean;
    allowedCommands: unknown;
    commandProfiles: unknown;
    activeEditorScheme?: string;
    /** Opaque fingerprint of workspace roots and current editor context. */
    context: string;
  };
  configuration(key: string): unknown;
  executeCommand(commandId: string, ...args: CommandArgument[]): unknown;
}
export interface SearchCommandsInput {
  query?: string;
  offset?: number;
  maxResults?: number;
}
export interface InvokeCommandInput {
  commandId: string;
  timeoutMs?: number;
  args?: CommandArgument[];
}
export interface CommandMetadata {
  extensionId: string;
  extensionVersion: string;
  title?: string;
  category?: string;
  provenance: "extension_manifest";
}
export interface CommandEntry {
  commandId: string;
  metadata: CommandMetadata[];
  registered: boolean;
  argumentTypes?: ArgumentType[];
  eligibility: { eligible: boolean; reason: EligibilityReason };
}
export interface SearchCommandsResult {
  commands: CommandEntry[];
  truncated: boolean;
  incomplete: boolean;
  nextOffset?: number;
  scanned: number;
  consistency: "live";
}
export interface InvokeCommandResult {
  outcome: "handler_completed" | "handler_failed" | "completion_unconfirmed";
  businessSuccess: "unknown";
  resultType?: string;
  resultOmitted?: boolean;
  reason?: "timeout" | "cancelled" | "session_stopped";
}
export interface CommandApi {
  search(
    input: SearchCommandsInput,
    signal?: AbortSignal,
  ): Promise<SearchCommandsResult>;
  invoke(
    input: InvokeCommandInput,
    signal?: AbortSignal,
  ): Promise<InvokeCommandResult>;
  dispose(): void;
}

type EligibilityReason =
  | "SUPPORTED"
  | "NOT_AUTHORIZED"
  | "UNTRUSTED_WORKSPACE"
  | "UNSUPPORTED_CONTRACT"
  | "AMBIGUOUS_METADATA"
  | "STALE_CONTRACT"
  | "PREREQUISITE_UNMET"
  | "DISCOVERY_INCOMPLETE"
  | "NOT_REGISTERED";
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/);
const scalar = z.union([
  z.string().max(256),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export const MAX_COMMAND_ARGUMENTS = 8;
export const commandArguments = z
  .array(
    z.union([z.string().max(2048), z.number().finite(), z.boolean(), z.null()]),
  )
  .max(MAX_COMMAND_ARGUMENTS);
type CommandArgument = z.output<typeof commandArguments>[number];
const argumentTypes = z
  .array(z.enum(["string", "number", "boolean", "null"]))
  .max(MAX_COMMAND_ARGUMENTS);
type ArgumentType = z.output<typeof argumentTypes>[number];
const profile = z.strictObject({
  command: id,
  extensionId: id,
  extensionVersion: z.string().min(1).max(80),
  argumentTypes,
  nonInteractive: z.literal(true),
  activeEditorScheme: z
    .string()
    .regex(/^[a-z][a-z0-9+.-]{0,31}$/)
    .optional(),
  requiresConfiguration: z
    .array(
      z.strictObject({
        key: z.string().regex(/^[a-zA-Z0-9._-]{1,200}$/),
        value: scalar,
      }),
    )
    .max(10)
    .optional(),
});
type Profile = z.output<typeof profile>;
type Claim = {
  metadata: CommandMetadata;
  profile?: Profile;
  prerequisites: boolean;
  configuration: unknown[];
};
const MAX_IDS = 10_000;
const MAX_METADATA = 5_000;
const MAX_EXTENSIONS = 256;
export const MAX_OUTSTANDING_COMMANDS = 4;
// Extension-host lifetime, not bridge-session lifetime: Stop/Start cannot bypass
// the cap on handlers which the public API cannot cancel.
const outstanding = new Set<Promise<InvokeCommandResult>>();

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function label(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : object(value)?.value;
  return typeof text === "string"
    ? text.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160)
    : undefined;
}
function fail(
  code:
    | "COMMAND_UNSUPPORTED"
    | "COMMAND_NOT_AUTHORIZED"
    | "COMMAND_CONTEXT_CHANGED"
    | "COMMAND_BUSY"
    | "SESSION_STOPPED"
    | "UNTRUSTED_WORKSPACE"
    | "INVALID_ARGUMENT",
): never {
  throw new WorkspaceError(code, "Command admission failed.");
}
function summarize(value: unknown): InvokeCommandResult {
  const resultType = value === null ? "null" : typeof value;
  const result: InvokeCommandResult = {
    outcome: "handler_completed",
    businessSuccess: "unknown",
    resultType,
    resultOmitted: value !== undefined,
  };
  // No generic schema identifies credential-bearing values (including numeric
  // PINs). Return only a type summary: never inspect or serialize the payload.
  return result;
}

export class CommandService implements CommandApi {
  private readonly stopped = new AbortController();
  constructor(private readonly host: CommandHost) {}
  dispose(): void {
    this.stopped.abort();
  }
  private active(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.stopped.signal.aborted || !this.host.state().authorized)
      fail("SESSION_STOPPED");
  }
  private snapshot() {
    const state = this.host.state();
    const allowed = z.array(id).max(100).safeParse(state.allowedCommands);
    const profiles = z
      .array(profile)
      .max(100)
      .default([])
      .safeParse(state.commandProfiles);
    const profilesById = new Map<string, Profile | undefined>();
    for (const item of profiles.success ? profiles.data : []) {
      profilesById.set(
        item.command,
        profilesById.has(item.command) ? undefined : item,
      );
    }
    const claims = new Map<string, Claim[]>();
    const extensions = this.host.extensions();
    let incomplete = extensions.length > MAX_EXTENSIONS;
    let inspected = 0;
    for (const extension of extensions.slice(0, MAX_EXTENSIONS)) {
      const manifest = object(extension.packageJSON);
      const version = manifest?.version;
      if (
        !manifest ||
        typeof version !== "string" ||
        version.length > 80 ||
        extension.id.length > 200
      ) {
        incomplete = true;
        continue;
      }
      const contributed = object(manifest.contributes)?.commands;
      const commands = Array.isArray(contributed)
        ? contributed
        : object(contributed)
          ? [contributed]
          : [];
      for (const value of commands) {
        if (++inspected > MAX_METADATA) {
          incomplete = true;
          break;
        }
        const command = object(value);
        const parsedId = id.safeParse(command?.command);
        if (!parsedId.success) continue;
        const selected = profilesById.get(parsedId.data);
        const supported =
          selected?.extensionId.toLowerCase() === extension.id.toLowerCase()
            ? selected
            : undefined;
        const configuration = (supported?.requiresConfiguration ?? []).map(
          (requirement) => {
            const parsed = scalar.safeParse(
              this.host.configuration(requirement.key),
            );
            return parsed.success ? parsed.data : { unsupported: true };
          },
        );
        const entry: Claim = {
          metadata: {
            extensionId: extension.id,
            extensionVersion: version,
            title: label(command?.title),
            category: label(command?.category),
            provenance: "extension_manifest",
          },
          profile: supported,
          configuration,
          prerequisites:
            (!supported?.activeEditorScheme ||
              supported.activeEditorScheme === state.activeEditorScheme) &&
            (supported?.requiresConfiguration ?? []).every(
              (requirement, index) =>
                Object.is(configuration[index], requirement.value),
            ),
        };
        const entries = claims.get(parsedId.data) ?? [];
        // Bounded provenance; more than one claimant is already ineligible.
        if (entries.length < 2) entries.push(entry);
        claims.set(parsedId.data, entries);
      }
      if (inspected > MAX_METADATA) break;
    }
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          state: {
            trusted: state.trusted,
            authorized: state.authorized,
            context: state.context,
            activeEditorScheme: state.activeEditorScheme,
            allowedCommands: allowed.success ? allowed.data : [],
          },
          incomplete,
          profilesValid: profiles.success,
          profiledCommands: [...profilesById.keys()],
          claims: [...claims],
        }),
      )
      .digest("hex");
    return {
      state,
      allowed: allowed.success ? allowed.data : [],
      claims,
      profilesValid: profiles.success,
      profilesById,
      incomplete,
      fingerprint,
    };
  }
  private entry(
    commandId: string,
    registered: boolean,
    snapshot: ReturnType<CommandService["snapshot"]>,
  ): CommandEntry {
    const claims = snapshot.claims.get(commandId) ?? [];
    const evidence = claims[0];
    const profile = evidence?.profile;
    const profileMismatch =
      !snapshot.profilesValid ||
      (snapshot.profilesById.has(commandId) && !profile);
    const stale =
      profile !== undefined &&
      profile.extensionVersion !== evidence?.metadata.extensionVersion;
    let reason: EligibilityReason;
    if (snapshot.incomplete) reason = "DISCOVERY_INCOMPLETE";
    else if (claims.length > 1) reason = "AMBIGUOUS_METADATA";
    else if (!evidence || profileMismatch) reason = "UNSUPPORTED_CONTRACT";
    else if (stale) reason = "STALE_CONTRACT";
    else if (!evidence.prerequisites || !snapshot.state.context)
      reason = "PREREQUISITE_UNMET";
    else if (!snapshot.state.trusted) reason = "UNTRUSTED_WORKSPACE";
    else if (!snapshot.allowed.includes(commandId)) reason = "NOT_AUTHORIZED";
    else if (!registered) reason = "NOT_REGISTERED";
    else reason = "SUPPORTED";
    return {
      commandId,
      registered,
      ...(claims.length === 1 && !profileMismatch && !stale
        ? { argumentTypes: profile?.argumentTypes ?? [] }
        : {}),
      metadata: claims.map((claim) => claim.metadata),
      eligibility: { eligible: reason === "SUPPORTED", reason },
    };
  }
  async search(
    input: SearchCommandsInput,
    signal?: AbortSignal,
  ): Promise<SearchCommandsResult> {
    this.active(signal);
    const parsed = z
      .strictObject({
        query: z.string().max(128).optional(),
        offset: z
          .number()
          .int()
          .min(0)
          .max(MAX_IDS + MAX_METADATA)
          .optional(),
        maxResults: z.number().int().min(1).max(100).optional(),
      })
      .safeParse(input);
    if (!parsed.success) fail("INVALID_ARGUMENT");
    const ids = await this.host.getCommands();
    this.active(signal);
    const snapshot = this.snapshot();
    const query = (input.query ?? "").toLowerCase();
    const registered = new Set(
      ids.slice(0, MAX_IDS).filter((value) => id.safeParse(value).success),
    );
    const entries = [...new Set([...registered, ...snapshot.claims.keys()])]
      .sort()
      .map((value) => this.entry(value, registered.has(value), snapshot))
      .filter((entry) =>
        [
          entry.commandId,
          ...entry.metadata.flatMap((metadata) => [
            metadata.title ?? "",
            metadata.category ?? "",
            metadata.extensionId,
          ]),
        ].some((value) => value.toLowerCase().includes(query)),
      );
    const offset = input.offset ?? 0;
    const end = Math.min(entries.length, offset + (input.maxResults ?? 20));
    const incomplete = snapshot.incomplete || ids.length > MAX_IDS;
    if (incomplete)
      for (const entry of entries)
        entry.eligibility = { eligible: false, reason: "DISCOVERY_INCOMPLETE" };
    return {
      commands: entries.slice(offset, end),
      truncated: end < entries.length || incomplete,
      incomplete,
      ...(end < entries.length ? { nextOffset: end } : {}),
      scanned: Math.min(ids.length, MAX_IDS),
      consistency: "live",
    };
  }
  async invoke(
    input: InvokeCommandInput,
    signal?: AbortSignal,
  ): Promise<InvokeCommandResult> {
    this.active(signal);
    if (
      !z
        .strictObject({
          commandId: id,
          args: commandArguments.optional(),
          timeoutMs: z.number().int().min(1).max(20_000).optional(),
        })
        .safeParse(input).success
    )
      fail("INVALID_ARGUMENT");
    const before = this.snapshot();
    const ids = await this.host.getCommands();
    this.active(signal);
    const current = this.snapshot();
    if (before.fingerprint !== current.fingerprint)
      fail("COMMAND_CONTEXT_CHANGED");
    if (!current.state.trusted) fail("UNTRUSTED_WORKSPACE");
    if (!current.allowed.includes(input.commandId))
      fail("COMMAND_NOT_AUTHORIZED");
    const entry = this.entry(
      input.commandId,
      ids.includes(input.commandId),
      current,
    );
    if (ids.length > MAX_IDS || !entry.eligibility.eligible)
      fail("COMMAND_UNSUPPORTED");
    const args = input.args ?? [];
    const expected = entry.argumentTypes ?? [];
    if (
      args.length !== expected.length ||
      args.some(
        (value, index) =>
          (value === null ? "null" : typeof value) !== expected[index],
      )
    )
      fail("INVALID_ARGUMENT");
    if (outstanding.size >= MAX_OUTSTANDING_COMMANDS) fail("COMMAND_BUSY");
    this.active(signal);
    // No await between the final admission check and dispatch. The returned
    // promise observes both synchronous throws and late asynchronous rejection.
    let raw: unknown;
    try {
      raw = this.host.executeCommand(input.commandId, ...args);
    } catch {
      return { outcome: "handler_failed", businessSuccess: "unknown" };
    }
    const handler = Promise.resolve(raw).then(
      summarize,
      () =>
        ({
          outcome: "handler_failed",
          businessSuccess: "unknown",
        }) as InvokeCommandResult,
    );
    outstanding.add(handler);
    void handler.then(
      () => outstanding.delete(handler),
      () => outstanding.delete(handler),
    );
    const aborted = AbortSignal.any([
      this.stopped.signal,
      ...(signal ? [signal] : []),
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => {};
    try {
      return await Promise.race([
        handler,
        new Promise<InvokeCommandResult>((resolve) => {
          const unconfirmed = (reason: InvokeCommandResult["reason"]) =>
            resolve({
              outcome: "completion_unconfirmed",
              businessSuccess: "unknown",
              reason,
            });
          onAbort = () =>
            unconfirmed(
              this.stopped.signal.aborted ? "session_stopped" : "cancelled",
            );
          aborted.addEventListener("abort", onAbort, { once: true });
          if (aborted.aborted) onAbort();
          timer = setTimeout(
            () => unconfirmed("timeout"),
            input.timeoutMs ?? 20_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      aborted.removeEventListener("abort", onAbort);
    }
  }
}
