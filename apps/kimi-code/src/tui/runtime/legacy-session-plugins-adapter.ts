import type { Session } from '@moonshot-ai/kimi-code-sdk';

import {
  copyPluginInfoView,
  copyPluginSummaryView,
  copyReloadSummaryView,
  type SessionPluginsPort,
} from './session-plugins-port';

type LegacySessionPluginsSession = Pick<
  Session,
  | 'listPlugins'
  | 'getPluginInfo'
  | 'installPlugin'
  | 'setPluginEnabled'
  | 'setPluginMcpServerEnabled'
  | 'removePlugin'
  | 'reloadPlugins'
>;

/** Bind the legacy Session plugin capabilities to the neutral TUI port. */
export function createLegacySessionPluginsPort(
  session: LegacySessionPluginsSession,
): SessionPluginsPort {
  return {
    list: async () =>
      (await session.listPlugins()).map(copyPluginSummaryView),
    info: async (id) => copyPluginInfoView(await session.getPluginInfo(id)),
    install: async (source) =>
      copyPluginSummaryView(await session.installPlugin(source)),
    setEnabled: async (id, enabled) => {
      await session.setPluginEnabled(id, enabled);
    },
    setMcpServerEnabled: async (id, server, enabled) => {
      await session.setPluginMcpServerEnabled(id, server, enabled);
    },
    remove: async (id) => {
      await session.removePlugin(id);
    },
    reload: async () => copyReloadSummaryView(await session.reloadPlugins()),
  };
}
