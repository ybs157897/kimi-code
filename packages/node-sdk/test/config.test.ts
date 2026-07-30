/**
 * Scenario: root SDK config loading, mutation, diagnostics, and reload controls.
 * Responsibilities: preserve public config behavior and route reload options into v2.
 * Wiring: real SDK/Core runtime with local config files and no external provider.
 * Run: pnpm exec vitest run test/config.test.ts
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createKimiConfigRpc,
  createKimiHarness,
  effectiveModelAlias,
  KimiError,
} from '#/index';

import {
  parseConfigString,
  readConfigFile,
  writeConfigFile,
} from '../src/sdk-config';
import { TEST_IDENTITY } from './test-identity';

// node-sdk/agent-core normalize paths to forward slashes (pathe). Mirror that
// in path assertions so they hold on Windows, where node:path produces
// backslashes.
const toPosix = (p: string): string => p.replaceAll('\\', '/');

const tempDirs: string[] = [];

it('resolves a model alias when overrides are omitted', () => {
  expect(
    effectiveModelAlias({
      provider: 'example',
      model: 'model-1',
      supportEfforts: ['low', 'high'],
      defaultEffort: 'high',
    }),
  ).toMatchObject({
    provider: 'example',
    model: 'model-1',
    supportEfforts: ['low', 'high'],
    defaultEffort: 'high',
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-config-'));
  tempDirs.push(dir);
  return dir;
}

const COMPLETE_TOML = `
default_model = "kimi-for-coding"
default_permission_mode = "auto"
skip_afk_prompt_injection = false
default_plan_mode = false
default_editor = ""
theme = "dark"
show_thinking_stream = true
merge_all_available_skills = true
extra_skill_dirs = ["~/team-skills", ".agents/team-skills"]

[providers.kimi-for-coding]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = "sk-xxx"
custom_headers = { "X-Custom-Header" = "value" }

[providers.kimi-for-coding.env]
GOOGLE_CLOUD_PROJECT = "project-1"

[models.kimi-for-coding]
provider = "kimi-for-coding"
model = "kimi-for-coding"
max_context_size = 262144
capabilities = ["image_in", "thinking", "video_in"]
display_name = "Kimi for Coding"

[loop_control]
max_retries_per_step = 3
max_ralph_iterations = 0
reserved_context_size = 50000
compaction_trigger_ratio = 0.85

[background]
max_running_tasks = 4
keep_alive_on_exit = false
kill_grace_period_ms = 2000
print_wait_ceiling_s = 3600

[services.moonshot_search]
base_url = "https://api.kimi.com/coding/v1/search"
api_key = "sk-search"
custom_headers = { "X-Search" = "1" }

[services.moonshot_fetch]
base_url = "https://api.kimi.com/coding/v1/fetch"
api_key = "sk-fetch"

[notifications]
claim_stale_after_ms = 15000

[thinking]
enabled = true
effort = "high"
`;

describe('SDK config TOML', () => {
  it('resolves config paths through the config RPC wrapper', async () => {
    const dir = await makeTempDir();
    const rpc = createKimiConfigRpc();

    await expect(rpc.resolveConfigPath({ homeDir: dir })).resolves.toBe(toPosix(join(dir, 'config.toml')));
  });

  it.each([
    ['a string', '"large"'],
    ['zero', '0'],
  ])(
    'returns structured validation issues for max_context_size set to %s',
    async (_description, maxContextSize) => {
    const rpc = createKimiConfigRpc();

    await expect(
      rpc.validateConfigToml({
        text: `
[providers.kimi]
type = "kimi"

[models.kimi]
provider = "kimi"
model = "kimi"
max_context_size = ${maxContextSize}
`,
        filePath: 'broken.toml',
      }),
    ).rejects.toMatchObject({
      details: {
        validationIssues: [
          {
            path: ['models', 'kimi', 'maxContextSize'],
          },
        ],
      },
    });
    },
  );

  it('parses the documented config shape and keeps TUI-only fields in raw', () => {
    const config = parseConfigString(COMPLETE_TOML, 'complete.toml') as Record<string, unknown>;

    expect(config['defaultModel']).toBe('kimi-for-coding');
    expect((config['thinking'] as { enabled?: boolean } | undefined)?.enabled).toBe(true);
    expect((config['thinking'] as { effort?: string } | undefined)?.effort).toBe('high');
    expect(config['defaultPermissionMode']).toBe('auto');
    expect(config['defaultPlanMode']).toBe(false);
    expect(config['mergeAllAvailableSkills']).toBe(true);
    expect(config['extraSkillDirs']).toEqual(['~/team-skills', '.agents/team-skills']);

    const provider = (config['providers'] as Record<string, Record<string, unknown>> | undefined)?.['kimi-for-coding'];
    expect(provider).toMatchObject({
      type: 'kimi',
      baseUrl: 'https://api.kimi.com/coding/v1',
      apiKey: 'sk-xxx',
      customHeaders: { 'X-Custom-Header': 'value' },
      env: { GOOGLE_CLOUD_PROJECT: 'project-1' },
    });

    expect(config['models']).toMatchObject({
      'kimi-for-coding': {
        provider: 'kimi-for-coding',
        model: 'kimi-for-coding',
        maxContextSize: 262144,
        capabilities: ['image_in', 'thinking', 'video_in'],
        displayName: 'Kimi for Coding',
      },
    });

    expect(config['loopControl']).toEqual({
      maxRetriesPerStep: 3,
      maxRalphIterations: 0,
      reservedContextSize: 50000,
      compactionTriggerRatio: 0.85,
    });
    expect(config['background']).toEqual({
      maxRunningTasks: 4,
      keepAliveOnExit: false,
      killGracePeriodMs: 2000,
      printWaitCeilingS: 3600,
    });
    const services = config['services'] as Record<string, Record<string, unknown>> | undefined;
    expect(services?.['moonshotSearch']?.['customHeaders']).toEqual({ 'X-Search': '1' });
    expect(services?.['moonshotFetch']?.['apiKey']).toBe('sk-fetch');

    expect('theme' in config).toBe(false);
    expect(config['raw']).toMatchObject({
      theme: 'dark',
      skip_afk_prompt_injection: false,
      show_thinking_stream: true,
      notifications: { claim_stale_after_ms: 15000 },
    });
  });

  it('writes typed fields in snake_case and preserves unknown raw sections', async () => {
    const dir = await makeTempDir();
    const configPath = join(dir, 'config.toml');
    const config = parseConfigString(COMPLETE_TOML, configPath) as Record<string, unknown>;

    await writeConfigFile(configPath, {
      ...config,
      defaultModel: 'kimi-for-coding',
      loopControl: {
        ...(config['loopControl'] as Record<string, unknown>),
        maxStepsPerTurn: 42,
      },
    } as Record<string, unknown>);

    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('default_model = "kimi-for-coding"');
    expect(text).toContain('default_permission_mode = "auto"');
    expect(text).toContain('extra_skill_dirs = [ "~/team-skills", ".agents/team-skills" ]');
    expect(text).not.toContain('default_yolo');
    expect(text).toContain('max_steps_per_turn = 42');
    expect(text).toContain('display_name = "Kimi for Coding"');
    expect(text).toContain('GOOGLE_CLOUD_PROJECT = "project-1"');
    expect(text).toContain('claim_stale_after_ms = 15000');
    expect(text).toContain('theme = "dark"');

    const reloaded = readConfigFile(configPath) as Record<string, unknown>;
    expect((reloaded['loopControl'] as Record<string, unknown> | undefined)?.['maxStepsPerTurn']).toBe(42);
    expect((reloaded['raw'] as Record<string, unknown> | undefined)?.['theme']).toBe('dark');
  });

  it('accepts camelCase aliases without keeping unknown fields in typed config', () => {
    const config = parseConfigString(`
defaultModel = "camel-model"

[providers.local]
type = "openai"
baseUrl = "https://example.test/v1"
apiKey = "sk-test"
unsupported_provider_field = "raw-only"

[models.camel-model]
provider = "local"
model = "gpt-test"
maxContextSize = 128000
displayName = "Camel Model"
custom_model_field = "raw-only"

[services.moonshotSearch]
baseUrl = "https://example.test/search"
apiKey = "sk-search"

[loopControl]
maxStepsPerRun = 7

[background]
maxRunningTasks = 2
`);

    const cfg = config as Record<string, unknown>;
    expect(cfg['defaultModel']).toBe('camel-model');
    expect((cfg['providers'] as Record<string, Record<string, unknown>> | undefined)?.['local']).toMatchObject({
      type: 'openai',
      baseUrl: 'https://example.test/v1',
      apiKey: 'sk-test',
    });
    expect((cfg['models'] as Record<string, Record<string, unknown>> | undefined)?.['camel-model']).toMatchObject({
      maxContextSize: 128000,
      displayName: 'Camel Model',
    });
    const svcs = cfg['services'] as Record<string, Record<string, unknown>> | undefined;
    expect(svcs?.['moonshotSearch']).toMatchObject({
      baseUrl: 'https://example.test/search',
      apiKey: 'sk-search',
    });
    expect((cfg['loopControl'] as Record<string, unknown> | undefined)?.['maxStepsPerTurn']).toBe(7);
    expect((cfg['background'] as Record<string, unknown> | undefined)?.['maxRunningTasks']).toBe(2);

    const providers = cfg['providers'] as Record<string, Record<string, unknown>>;
    expect('unsupportedProviderField' in (providers['local'] as Record<string, unknown>)).toBe(false);
    const models = cfg['models'] as Record<string, Record<string, unknown>>;
    expect('customModelField' in (models['camel-model'] as Record<string, unknown>)).toBe(false);

    const rawCfg = cfg['raw'] as Record<string, unknown>;
    const rawProviders = rawCfg['providers'] as Record<string, Record<string, unknown>>;
    const rawModels = rawCfg['models'] as Record<string, Record<string, unknown>>;
    expect(rawProviders['local']?.['unsupported_provider_field']).toBe('raw-only');
    expect(rawModels['camel-model']?.['custom_model_field']).toBe('raw-only');
  });
});

describe('KimiHarness config API', () => {
  it('rejects disabling mandatory v2 config loading with a stable error', () => {
    const homeDir = join(tmpdir(), 'kimi-sdk-config-autoload-disabled');

    expect(() =>
      createKimiHarness({
        homeDir,
        identity: TEST_IDENTITY,
        autoLoadConfig: false,
      }),
    ).toThrow(expect.objectContaining({
      name: 'KimiError',
      code: 'not_implemented',
      details: { option: 'autoLoadConfig' },
    }));
  });

  it('loads default config when missing and deep-merges setConfig patches from disk', async () => {
    const homeDir = await makeTempDir();
    const configPath = join(homeDir, 'config.toml');
    await writeFile(configPath, COMPLETE_TOML, 'utf-8');

    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    await harness.setConfig({
      providers: {
        'kimi-for-coding': {
          apiKey: 'sk-updated',
        },
      },
      services: {
        moonshotSearch: {
          apiKey: 'sk-search-updated',
        },
      },
    });

    const config = await harness.getConfig({ reload: true });
    expect(config.providers!['kimi-for-coding']).toMatchObject({
      type: 'kimi',
      baseUrl: 'https://api.kimi.com/coding/v1',
      apiKey: 'sk-updated',
      env: { GOOGLE_CLOUD_PROJECT: 'project-1' },
    });
    const svcs = config['services'] as Record<string, Record<string, unknown>> | undefined;
    expect(svcs?.['moonshotSearch']?.['apiKey']).toBe('sk-search-updated');
    expect((config['raw'] as Record<string, unknown> | undefined)?.['theme']).toBe('dark');

    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('theme = "dark"');
    expect(text).toContain('GOOGLE_CLOUD_PROJECT = "project-1"');
    expect(text).toContain('claim_stale_after_ms = 15000');
  });

  it('removes a provider through the public Harness API and returns persisted config', async () => {
    const homeDir = await makeTempDir();
    const configPath = join(homeDir, 'config.toml');
    await writeFile(configPath, COMPLETE_TOML, 'utf-8');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const updated = await harness.removeProvider('kimi-for-coding');

      expect(updated.providers?.['kimi-for-coding']).toBeUndefined();
      await expect(harness.getConfig({ reload: true })).resolves.toMatchObject({
        providers: {},
      });
    } finally {
      await harness.close();
    }
  });

  it('does not write invalid config patches', async () => {
    const homeDir = await makeTempDir();
    const configPath = join(homeDir, 'config.toml');
    await writeFile(configPath, COMPLETE_TOML, 'utf-8');
    const before = await readFile(configPath, 'utf-8');

    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    const setInvalidConfig = harness.setConfig({
      providers: {
        bad: {
          type: 'not-a-provider',
        },
      },
    } as never);

    await expect(setInvalidConfig).rejects.toBeInstanceOf(KimiError);
    await expect(setInvalidConfig).rejects.toMatchObject({
      code: 'config.invalid',
    } satisfies Partial<KimiError>);

    await expect(readFile(configPath, 'utf-8')).resolves.toBe(before);
  });

  it('uses default config when the config file is absent', async () => {
    const homeDir = await makeTempDir();
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(harness.getConfig()).resolves.toEqual({ providers: {} });
  });

  it('returns experimental feature metadata through the harness', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '0');
    const homeDir = await makeTempDir();
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    const features = await harness.getExperimentalFeatures();
    expect(features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
        id: 'tool-select',
        title: 'Tool select (progressive tool disclosure)',
        surface: 'core',
        env: 'KIMI_CODE_EXPERIMENTAL_TOOL_SELECT',
        defaultEnabled: false,
        enabled: false,
        source: 'default',
        }),
        expect.objectContaining({
        id: 'expert-teams',
        title: 'Expert teams',
        surface: 'both',
        env: 'KIMI_CODE_EXPERIMENTAL_EXPERT_TEAMS',
        defaultEnabled: true,
        enabled: true,
        source: 'default',
        }),
      ]),
    );
  });

  it('can create the default config scaffold without selecting a model', async () => {
    const homeDir = await makeTempDir();
    const configPath = join(homeDir, 'config.toml');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    await harness.ensureConfigFile();

    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('Runtime settings for Kimi Code.');
    expect(text).not.toMatch(/^default_thinking =/m);
    expect(text).not.toMatch(/^default_model =/m);

    const config = await harness.getConfig({ reload: true });
    expect(config.providers).toEqual({});
    expect(config.defaultModel).toBeUndefined();
    expect(config.thinking?.enabled).toBeUndefined();
  });

  it('reloads an active session without closing the SDK session wrapper', async () => {
    const homeDir = await makeTempDir();
    const workDir = join(homeDir, 'work');
    const configPath = join(homeDir, 'config.toml');
    await mkdir(workDir);
    await writeFile(configPath, COMPLETE_TOML, 'utf-8');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
    const session = await harness.createSession({
      id: 'session-sdk-reload',
      workDir,
      model: 'kimi-for-coding',
    });

    expect(session.getResumeState()).toBeUndefined();

    const reloaded = await harness.reloadSession({ id: session.id });

    expect(reloaded).toBe(session);
    expect(harness.getSession(session.id)).toBe(session);
    expect(session.getResumeState()?.agents['main']).toBeDefined();
    await expect(session.getStatus()).resolves.toMatchObject({ model: 'kimi-for-coding' });
  });

  it('forwards forcePluginSessionStartReminder to the active session reload', async () => {
    const homeDir = await makeTempDir();
    const workDir = join(homeDir, 'work');
    const configPath = join(homeDir, 'config.toml');
    await mkdir(workDir);
    await writeFile(configPath, COMPLETE_TOML, 'utf-8');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
    const session = await harness.createSession({
      id: 'session-sdk-reload-forward',
      workDir,
      model: 'kimi-for-coding',
    });

    try {
      const reloadSpy = vi.spyOn(session, 'reloadSession');

      await harness.reloadSession({ id: session.id, forcePluginSessionStartReminder: true });

      expect(reloadSpy).toHaveBeenCalledWith({ forcePluginSessionStartReminder: true });
      expect(session.getResumeState()?.agents['main']).toBeDefined();
    } finally {
      await harness.close();
    }
  });
});
