import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import type { TUISessionRuntime } from '../runtime/tui-session-runtime';
import type { SlashCommandHost } from './dispatch';

type AddDirChoice = 'session' | 'remember' | 'cancel';

export async function handleAddDirCommand(host: SlashCommandHost, args: string): Promise<void> {
  const input = args.trim();
  const sessionId = host.state.appState.sessionId;

  if (sessionId.length === 0) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const runtime = host.requireSessionRuntime();
  if (runtime.sessionId !== sessionId) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  if (input.length === 0 || input.toLowerCase() === 'list') {
    const { additionalDirs } = await runtime.workspace.get();
    if (additionalDirs.length === 0) {
      host.showStatus('No additional directories configured.');
      return;
    }
    host.showStatus(formatAdditionalDirsStatus(additionalDirs));
    return;
  }

  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: `Add directory to workspace: ${input}`,
      hint: '↑↓ navigate · Enter confirm · Esc cancel',
      options: [
        {
          value: 'session',
          label: 'Yes, for this session',
        },
        {
          value: 'remember',
          label: 'Yes, and remember this directory',
        },
        {
          value: 'cancel',
          label: 'No',
        },
      ],
      onSelect: (value) => {
        void handleAddDirChoice(host, runtime, input, value as AddDirChoice);
      },
      onCancel: () => {
        host.restoreEditor();
        host.showStatus(`Did not add ${input} as a working directory.`);
      },
    }),
  );
}

function formatAdditionalDirsStatus(additionalDirs: readonly string[]): string {
  return ['Additional directories:', ...additionalDirs.map((dir) => `  ${dir}`)].join('\n');
}

async function handleAddDirChoice(
  host: SlashCommandHost,
  runtime: TUISessionRuntime,
  path: string,
  choice: AddDirChoice,
): Promise<void> {
  host.restoreEditor();

  if (choice === 'cancel') {
    host.showStatus(`Did not add ${path} as a working directory.`);
    return;
  }

  if (host.state.appState.sessionId !== runtime.sessionId) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  try {
    const result = await runtime.workspace.addAdditionalDir(path, {
      persist: choice === 'remember',
    });
    host.setAppState({ additionalDirs: result.additionalDirs });
    host.refreshSlashCommandAutocomplete();
    host.showStatus(
      choice === 'remember'
        ? `Added workspace directory:\n  ${path}\n  Saved to:\n  ${result.configPath}`
        : `Added workspace directory:\n  ${path}\n  For this session only`,
      'success',
    );
  } catch (error) {
    host.showError(error instanceof Error ? error.message : String(error));
  }
}
