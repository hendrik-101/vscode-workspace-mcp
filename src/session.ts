export interface Connection {
  url: string;
  token: string;
  abortRequests(): void;
  close(): Promise<void>;
}

export class BridgeSession {
  private allowed = false;
  private revoked = false;
  constructor(readonly connection: Connection) {}
  /** Reports whether this session currently grants write access. */
  canWrite = (): boolean => this.allowed && !this.revoked;
  /** Grants write access unless the session has already been revoked. */
  enableWrites(): void {
    if (!this.revoked) this.allowed = true;
  }
  /** Removes write access without stopping read access. */
  disableWrites(): void {
    this.allowed = false;
    this.connection.abortRequests();
  }
  /** Revokes write access before closing the underlying connection. */
  async stop(): Promise<void> {
    this.revoked = true;
    this.allowed = false;
    this.connection.abortRequests();
    await this.connection.close();
  }
}
