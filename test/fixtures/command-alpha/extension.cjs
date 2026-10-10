const vscode = require("vscode");
const counts = new Map();
const pending = [];
exports.activate = (context) => {
  const register = (suffix, handler) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(`issue40.alpha.${suffix}`, (...args) => {
        counts.set(suffix, (counts.get(suffix) || 0) + 1);
        if (args.length)
          throw new Error("Fixture received unexpected command arguments");
        return handler();
      }),
    );
  register("complete", () => true);
  register("undefined", () => undefined);
  register("throw", () => {
    throw new Error("password=alpha-secret");
  });
  register("reject", () => Promise.reject(new Error("token=alpha-secret")));
  register(
    "hang",
    () =>
      new Promise((_resolve, reject) =>
        pending.push(() => reject(new Error("late alpha-secret"))),
      ),
  );
  register("release", () => {
    for (const release of pending.splice(0)) release();
  });
  register("prompt", () =>
    vscode.window.showInputBox({
      prompt: "Must never be dispatched by Workspace MCP",
    }),
  );
  return { calls: (suffix) => counts.get(suffix) || 0 };
};
