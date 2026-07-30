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

  it('keeps the facade case list at least as large as the client call set', () => {
    expect(facadeMethods.length).toBeGreaterThanOrEqual(clientMethods.length);
  });
});
