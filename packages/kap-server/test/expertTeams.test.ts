/**
 * Stable `/api/v1` expert-team routes.
 *
 * Installs a WorkBuddy-compatible expert plugin, activates it for a real
 * DI-scoped Session, verifies the lead profile binding, and deactivates back
 * to the previous profile.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAgentLifecycleService,
  IAgentProfileService,
  IAgentToolRegistryService,
  IAgentToolPolicyService,
  IPluginService,
  ISessionExpertTeamService,
  ISessionLifecycleService,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  readonly code: number;
  readonly msg: string;
  readonly data: T;
  readonly request_id: string;
}

const CONFIG = [
  'default_model = "stub"',
  '',
  '[providers.stub]',
  'type = "openai"',
  'base_url = "http://127.0.0.1:9999"',
  'api_key = "stub"',
  '',
  '[models.stub]',
  'provider = "stub"',
  'model = "stub"',
  'max_context_size = 1000',
  '',
].join('\n');

describe('/api/v1 expert teams', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_EXPERT_TEAMS', '1');
    home = await mkdtemp(join(tmpdir(), 'kap-server-expert-teams-'));
    await writeFile(join(home, 'config.toml'), CONFIG, 'utf8');
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 25,
      } as never);
      home = undefined;
    }
  });

  it('discovers, activates, snapshots, and deactivates an expert team', async () => {
    const pluginRoot = await seedExpertPlugin();
    await server!.core.accessor.get(IPluginService).installPlugin({ source: pluginRoot });
    const sessionId = await createSession();
    const session = server!.core.accessor.get(ISessionLifecycleService).get(sessionId);
    if (session === undefined) throw new Error(`session ${sessionId} not found`);
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    expect(lifecycle.get('main')).toBeUndefined();

    const available = await getJson<{
      experts: Array<{
        plugin_id: string;
        profession?: string;
        tags: string[];
        lead_agent_name: string;
        member_agent_names: string[];
        members: Array<{
          agent: string;
          name?: string | Record<string, string>;
          profession?: string | Record<string, string>;
        }>;
        default_init_prompt?: string;
      }>;
    }>(`/api/v1/sessions/${sessionId}/expert-teams`);
    expect(available.body.code).toBe(0);
    expect(available.body.data.experts).toEqual([
      expect.objectContaining({
        plugin_id: 'delivery-experts',
        profession: 'Software delivery',
        tags: ['delivery', 'architecture', 'planning'],
        lead_agent_name: 'delivery-lead',
        member_agent_names: ['architect'],
        members: [
          expect.objectContaining({
            agent: 'delivery-lead',
            name: { en: 'Lead', zh: '主理人' },
            profession: { en: 'Delivery lead', zh: '交付负责人' },
          }),
          expect.objectContaining({
            agent: 'architect',
            name: { en: 'Architect', zh: '架构师' },
            profession: { en: 'Software architect', zh: '软件架构师' },
          }),
        ],
        default_init_prompt: 'Plan delivery',
      }),
    ]);

    const initial = await getJson<{ expert_team: null }>(
      `/api/v1/sessions/${sessionId}/expert-team`,
    );
    expect(initial.body.data.expert_team).toBeNull();

    const activated = await postJson<{
      expert_team: {
        binding: {
          plugin_id: string;
          lead_profile_name: string;
          previous_profile_name: string;
        };
      };
    }>(`/api/v1/sessions/${sessionId}/expert-team/activate`, {
      plugin_id: 'delivery-experts',
    });
    expect(activated.body.code, JSON.stringify(activated.body)).toBe(0);
    expect(activated.body.data.expert_team.binding).toMatchObject({
      plugin_id: 'delivery-experts',
      lead_profile_name: 'expert:delivery-experts:delivery-lead',
      previous_profile_name: 'agent',
    });
    const main = lifecycle.get('main');
    if (main === undefined) throw new Error('expert-team activation did not create main');
    expect(main.accessor.get(IAgentProfileService).data().profileName).toBe(
      'expert:delivery-experts:delivery-lead',
    );
    expect(main.accessor.get(IAgentProfileService).data().systemPrompt).toContain(
      'Whenever the package SOP says to use Agent, call TeamSpawn instead',
    );
    const toolPolicy = main.accessor.get(IAgentToolPolicyService);
    expect(main.accessor.get(IAgentToolRegistryService).resolve('TeamCreate')).toBeDefined();
    expect(toolPolicy.isToolActive('TeamCreate')).toBe(true);
    expect(toolPolicy.isToolActive('Agent')).toBe(false);
    expect(toolPolicy.isToolActive('AgentSwarm')).toBe(false);
    const expertTeam = session.accessor.get(ISessionExpertTeamService);
    const team = expertTeam.createTeam('main', {
      name: 'delivery',
      description: 'Delivery planning team',
    });
    expect(team.id).toBe('delivery');
    const member = expertTeam.reserveMember('main', 'architect');
    expect(member).toMatchObject({
      agentId: 'architect@delivery',
      profileName: 'expert:delivery-experts:architect',
    });
    expertTeam.markMemberFinished(member.agentId, 'completed');

    const running = await getJson<{
      expert_team: {
        team: {
          id: string;
          members: Array<{ agent_id: string; status: string }>;
        };
      };
    }>(`/api/v1/sessions/${sessionId}/expert-team`);
    expect(running.body.data.expert_team.team).toEqual({
      id: 'delivery',
      name: 'delivery',
      description: 'Delivery planning team',
      created_at: expect.any(String),
      members: [
        expect.objectContaining({
          agent_id: 'architect@delivery',
          status: 'completed',
        }),
      ],
    });

    const deactivated = await postJson<{ deactivated: true }>(
      `/api/v1/sessions/${sessionId}/expert-team/deactivate`,
    );
    expect(deactivated.body, JSON.stringify(deactivated.body)).toMatchObject({
      code: 0,
      data: { deactivated: true },
    });
    expect(main.accessor.get(IAgentProfileService).data().profileName).toBe('agent');

    const retiredV2Route = await fetch(
      `${base}/api/v2/sessions/${sessionId}/expert-teams`,
      { headers: authHeaders(server as RunningServer) } as never,
    );
    expect(retiredV2Route.status).toBe(404);
  });

  async function createSession(): Promise<string> {
    const result = await postJson<{ id: string }>('/api/v1/sessions', {
      metadata: { cwd: home },
    });
    expect(result.body.code).toBe(0);
    return result.body.data.id;
  }

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const response = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: response.status, body: (await response.json()) as Envelope<T> };
  }

  async function postJson<T>(
    path: string,
    body: unknown = {},
  ): Promise<{ status: number; body: Envelope<T> }> {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, {
        'content-type': 'application/json',
      }),
      body: JSON.stringify(body),
    } as never);
    return { status: response.status, body: (await response.json()) as Envelope<T> };
  }

  async function seedExpertPlugin(): Promise<string> {
    const root = join(home as string, 'delivery-experts-source');
    await mkdir(join(root, '.codebuddy-plugin'), { recursive: true });
    await mkdir(join(root, 'agents'), { recursive: true });
    await writeFile(
      join(root, 'agents', 'delivery-lead.md'),
      [
        '---',
        'name: delivery-lead',
        'description: Delivery expert-team lead',
        '---',
        '',
        'Coordinate the delivery specialists and synthesize their findings.',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(root, 'agents', 'architect.md'),
      [
        '---',
        'name: architect',
        'description: Software architecture specialist',
        '---',
        '',
        'Analyze architecture and send complete findings to the team lead.',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(root, '.codebuddy-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'delivery-experts',
        version: '1.0.0',
        displayName: 'Delivery Experts',
        displayDescription: 'A delivery lead with an architecture specialist.',
        profession: 'Software delivery',
        tags: ['delivery', 'architecture', 'planning'],
        expertType: 'team',
        agentName: 'delivery-lead',
        teamInfo: {
          leadAgent: 'delivery-lead',
          memberAgents: ['architect'],
        },
        members: [
          {
            id: 'delivery-lead',
            role: 'lead',
            name: { en: 'Lead', zh: '主理人' },
            profession: { en: 'Delivery lead', zh: '交付负责人' },
          },
          {
            id: 'architect',
            role: 'member',
            name: { en: 'Architect', zh: '架构师' },
            profession: { en: 'Software architect', zh: '软件架构师' },
          },
        ],
        quickPrompts: ['Plan delivery'],
        defaultInitPrompt: 'Plan delivery',
      }),
      'utf8',
    );
    return root;
  }
});
