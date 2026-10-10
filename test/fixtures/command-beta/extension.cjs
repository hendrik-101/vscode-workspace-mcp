const vscode = require("vscode");
const counts = new Map();
exports.activate = (context) => {
  const register = (suffix, handler) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(`issue40.beta.${suffix}`, (...args) => {
        counts.set(suffix, (counts.get(suffix) || 0) + 1);
        if (args.length)
          throw new Error("Fixture received unexpected command arguments");
        return handler();
      }),
    );
  register("complete", () => 42);
  register("opaque", () => {
    const value = {
      token: "beta-secret",
      toJSON() {
        throw new Error("must not serialize");
      },
    };
    value.self = value;
    return value;
  });
  register("prompt", () =>
    vscode.window.showQuickPick(["Must never be dispatched"]),
  );
  return { calls: (suffix) => counts.get(suffix) || 0 };
};
