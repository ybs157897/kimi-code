import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { detectInstallSource } from '#/cli/update/source';
import { detectShellEnvironment } from '#/utils/process/shell-env';
import { toTerminalHyperlink } from '#/utils/terminal-hyperlink';
import { LLM_NOT_SET_MESSAGE, NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { isAbortError } from '../utils/errors';
import { formatErrorMessage } from '../utils/event-payload';
import { buildExportMarkdown } from '../utils/export-markdown';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// Session commands
// ---------------------------------------------------------------------------

export async function handleTitleCommand(host: SlashCommandHost, args: string): Promise<void> {
  const title = args.trim();
  if (title.length === 0) {
    const current = host.state.appState.sessionTitle;
    host.showStatus(
      current !== null && current.length > 0
        ? `Session title: ${current}`
        : `Session title: (not set) — id: ${host.state.appState.sessionId}`,
    );
    return;
  }

  let runtime: ReturnType<SlashCommandHost['requireSessionRuntime']>;
  try {
    runtime = host.requireSessionRuntime();
  } catch {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const newTitle = title.slice(0, 200);
  try {
    await runtime.lifecycle.setTitle(newTitle);
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to set title: ${msg}`);
    return;
  }
  host.showStatus(`Session title set to: ${newTitle}`);
}

export async function handleForkCommand(host: SlashCommandHost, args: string): Promise<void> {
  void args;
  let runtime: ReturnType<SlashCommandHost['requireSessionRuntime']>;
  try {
    runtime = host.requireSessionRuntime();
  } catch {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const sourceTitle = forkSourceTitle(host, runtime.sessionId);
  let forked: Awaited<ReturnType<typeof runtime.lifecycle.fork>>;
  try {
    forked = await runtime.lifecycle.fork({
      title: `Fork: ${sourceTitle}`,
    });
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to fork session: ${msg}`);
    return;
  }

  try {
    await host.switchToSessionIdentity(
      forked,
      `Session forked (${forked.id}). To return to the original session: kimi -r ${runtime.sessionId}`,
    );
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to switch to forked session: ${msg}`);
  }
}

function forkSourceTitle(host: SlashCommandHost, sessionId: string): string {
  const currentTitle = host.state.appState.sessionTitle?.trim();
  if (currentTitle !== undefined && currentTitle.length > 0) return currentTitle;
  return sessionId;
}

export async function handleExportMdCommand(host: SlashCommandHost, args: string): Promise<void> {
  let runtime: ReturnType<SlashCommandHost['requireSessionRuntime']>;
  try {
    runtime = host.requireSessionRuntime();
  } catch {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  host.showStatus('Exporting session as Markdown…');
  try {
    const context = await runtime.contextView.read();
    if (context.history.length === 0) {
      host.showError('No messages to export.');
      return;
    }

    const now = new Date();
    const shortId = runtime.sessionId.slice(0, 8);
    const timestamp = now.toISOString().replaceAll(/[-:]/g, '').replace(/T/, '-').slice(0, 15);
    const defaultName = `kimi-export-${shortId}-${timestamp}.md`;

    const trimmedArgs = args.trim();
    const outputPath = trimmedArgs.length > 0
      ? resolve(trimmedArgs)
      : resolve(host.state.appState.workDir, defaultName);

    const md = buildExportMarkdown({
      sessionId: runtime.sessionId,
      workDir: host.state.appState.workDir,
      history: context.history,
      tokenCount: context.tokenCount,
      now,
    });

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, md, 'utf-8');

    const linked = toTerminalHyperlink(outputPath, pathToFileURL(outputPath).href);
    host.showNotice(`Exported ${String(context.history.length)} messages`, linked);
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to export session: ${msg}`);
  }
}

export async function handleExportDebugZipCommand(host: SlashCommandHost): Promise<void> {
  let runtime: ReturnType<SlashCommandHost['requireSessionRuntime']>;
  try {
    runtime = host.requireSessionRuntime();
  } catch {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  host.showStatus('Exporting session…');
  try {
    const installSource = await detectInstallSource();
    const shellEnv = detectShellEnvironment();
    const result = await host.runtime.sessionExport.export({
      sessionId: runtime.sessionId,
      version: host.state.appState.version,
      installSource,
      shellEnv,
      includeGlobalLog: true,
    });
    const linked = toTerminalHyperlink(result.zipPath, pathToFileURL(result.zipPath).href);
    host.showNotice('Export complete', linked);
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to export session: ${msg}`);
  }
}

export async function handleInitCommand(host: SlashCommandHost): Promise<void> {
  if (host.state.appState.model.trim().length === 0) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }

  let runtime: ReturnType<SlashCommandHost['requireSessionRuntime']>;
  try {
    runtime = host.requireSessionRuntime();
  } catch {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }

  host.deferUserMessages = true;
  host.beginSessionRequest();
  try {
    await runtime.init.generateAgentsMd();
    host.track('init_complete');
    host.streamingUI.finalizeTurn((item) => {
      host.sendQueuedMessage(item);
    });
  } catch (error) {
    if (isAbortError(error)) {
      host.setAppState({ streamingPhase: 'idle' });
      host.resetLivePane();
      return;
    }
    const msg = error instanceof Error ? error.message : String(error);
    host.failSessionRequest(`Init failed: ${msg}`);
  } finally {
    host.deferUserMessages = false;
  }
}
