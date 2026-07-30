/**
 * Shared conformance suite — the guarantee that the ipc and memory
 * transports are interchangeable. Every transport test file runs the exact
 * same assertions against a real in-process engine; only the `before` setup
 * differs per file.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Klient } from '../../src/index.js';

export interface KlientConformanceTarget {
  readonly klient: Klient;
  readonly workDir: string;
  cleanup(): Promise<void>;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

export function defineKlientConformance(
  transport: string,
  makeTarget: () => Promise<KlientConformanceTarget>,
): void {
  describe(`klient conformance: ${transport}`, () => {
    let target: KlientConformanceTarget;

    beforeAll(async () => {
      target = await makeTarget();
    });

    afterAll(async () => {
      await target.cleanup();
    });

    it('env() aggregates the host snapshot', async () => {
      const env = await target.klient.global.env();
      expect(env.platform).toBe(process.platform);
      expect(env.homeDir.length).toBeGreaterThan(0);
      expect(env.clientVersion.length).toBeGreaterThan(0);
    });

    it('workspaces round-trip through create/get/update/list/delete', async () => {
      const workspaces = target.klient.global.workspaces;
      const created = await workspaces.createOrTouch({ root: process.cwd(), name: 'conformance' });
      expect(created.id.length).toBeGreaterThan(0);

      const fetched = await workspaces.get(created.id);
      expect(fetched?.name).toBe('conformance');

      const updated = await workspaces.update({ id: created.id, patch: { name: 'conformance-2' } });
      expect(updated?.name).toBe('conformance-2');

      const list = await workspaces.list();
      expect(list.some((w) => w.id === created.id)).toBe(true);

      await workspaces.delete(created.id);
      expect(await workspaces.get(created.id)).toBeUndefined();
    });

    it('workspace skill listing is session-less across transports', async () => {
      const sessionsBefore = await target.klient.global.sessions.list({});
      const skillName = `workspace-skill-${transport.replaceAll(/[^a-zA-Z0-9_-]/g, '-')}`;
      const skillDir = join(target.workDir, '.kimi-code', 'skills', skillName);
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---\nname: ${skillName}\ndescription: Workspace skill conformance fixture.\n---\n\nPrivate fixture content.\n`,
        'utf8',
      );

      const skills = await target.klient.global.skills.listWorkspace(target.workDir);
      const sessionsAfter = await target.klient.global.sessions.list({});

      expect(skills).toContainEqual(
        expect.objectContaining({
          name: skillName,
          description: 'Workspace skill conformance fixture.',
          source: 'project',
        }),
      );
      expect(skills.find((skill) => skill.name === skillName)).not.toHaveProperty(
        'content',
      );
      expect(sessionsAfter.items.map((session) => session.id)).toEqual(
        sessionsBefore.items.map((session) => session.id),
      );
    });

    it('sessions index responds with a page shape', async () => {
      const page = await target.klient.global.sessions.list({});
      expect(Array.isArray(page.items)).toBe(true);
      const count = await target.klient.global.sessions.countActive(['no-such-workspace']);
      expect(typeof count).toBe('number');
    });

    it('explicit session identity and initial metadata are identical across transports', async () => {
      const id = `session_explicit_${transport.replaceAll(/[^a-zA-Z0-9_-]/g, '_')}`;
      const meta = await target.klient.global.sessions.create({
        id,
        workDir: target.workDir,
        title: 'Explicit session',
        metadata: { owner: 'example' },
      });
      try {
        expect(meta).toMatchObject({
          id,
          title: 'Explicit session',
          isCustomTitle: true,
          custom: { owner: 'example' },
        });
      } finally {
        await target.klient.session(id).close();
      }
    });

    it('MCP catalog OAuth marker CRUD is identical across transports', async () => {
      const catalog = target.klient.global.mcp.catalog;
      const originalName = `mcp-catalog-${transport}`;
      const renamedName = `${originalName}-renamed`;
      const config = {
        transport: 'http' as const,
        url: 'https://mcp.example.test/rpc',
        auth: 'oauth' as const,
      };
      let activeName = originalName;

      try {
        await expect(
          catalog.add({ name: originalName, config }),
        ).resolves.toMatchObject({
          name: originalName,
          config,
          source: 'user',
        });
        await expect(catalog.get(originalName)).resolves.toMatchObject({
          name: originalName,
          config,
        });

        const updatedConfig = {
          ...config,
          toolTimeoutMs: 5_000,
        };
        await expect(
          catalog.update({ name: originalName, config: updatedConfig }),
        ).resolves.toMatchObject({
          name: originalName,
          config: updatedConfig,
        });
        await expect(
          catalog.rename({ oldName: originalName, newName: renamedName }),
        ).resolves.toMatchObject({
          name: renamedName,
          config: updatedConfig,
        });
        activeName = renamedName;
        expect((await catalog.list()).some((entry) => entry.name === renamedName)).toBe(
          true,
        );

        await catalog.remove(renamedName);
        activeName = '';
        await expect(catalog.get(renamedName)).resolves.toBeUndefined();
      } finally {
        if (activeName !== '' && (await catalog.get(activeName)) !== undefined) {
          await catalog.remove(activeName);
        }
      }
    });

    it('MCP OAuth cancellation is identical across transports', async () => {
      await expect(
        target.klient.global.mcp.oauth.cancel('missing-flow'),
      ).resolves.toBeUndefined();
    });

    it('MCP probe failures are identical across transports', async () => {
      await expect(
        target.klient.global.mcp.probe.run({
          serverName: 'missing-server',
          config: {
            transport: 'stdio',
            command: '/example/missing-mcp-command',
            startupTimeoutMs: 100,
          },
          cwd: target.workDir,
        }),
      ).resolves.toMatchObject({
        serverName: 'missing-server',
        success: false,
        toolCount: 0,
        error: expect.any(String),
      });
    });

    it('session snapshot deletion is identical across transports', async () => {
      const meta = await target.klient.global.sessions.create({
        workDir: target.workDir,
        title: `snapshot-delete-${transport}`,
      });
      const summary = await target.klient.global.sessions.get(meta.id);
      expect(summary).toBeDefined();

      await target.klient.global.sessionStore.delete({
        workspaceId: summary!.workspaceId,
        sessionId: meta.id,
      });

      await expect(target.klient.global.sessions.get(meta.id)).resolves.toBeUndefined();
    });

    it('exports a session archive identically across transports', async () => {
      const meta = await target.klient.global.sessions.create({
        workDir: target.workDir,
        title: `session-export-${transport}`,
      });
      const session = target.klient.session(meta.id);
      const outputPath = join(target.workDir, `session-export-${transport}.zip`);
      try {
        const result = await target.klient.global.sessionExport.export({
          sessionId: meta.id,
          outputPath,
          includeGlobalLog: false,
          includeDesktopLog: false,
          version: '1.2.3-example',
          installSource: 'conformance-example',
          shellEnv: {
            term: 'xterm-example',
            termProgram: 'terminal-example',
            termProgramVersion: '1.0.0',
            multiplexer: 'multiplexer-example',
            shell: '/bin/example-shell',
          },
        });

        expect(result).toMatchObject({
          zipPath: outputPath,
          sessionDir: expect.any(String),
          manifest: {
            sessionId: meta.id,
            kimiCodeVersion: '1.2.3-example',
            title: `session-export-${transport}`,
            workspaceDir: target.workDir,
            installSource: 'conformance-example',
            shellEnv: {
              term: 'xterm-example',
              termProgram: 'terminal-example',
              termProgramVersion: '1.0.0',
              multiplexer: 'multiplexer-example',
              shell: '/bin/example-shell',
            },
          },
        });
        expect(result.entries).toContain('manifest.json');
      } finally {
        await session.close();
      }
    });

    it('session expert-team read model resolves through the transport', async () => {
      const meta = await target.klient.global.sessions.create({
        workDir: target.workDir,
        title: `expert-team-${transport}`,
      });
      const session = target.klient.session(meta.id);
      try {
        expect(await session.expertTeam.get()).toBeNull();
        expect(Array.isArray(await session.expertTeam.list())).toBe(true);
      } finally {
        await session.close();
      }
    });

    it('extension control plane is identical across transports', async () => {
      const meta = await target.klient.global.sessions.create({
        workDir: target.workDir,
        title: `extensions-${transport}`,
      });
      const session = target.klient.session(meta.id);
      try {
        await expect(session.extensions.listCommands()).resolves.toEqual([]);
        await expect(session.extensions.reload()).resolves.toEqual({
          active: [],
          errors: [],
        });
        await expect(
          session.agent('main').extensions.activateCommand({
            extensionId: 'missing',
            name: 'missing',
          }),
        ).resolves.toBe(false);
        await expect(
          session.agent('main').plugins.refreshSessionStartReminder(),
        ).resolves.toBeUndefined();
      } finally {
        await session.close();
      }
    });

    it('session cron read model is identical across transports', async () => {
      const meta = await target.klient.global.sessions.create({
        workDir: target.workDir,
        title: `cron-${transport}`,
      });
      const session = target.klient.session(meta.id);
      try {
        await expect(session.cron.list()).resolves.toEqual([]);
        await expect(session.cron.getNextFireTime()).resolves.toBeNull();
        await expect(session.cron.getNextFireForTask('missing')).resolves.toBeNull();
      } finally {
        await session.close();
      }
    });

    it('session goal queue lifecycle is identical across transports', async () => {
      const meta = await target.klient.global.sessions.create({
        workDir: target.workDir,
        title: `goal-queue-${transport}`,
      });
      const session = target.klient.session(meta.id);
      const queue = session.goalQueue;
      try {
        await expect(queue.read()).resolves.toEqual({ goals: [] });

        const firstSnapshot = await queue.append({
          objective: 'Finish the first queued goal',
        });
        expect(firstSnapshot.goals).toHaveLength(1);
        const first = firstSnapshot.goals[0]!;
        expect(first.objective).toBe('Finish the first queued goal');
        expect(typeof first.createdAt).toBe('string');
        expect(typeof first.updatedAt).toBe('string');

        const secondSnapshot = await queue.append({
          objective: 'Finish the second queued goal',
        });
        const second = secondSnapshot.goals[1]!;
        const updatedSnapshot = await queue.update({
          goalId: second.id,
          objective: 'Finish the updated queued goal',
        });
        const updated = updatedSnapshot.goals[1]!;
        expect(updated.objective).toBe('Finish the updated queued goal');

        await expect(
          queue.move({ goalId: second.id, direction: 'up' }),
        ).resolves.toMatchObject({
          goals: [{ id: second.id }, { id: first.id }],
        });
        await expect(
          queue.move({ goalId: second.id, direction: 'down' }),
        ).resolves.toMatchObject({
          goals: [{ id: first.id }, { id: second.id }],
        });
        await expect(queue.remove({ goalId: second.id })).resolves.toMatchObject({
          goals: [{ id: first.id }],
        });
        await expect(queue.restore(updated)).resolves.toMatchObject({
          goals: [{ id: second.id }, { id: first.id }],
        });
      } finally {
        await session.close();
      }
    });

    it('session skill summaries are identical across transports', async () => {
      const meta = await target.klient.global.sessions.create({
        workDir: target.workDir,
        title: `skills-${transport}`,
      });
      const session = target.klient.session(meta.id);
      try {
        const skills = await session.skills.list();
        expect(skills.some((skill) => skill.name === 'mcp-config')).toBe(true);
      } finally {
        await session.close();
      }
    });

    it('session startup warnings are identical across transports', async () => {
      const meta = await target.klient.global.sessions.create({
        workDir: target.workDir,
        title: `warnings-${transport}`,
      });
      const session = target.klient.session(meta.id);
      try {
        await expect(session.warnings.list()).resolves.toEqual([]);
      } finally {
        await session.close();
      }
    });

    it('session todos are identical across transports', async () => {
      const meta = await target.klient.global.sessions.create({
        workDir: target.workDir,
        title: `todos-${transport}`,
      });
      const session = target.klient.session(meta.id);
      const todos = [
        { title: 'Connect the public facade', status: 'in_progress' as const },
        { title: 'Verify both transports', status: 'pending' as const },
      ];
      try {
        // Until lifecycle resume/create owns main-agent materialization, enter
        // the agent facade once so the session Todo service has its wire owner.
        await session.agent('main').replay.read();
        await expect(session.todos.list()).resolves.toEqual([]);
        await session.todos.replace(todos);
        await expect(session.todos.list()).resolves.toEqual(todos);
        await expect(session.agent('main').replay.read()).resolves.toMatchObject({
          todos,
        });
        await session.todos.clear();
        await expect(session.todos.list()).resolves.toEqual([]);
      } finally {
        await session.close();
      }
    });

    it('agent context commands are identical across transports', async () => {
      const meta = await target.klient.global.sessions.create({
        workDir: target.workDir,
        title: `context-command-${transport}`,
      });
      const session = target.klient.session(meta.id);
      const agent = session.agent('main');
      try {
        await agent.importContext({
          content: 'Imported <context>',
          source: 'conformance-example',
        });
        await expect(agent.getContext()).resolves.toMatchObject({
          history: [
            {
              role: 'user',
              content: [{ type: 'text', text: 'Imported &lt;context&gt;' }],
              origin: { kind: 'injection', variant: 'context_import' },
              note: 'conformance-example',
            },
          ],
        });

        await agent.clearContext();
        await expect(agent.getContext()).resolves.toMatchObject({ history: [] });
      } finally {
        await session.close();
      }
    });

    it('session init cancellation is Promise-shaped across transports', async () => {
      const meta = await target.klient.global.sessions.create({
        workDir: target.workDir,
        title: `init-cancel-${transport}`,
      });
      const session = target.klient.session(meta.id);
      try {
        await expect(session.init.cancel()).resolves.toBeUndefined();
      } finally {
        await session.close();
      }
    });

    it('BTW start returns an id addressable through the existing agent facade', async () => {
      const meta = await target.klient.global.sessions.create({
        workDir: target.workDir,
        title: `btw-${transport}`,
      });
      const session = target.klient.session(meta.id);
      try {
        await session.agent('main').profile.get();
        const sideAgentId = await session.btw.start();

        await expect(session.agent(sideAgentId).getPermission()).resolves.toBe('manual');
      } finally {
        await session.close();
      }
    });

    it('agent swarm starts inactive across transports', async () => {
      const meta = await target.klient.global.sessions.create({
        workDir: target.workDir,
        title: `swarm-inactive-${transport}`,
      });
      const session = target.klient.session(meta.id);
      try {
        await expect(session.agent('main').swarm.isActive()).resolves.toBe(false);
      } finally {
        await session.close();
      }
    });

    it('agent swarm becomes active after manual entry across transports', async () => {
      const meta = await target.klient.global.sessions.create({
        workDir: target.workDir,
        title: `swarm-enter-${transport}`,
      });
      const session = target.klient.session(meta.id);
      const swarm = session.agent('main').swarm;
      try {
        await swarm.enter('manual');
        await expect(swarm.isActive()).resolves.toBe(true);
      } finally {
        await session.close();
      }
    });

    it('agent swarm becomes inactive after exit across transports', async () => {
      const meta = await target.klient.global.sessions.create({
        workDir: target.workDir,
        title: `swarm-exit-${transport}`,
      });
      const session = target.klient.session(meta.id);
      const swarm = session.agent('main').swarm;
      try {
        await swarm.enter('manual');
        await swarm.exit();
        await expect(swarm.isActive()).resolves.toBe(false);
      } finally {
        await session.close();
      }
    });

    it('session workspace adds a non-persisted directory through the public facade', async () => {
      const meta = await target.klient.global.sessions.create({
        workDir: target.workDir,
        title: `workspace-${transport}`,
      });
      const session = target.klient.session(meta.id);
      try {
        await expect(session.workspace.get()).resolves.toEqual({
          workDir: target.workDir,
          additionalDirs: [],
        });
        const additionalDir = await mkdtemp(join(target.workDir, 'workspace-additional-'));
        try {
          await expect(
            session.workspace.addAdditionalDir({ path: additionalDir, persist: false }),
          ).resolves.toMatchObject({
            additionalDirs: [additionalDir],
            persisted: false,
          });
          await expect(session.workspace.get()).resolves.toEqual({
            workDir: target.workDir,
            additionalDirs: [additionalDir],
          });
        } finally {
          await rm(additionalDir, { recursive: true, force: true });
        }
      } finally {
        await session.close();
      }
    });

    it('permission mode round-trips from manual to yolo through the public facade', async () => {
      const meta = await target.klient.global.sessions.create({
        workDir: target.workDir,
        title: `permission-${transport}`,
      });
      const session = target.klient.session(meta.id);
      const agent = session.agent('main');
      try {
        await expect(agent.getPermission()).resolves.toBe('manual');
        await agent.setPermission('yolo');
        await expect(agent.getPermission()).resolves.toBe('yolo');
      } finally {
        await session.close();
      }
    });

    it('agent replay snapshots are identical across transports', async () => {
      const meta = await target.klient.global.sessions.create({
        workDir: target.workDir,
        title: `replay-${transport}`,
      });
      const session = target.klient.session(meta.id);
      try {
        const snapshot = await session.agent('main').replay.read();

        expect(snapshot).toMatchObject({
          type: 'main',
          config: {
            cwd: expect.any(String),
          },
          context: {
            history: [],
            tokenCount: 0,
          },
          permission: {
            mode: 'manual',
            rules: [],
          },
          plan: null,
          swarmMode: false,
          usage: {},
          tasks: [],
        });
        expect(Array.isArray(snapshot.replay)).toBe(true);
        expect(Array.isArray(snapshot.tools)).toBe(true);
      } finally {
        await session.close();
      }
    });

    it('agent goal lifecycle is identical across transports', async () => {
      const meta = await target.klient.global.sessions.create({
        workDir: target.workDir,
        title: `goal-${transport}`,
      });
      const session = target.klient.session(meta.id);
      const goal = session.agent('main').goal;
      try {
        await expect(goal.get()).resolves.toBeNull();
        const created = await goal.create({ objective: 'exercise the goal control plane' });
        expect(created.status).toBe('active');
        await expect(goal.pause({ reason: 'test' })).resolves.toMatchObject({
          goalId: created.goalId,
          status: 'paused',
        });
        await expect(goal.resume()).resolves.toMatchObject({
          goalId: created.goalId,
          status: 'active',
        });
        await expect(goal.cancel()).resolves.toMatchObject({ goalId: created.goalId });
        await expect(goal.get()).resolves.toBeNull();
      } finally {
        await session.close();
      }
    });

    it('agent profile first binding is identical across transports', async () => {
      const modelId = `__profile_conformance_${transport}__`;
      await target.klient.global.kosong.addProvider({
        id: modelId,
        model: 'stub-model',
        protocol: 'openai',
        baseUrl: 'http://127.0.0.1:1',
        auth: { method: 'api-key', apiKey: 'conf-key' },
        maxContextSize: 32_000,
        capabilities: { tool_use: true },
      });
      const meta = await target.klient.global.sessions.create({
        workDir: target.workDir,
        title: `profile-${transport}`,
        mainAgentBinding: {
          profile: 'agent',
          model: modelId,
          thinking: 'off',
          cwd: target.workDir,
        },
      });
      const session = target.klient.session(meta.id);
      const profile = session.agent('main').profile;
      try {
        await expect(profile.get()).resolves.toMatchObject({
          cwd: target.workDir,
          modelAlias: modelId,
          profileName: 'agent',
          thinkingLevel: 'off',
        });
      } finally {
        await session.close();
        await target.klient.global.kosong.removeProvider(modelId);
      }
    });

    it('providers.set/get/delete works and emits kosong.providers.changed', async () => {
      const events: Array<{
        added: readonly string[];
        removed: readonly string[];
        changed: readonly string[];
      }> = [];
      const errors: Error[] = [];
      target.klient.events.onError((error) => {
        errors.push(error);
      });
      const sub = target.klient.events.on('kosong.providers.changed', (event) => {
        events.push(event);
      });
      // Give the subscription a wire round-trip (memory is synchronous; ipc
      // and http's lazy WS need a frame exchange).
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });

      const name = '__klient_conformance__';
      try {
        await target.klient.global.kosong.addProvider(name, {
          type: 'openai',
          auth: { method: 'api-key', apiKey: 'conf-key' },
        });
        const got = await target.klient.global.kosong.getProvider(name);
        expect(got.has_api_key).toBe(true);

        await waitFor(
          () => events.some((event) => [...event.added, ...event.changed].includes(name)),
          5_000,
        );
      } finally {
        await target.klient.global.kosong.removeProvider(name);
        sub.dispose();
      }
      expect(errors).toEqual([]);
    });

    it('config reads respond', async () => {
      const all = await target.klient.global.config.getAll();
      expect(typeof all).toBe('object');
      expect(Array.isArray(await target.klient.global.config.diagnostics())).toBe(true);
    });

    it('hostFs.home() returns the host home and recent roots', async () => {
      const home = await target.klient.global.hostFs.home();
      expect(home.home.length).toBeGreaterThan(0);
      expect(Array.isArray(home.recent_roots)).toBe(true);

      const browse = await target.klient.global.hostFs.browse(home.home);
      expect(browse.path).toBe(home.home);
      expect(Array.isArray(browse.entries)).toBe(true);
    });

    it('kosong lists models/providers and anonymous provider round-trips', async () => {
      const kosong = target.klient.global.kosong;
      expect(Array.isArray(await kosong.listModels())).toBe(true);
      expect(Array.isArray(await kosong.listProviders())).toBe(true);

      const events: Array<{
        added: readonly string[];
        removed: readonly string[];
        changed: readonly string[];
      }> = [];
      const sub = target.klient.events.on('kosong.models.changed', (event) => {
        events.push(event);
      });
      // See kosong.providers.changed above — give the subscription a wire round-trip.
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });

      const id = '__klient_conformance__';
      try {
        await kosong.addProvider({
          id,
          model: 'conf-model',
          protocol: 'openai',
          baseUrl: 'http://127.0.0.1:1',
          auth: { method: 'api-key', apiKey: 'conf-key' },
        });

        await waitFor(
          () => events.some((event) => [...event.added, ...event.changed].includes(id)),
          5_000,
        );
      } finally {
        await kosong.removeProvider(id);
        sub.dispose();
      }
    });

    it('returns a managed usage error when the provider has no credentials across transports', async () => {
      await expect(
        target.klient.global.auth.getManagedUsage('provider-example'),
      ).resolves.toMatchObject({
        kind: 'error',
        message: expect.any(String),
      });
    });

    it('returns a feedback submission error unchanged across transports', async () => {
      await expect(
        target.klient.global.auth.submitFeedback(
          {
            session_id: 'session-example',
            content: 'Example feedback.',
            version: '1.2.3-example',
            os: 'example-os',
            model: null,
          },
          'provider-example',
        ),
      ).resolves.toMatchObject({
        kind: 'error',
        message: expect.any(String),
      });
    });

    it('returns a feedback upload creation error unchanged across transports', async () => {
      await expect(
        target.klient.global.auth.createFeedbackUploadUrl(
          {
            file_hash: 'sha256-example',
            file_name: 'feedback.zip',
            file_size: 1_024,
            feedback_id: 42,
          },
          'provider-example',
        ),
      ).resolves.toMatchObject({
        kind: 'error',
        message: expect.any(String),
      });
    });

    it('returns a feedback upload completion error unchanged across transports', async () => {
      await expect(
        target.klient.global.auth.completeFeedbackUpload(
          {
            upload_id: 7,
            parts: [{ part_number: 1, etag: 'etag-example' }],
          },
          'provider-example',
        ),
      ).resolves.toMatchObject({
        kind: 'error',
        message: expect.any(String),
      });
    });

    it('flags / plugins / auth read models respond', async () => {
      expect(Array.isArray(await target.klient.global.flags.list())).toBe(true);
      expect(Array.isArray(await target.klient.global.flags.enabledIds())).toBe(true);
      expect(typeof await target.klient.global.flags.snapshot()).toBe('object');
      expect(Array.isArray(await target.klient.global.plugins.list())).toBe(true);
      const status = await target.klient.global.auth.status();
      expect(typeof status.loggedIn).toBe('boolean');
    });
  });
}
