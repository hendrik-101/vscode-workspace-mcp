import { startAdapter } from "./stdio";

void startAdapter({
  url: process.env.WORKSPACE_MCP_URL ?? "",
  token: process.env.WORKSPACE_MCP_TOKEN ?? "",
  certificate: process.env.WORKSPACE_MCP_CERTIFICATE ?? "",
  onInputError: (message) => {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  },
}).then(
  (adapter) => {
    const stop = () => {
      void adapter.close();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  },
  () => {
    process.stderr.write(
      "Workspace MCP adapter could not connect. Check Node.js, start the bridge, and refresh its connection details.\n",
    );
    process.exitCode = 1;
  },
);
