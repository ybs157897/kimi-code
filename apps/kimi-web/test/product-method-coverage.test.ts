// Static coverage: every `this.call('<method>', …)` in WailsKimiWebApi must
// have a matching `case '<method>':` in ProductFacade.dispatch(). This catches
// the Slice-1 class of bug where the web client + mock work but the real
// desktop sidecar throws `unknown product method`.
//
// Lives under test/ (not src/) so vue-tsc does not require @types/node.
// Reads source as text — kimi-web must not import agent-core-v2 / the sidecar.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DESKTOP_SUPPORTED_METHODS } from '../src/api/desktop/client';

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = resolve(here, '../src/api/desktop/client.ts');
const FACADE_PATH = resolve(here, '../../kimi-desktop/sidecar/product/facade.ts');

/** Slice 1 methods that previously existed only on the client/mock. */
const SLICE_1_METHODS = [
  'listExpertTeams',
  'getExpertTeam',
  'activateExpertTeam',
  'deactivateExpertTeam',
  'getSession',
  'listMessages',
  'dismissQuestion',
  'getTask',
  'cancelTask',
] as const;

/** Slice 4 methods — workspace + structured filesystem (P1). */
const SLICE_4_METHODS = [
  'addWorkspace',
  'updateWorkspace',
  'browseFs',
  'listDirectory',
  'readFile',
  'searchFiles',
  'grepFiles',
  'getFileDiff',
  'openFile',
  'revealFile',
  'openInApp',
] as const;

/** Slice 5 — chunked upload methods (ProductCall → facade dispatch). */
const SLICE_5_UPLOAD_METHODS = ['uploadStart', 'uploadChunk', 'uploadFinish', 'uploadCancel'] as const;

/**
 * Slice 6 — session terminal methods (ProductCall → facade dispatch). CRUD +
 * input/resize/close all route through `this.call`; attach/detach ride the
 * bridge's `ProductTerminalAttach`/`Detach` binds instead, so they are NOT in
 * this list.
 */
const SLICE_6_TERMINAL_METHODS = [
  'listTerminals',
  'createTerminal',
  'getTerminal',
  'closeTerminal',
  'terminalInput',
  'terminalResize',
  'terminalClose',
] as const;

/**
 * Slice 5 — download stream methods. These never hit `ProductFacade.dispatch`:
 * `ProductStreamStart` routes them to the sidecar host's `stream` interception,
 * which switches on them in `ProductFacade.streamDispatch`.
 */
const SLICE_5_STREAM_METHODS = ['getFileBlob', 'getWorkspaceFileBlob'] as const;

/** Slice 7 — skills + code extensions (ProductCall → facade dispatch). */
const SLICE_7_METHODS = [
  'listSkillsForWorkspace',
  'activateSkill',
  'listExtensionCommands',
  'reloadExtensions',
  'activateExtensionCommand',
] as const;

/** Slice 7 — session export (a product binary stream, like the Slice 5 downloads). */
const SLICE_7_STREAM_METHODS = ['exportSession'] as const;

/** Class-only methods absent from the KimiWebApi interface (kept as dead code). */
const ORPHAN_CLIENT_METHODS = ['deleteSession', 'setDefaultModel'] as const;

function extractClientCallMethods(source: string): string[] {
  const methods = new Set<string>();
  // Match both `this.call('m', …)` and multiline `this.call<…>(\n  'm', …)`.
  const re = /this\.call(?:<[\s\S]*?>)?\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g;
  for (const match of source.matchAll(re)) {
    const name = match[1];
    if (name !== undefined) methods.add(name);
  }
  return [...methods].sort();
}

function extractClientStreamMethods(source: string): string[] {
  const methods = new Set<string>();
  // Match `streamToBlob('m', …)` and `streamToBlobWithMeta('m', …)` — the
  // bridge calls the client assembles `kimi:stream` base64 frames through
  // (Slice 5 downloads, Slice 7 exportSession).
  const re = /streamToBlob(?:WithMeta)?\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g;
  for (const match of source.matchAll(re)) {
    const name = match[1];
    if (name !== undefined) methods.add(name);
  }
  return [...methods].sort();
}

/**
 * Extract the public method names declared on `WailsKimiWebApi` (2-space
 * indented `async name(` / `name(` without a `private` modifier). Used to
 * prove `DESKTOP_SUPPORTED_METHODS` covers the real class surface — the Proxy
 * that used to fill missing members is gone, so every member must be a method.
 */
