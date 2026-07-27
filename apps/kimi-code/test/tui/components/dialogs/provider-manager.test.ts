/**
 * Scenario: Provider configuration sources are rendered and deleted through the pure-view dialog.
 * Responsibility: Preserve source grouping, active markers, base URLs, and callback-only actions.
 * Wiring: Runtime-neutral provider fixtures drive the real component; only host callbacks are mocked.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/components/dialogs/provider-manager.test.ts
 */

import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  ProviderManagerComponent,
  type ProviderManagerOptions,
} from '#/tui/components/dialogs/provider-manager';
import type { RuntimeProviderConfigView } from '#/tui/runtime/runtime-model-config-port';
import { darkColors } from '#/tui/theme/colors';

// Truecolor SGR fragments for the darkColors tokens we assert on
// (see theme/colors.ts). Forcing chalk.level below guarantees they appear.
const PRIMARY = '38;2;79;168;255'; // colors.primary  #4FA8FF
const MUTED = '38;2;107;107;107'; // colors.textMuted #6B6B6B
const BOLD = '[1m';
const ESC = String.fromCodePoint(27);

const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

function rendered(component: ProviderManagerComponent, width = 120): string {
  return component.render(width).join('\n').replaceAll(SGR, '');
}

function makeComponent(overrides: Partial<ProviderManagerOptions> = {}): ProviderManagerComponent {
  return new ProviderManagerComponent({
    providers: {},
    onAdd: vi.fn(),
    onDeleteSource: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  });
}

function addRowLine(component: ProviderManagerComponent, width = 120): string | undefined {
  return component.render(width).find((line) => line.includes('Add New Platform'));
}

describe('ProviderManagerComponent', () => {
  let previousLevel: typeof chalk.level;
  beforeAll(() => {
    previousLevel = chalk.level;
    chalk.level = 3;
  });
  afterAll(() => {
    chalk.level = previousLevel;
  });

  it('renders [ Add New Platform ] in the brand color, never muted, when not selected', () => {
    // A configured provider occupies row 0 (selected); the add row sits below
    // it and is therefore not the highlighted row.
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
      },
      activeProviderId: 'acme',
    });
    const line = addRowLine(component);
    expect(line).toBeDefined();
    expect(line).toContain(PRIMARY);
    expect(line).not.toContain(MUTED);
  });

  it('bolds [ Add New Platform ] when it is the selected row', () => {
    // With no configured providers the synthetic add row is the only row, so it
    // starts as the highlighted selection.
    const component = makeComponent();
    const line = addRowLine(component);
    expect(line).toBeDefined();
    expect(line).toContain(BOLD);
    expect(line).toContain(PRIMARY);
  });

  it('marks the active provider with the shared "← current" marker, not a bullet', () => {
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
      },
      activeProviderId: 'acme',
    });
    const plain = component
      .render(120)
      .join('\n')
      .replaceAll(/\[[0-9;]*m/g, '');
    expect(plain).toContain('← current');
    expect(plain).not.toContain('●');
  });

  it('uses the Open Platform label when the provider id is registered', () => {
    const component = makeComponent({
      providers: {
        'moonshot-cn': { baseUrl: 'https://api.example.test/v1' },
      },
    });

    expect(rendered(component)).toContain('Kimi Platform (API key · platform.kimi.com)');
  });

  it('shows a standalone provider base URL beneath its source row', () => {
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://api.example.test/v1' },
      },
    });

    expect(rendered(component)).toContain('https://api.example.test/v1');
  });

  it('deletes providers sharing an apiJson source as one group', () => {
    const onDeleteSource = vi.fn();
    const providers: Readonly<Record<string, RuntimeProviderConfigView>> = {
      'acme-chat': {
        baseUrl: 'https://gateway.example.test/v1',
        source: {
          kind: 'apiJson',
          url: 'https://catalog.example.test/api.json',
          apiKey: 'YOUR_API_KEY',
        },
      },
      'acme-reasoning': {
        baseUrl: 'https://gateway.example.test/v1',
        source: {
          kind: 'apiJson',
          url: 'https://catalog.example.test/api.json',
          apiKey: 'YOUR_API_KEY',
        },
      },
    };
    const component = makeComponent({ providers, onDeleteSource });

    component.handleInput('D');
    component.handleInput('y');

    expect(onDeleteSource).toHaveBeenCalledWith(['acme-chat', 'acme-reasoning']);
  });

  it('uses the same header shape as the model dialog (one top border, title, hint, no inner border)', () => {
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
      },
      activeProviderId: 'acme',
    });
    const lines = component.render(120).map((l) => l.replaceAll(SGR, ''));
    const isBorder = (l: string | undefined): boolean => /^─+$/.test((l ?? '').trim());

    const titleIdx = lines.findIndex((l) => l.includes('Providers'));
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    // The line directly under the title is the hint, never an inner border (the
    // old `border · title · border` sandwich is gone).
    expect(isBorder(lines[titleIdx + 1])).toBe(false);
    expect(lines[titleIdx + 1]).toContain('navigate');
    expect(lines[titleIdx + 1]).toContain('Esc cancel');
    // Blank line separates the hint from the body, exactly like the model dialog.
    expect(lines[titleIdx + 2]).toBe('');
    // Only the top and bottom full-width borders remain — two, not three.
    expect(lines.filter(isBorder).length).toBe(2);
  });

  it('deletes the highlighted provider via the D key with a y/N confirm', () => {
    const onDeleteSource = vi.fn();
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
      },
      activeProviderId: 'acme',
      onDeleteSource,
    });
    component.handleInput('D');
    expect(rendered(component)).toContain('[y/N]');
    component.handleInput('y');
    expect(onDeleteSource).toHaveBeenCalledWith(['acme']);
  });

  it('closes on Esc', () => {
    const onClose = vi.fn();
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
      },
      onClose,
    });
    component.handleInput(ESC);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
