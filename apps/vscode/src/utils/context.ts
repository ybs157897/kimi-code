import * as vscode from "vscode";
import type { VscodeHostPort } from "../runtime/v2-host";

export async function updateLoginContext(
  host: Pick<VscodeHostPort, "isAuthenticated">,
): Promise<boolean> {
  const loggedIn = await host.isAuthenticated();
  await vscode.commands.executeCommand("setContext", "kimi.isLoggedIn", loggedIn);
  return loggedIn;
}
