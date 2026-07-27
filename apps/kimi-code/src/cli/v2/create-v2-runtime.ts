import {
  createKimiDefaultHeaders,
  createKimiDeviceId,
  KIMI_CODE_PROVIDER_NAME,
} from '@moonshot-ai/kimi-code-oauth';
import {
  KimiAuthFacade,
  resolveConfigPath,
  resolveKimiHome,
} from '@moonshot-ai/kimi-code-sdk';
import {
  createKimiV2Runtime,
  type KimiV2Runtime,
} from '@moonshot-ai/kimi-code-sdk/v2';

import { CLI_USER_AGENT_PRODUCT } from '#/constant/app';

import type { CLIOptions, UIMode } from '../options';
import { createKimiCodeHostIdentity } from '../version';

export interface CliV2RuntimeComposition {
  readonly runtime: KimiV2Runtime;
  readonly homeDir: string;
  readonly firstLaunch: boolean;
}

export async function createCliV2Runtime(
  opts: CLIOptions,
  version: string,
  uiMode: UIMode,
  mode: 'default' | 'print',
): Promise<CliV2RuntimeComposition> {
  const homeDir = resolveKimiHome();
  const configPath = resolveConfigPath({ homeDir });
  const identity = createKimiCodeHostIdentity(version);
  let firstLaunch = false;
  const deviceId = createKimiDeviceId(homeDir, {
    onFirstLaunch: () => {
      firstLaunch = true;
    },
  });
  const auth = new KimiAuthFacade({
    homeDir,
    configPath,
    identity,
  });
  const runtime = await createKimiV2Runtime({
    homeDir,
    configPath,
    clientVersion: version,
    requestHeaders: createKimiDefaultHeaders({ homeDir, ...identity }),
    skillDirs: opts.skillsDirs,
    agentFiles: opts.agentFiles,
    mode,
    telemetry: {
      enabled: true,
      deviceId,
      appName: CLI_USER_AGENT_PRODUCT,
      uiMode,
      model: opts.model,
      getAccessToken: async () =>
        (await auth.getCachedAccessToken(KIMI_CODE_PROVIDER_NAME)) ?? null,
    },
  });

  return { runtime, homeDir, firstLaunch };
}
