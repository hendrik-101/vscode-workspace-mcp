export interface Connection {
  url: string;
  token: string;
  close(): Promise<void>;
}

export class BridgeSession {
  private allowed = false;
  private revoked = false;
  constructor(readonly connection: Connection) {}
  canWrite = (): boolean => this.allowed && !this.revoked;
  enableWrites(): void {
    if (!this.revoked) this.allowed = true;
  }
  async stop(): Promise<void> {
    this.revoked = true;
    this.allowed = false;
    await this.connection.close();
  }
}
