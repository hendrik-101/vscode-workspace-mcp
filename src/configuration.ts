export function clientConfiguration(
  client: "codex" | "claude",
  url: string,
  token: string,
): string {
  const headers = { Authorization: `Bearer ${token}` };
  if (client === "claude") {
    return (
      JSON.stringify(
        { mcpServers: { workspace_mcp: { type: "http", url, headers } } },
        null,
        2,
      ) + "\n"
    );
  }
  return `[mcp_servers.workspace_mcp]\nurl = ${JSON.stringify(url)}\nhttp_headers = { Authorization = ${JSON.stringify(headers.Authorization)} }\n`;
}