function extractPublicClientMethods(source: string): string[] {
  const methods = new Set<string>();
  const re = /^  (?!private )(?:async )?([A-Za-z_][A-Za-z0-9_]*)\(/gm;
  for (const match of source.matchAll(re)) {
    const name = match[1];
    if (name !== undefined && name !== 'constructor') methods.add(name);
  }
  return [...methods].sort();
}

function extractFacadeStreamCases(source: string): string[] {
  const dispatchStart = source.indexOf('streamDispatch(');
  expect(dispatchStart).toBeGreaterThanOrEqual(0);
  const after = source.slice(dispatchStart);
  const defaultIdx = after.indexOf('default:');
  expect(defaultIdx).toBeGreaterThan(0);
  const switchBody = after.slice(0, defaultIdx);
  const methods = new Set<string>();
  const re = /case\s+['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*:/g;
  for (const match of switchBody.matchAll(re)) {
    const name = match[1];
    if (name !== undefined) methods.add(name);
  }
  return [...methods].sort();
}

function extractFacadeDispatchCases(source: string): string[] {
  const dispatchStart = source.indexOf('async dispatch(method: string');
  expect(dispatchStart).toBeGreaterThanOrEqual(0);
  const after = source.slice(dispatchStart);
  const defaultIdx = after.indexOf("default:\n        throw new RPCError");
  expect(defaultIdx).toBeGreaterThan(0);
  const switchBody = after.slice(0, defaultIdx);
  const methods = new Set<string>();
  const re = /case\s+['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*:/g;
  for (const match of switchBody.matchAll(re)) {
    const name = match[1];
    if (name !== undefined) methods.add(name);
  }
  return [...methods].sort();
}

describe('desktop product method coverage (client ↔ ProductFacade)', () => {
  const clientSource = readFileSync(CLIENT_PATH, 'utf8');
  const facadeSource = readFileSync(FACADE_PATH, 'utf8');
  const clientMethods = extractClientCallMethods(clientSource);
  const facadeMethods = extractFacadeDispatchCases(facadeSource);
  const clientStreamMethods = extractClientStreamMethods(clientSource);
  const facadeStreamMethods = extractFacadeStreamCases(facadeSource);

  it('extracts ProductCall method names from the desktop client', () => {
    expect(clientMethods.length).toBeGreaterThan(20);
    expect(clientMethods).toEqual(expect.arrayContaining([...SLICE_1_METHODS]));
  });

  it('registers every client ProductCall method on ProductFacade.dispatch', () => {
    const missing = clientMethods.filter((m) => !facadeMethods.includes(m));
    expect(missing).toEqual([]);
  });

  it('registers all Slice 1 methods on ProductFacade.dispatch', () => {
    for (const method of SLICE_1_METHODS) {
      expect(facadeMethods).toContain(method);
    }
  });

  it('registers all Slice 4 methods on ProductFacade.dispatch', () => {
    for (const method of SLICE_4_METHODS) {
      expect(facadeMethods).toContain(method);
    }
  });

  it('extracts the Slice 5 upload + stream methods from the desktop client', () => {
    expect(clientMethods).toEqual(expect.arrayContaining([...SLICE_5_UPLOAD_METHODS]));
    expect(clientStreamMethods).toEqual([
      'exportSession',
      'getFileBlob',
      'getWorkspaceFileBlob',
    ]);
  });

  it('registers all Slice 5 upload methods on ProductFacade.dispatch', () => {
    for (const method of SLICE_5_UPLOAD_METHODS) {
      expect(facadeMethods).toContain(method);
    }
  });

  it('extracts the Slice 6 terminal methods from the desktop client', () => {
    expect(clientMethods).toEqual(expect.arrayContaining([...SLICE_6_TERMINAL_METHODS]));
  });

  it('registers all Slice 6 terminal methods on ProductFacade.dispatch', () => {
    for (const method of SLICE_6_TERMINAL_METHODS) {
      expect(facadeMethods).toContain(method);
    }
  });

  it('extracts the Slice 7 skills/extension/export methods from the desktop client', () => {
    expect(clientMethods).toEqual(expect.arrayContaining([...SLICE_7_METHODS]));
    expect(clientStreamMethods).toEqual(expect.arrayContaining([...SLICE_7_STREAM_METHODS]));
  });

  it('registers all Slice 7 methods on ProductFacade.dispatch', () => {
    for (const method of SLICE_7_METHODS) {
      expect(facadeMethods).toContain(method);
    }
  });

  it('registers exportSession on ProductFacade.streamDispatch', () => {
    for (const method of SLICE_7_STREAM_METHODS) {
      expect(facadeStreamMethods).toContain(method);
    }
  });

  it('DESKTOP_SUPPORTED_METHODS covers every public class method (no Proxy)', () => {
    const publicMethods = extractPublicClientMethods(clientSource);
    const supported = [...DESKTOP_SUPPORTED_METHODS].sort();
    // Every listed member is a real method on the class.
    for (const method of supported) {
      expect(publicMethods).toContain(method);
    }
    // The only public methods outside the list are the class-only leftovers.
    const unsupported = publicMethods.filter((method) => !supported.includes(method));
    expect(unsupported).toEqual([...ORPHAN_CLIENT_METHODS].sort());
  });

  it('registers every client product stream method on ProductFacade.streamDispatch', () => {
    const missing = clientStreamMethods.filter((m) => !facadeStreamMethods.includes(m));
    expect(missing).toEqual([]);
  });

  it('keeps the facade case list at least as large as the client call set', () => {
    expect(facadeMethods.length).toBeGreaterThanOrEqual(clientMethods.length);
  });
});
