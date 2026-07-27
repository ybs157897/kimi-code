import type { KimiV2Runtime } from '@moonshot-ai/kimi-code-sdk/v2';

import {
  copyPluginInfoView,
  copyPluginSummaryView,
  copyReloadSummaryView,
  type SessionPluginsPort,
} from './session-plugins-port';

type KlientPluginsFacade = Pick<
  KimiV2Runtime['klient']['global']['plugins'],
  | 'list'
  | 'info'
  | 'install'
  | 'setEnabled'
  | 'setMcpServerEnabled'
  | 'remove'
  | 'reload'
>;

interface KlientSessionPluginsRuntime {
  readonly klient: {
    readonly global: {
      readonly plugins: KlientPluginsFacade;
    };
  };
}

/** Bind the v2 runtime's global plugin facade to the neutral TUI port. */
export function createKlientSessionPluginsPort(
  runtime: KlientSessionPluginsRuntime,
): SessionPluginsPort {
  const plugins = runtime.klient.global.plugins;

  return {
    list: async () => (await plugins.list()).map(copyPluginSummaryView),
    info: async (id) => copyPluginInfoView(await plugins.info(id)),
    install: async (source) =>
      copyPluginSummaryView(await plugins.install(source)),
    setEnabled: async (id, enabled) => {
      await plugins.setEnabled({ id, enabled });
    },
    setMcpServerEnabled: async (id, server, enabled) => {
      await plugins.setMcpServerEnabled({ id, server, enabled });
    },
    remove: async (id) => {
      await plugins.remove(id);
    },
    reload: async () => copyReloadSummaryView(await plugins.reload()),
  };
}
