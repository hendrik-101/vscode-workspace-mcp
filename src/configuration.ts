/** Render private stdio client configuration; the returned text contains a secret. */
export function clientConfiguration(
  client: "codex" | "claude",
  adapterPath: string,
  url: string,
  token: string,
  certificate: string,
): string {
  const env = {
    WORKSPACE_MCP_URL: url,
    WORKSPACE_MCP_TOKEN: token,
    WORKSPACE_MCP_CERTIFICATE: certificate,
  };
  if (client === "claude") {
    return (
      JSON.stringify(
        {
          mcpServers: {
            workspace_mcp: {
              type: "stdio",
              command: "node",
              args: [adapterPath],
              env,
            },
          },
        },
        null,
        2,
      ) + "\n"
    );
  }
  return `[mcp_servers.workspace_mcp]\ncommand = "node"\nargs = [${JSON.stringify(adapterPath)}]\n\n[mcp_servers.workspace_mcp.env]\n${Object.entries(
    env,
  )
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join("\n")}\n`;
}
