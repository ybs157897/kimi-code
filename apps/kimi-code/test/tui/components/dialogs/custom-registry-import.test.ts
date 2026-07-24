import { visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import {
  CustomRegistryImportDialogComponent,
  type CustomRegistryImportResult,
} from '#/tui/components/dialogs/custom-registry-import';
import {
  CustomEndpointImportDialogComponent,
  type CustomEndpointImportResult,
} from '#/tui/components/dialogs/custom-endpoint-import';
import { darkColors } from '#/tui/theme/colors';

const ANSI = /\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');
const ESC = String.fromCodePoint(27);
const DOWN = `${ESC}[B`;
const UP = `${ESC}[A`;

function plain(component: CustomRegistryImportDialogComponent, width = 80): string {
  return component.render(width).map(strip).join('\n');
}

function makeDialog(defaultUrl = 'https://example.com/api.json'): {
  dialog: CustomRegistryImportDialogComponent;
  onDone: ReturnType<typeof vi.fn>;
} {
  const onDone = vi.fn();
  const dialog = new CustomRegistryImportDialogComponent(
    onDone as unknown as (r: CustomRegistryImportResult) => void,
    defaultUrl,
  );
  dialog.focused = true;
  return { dialog, onDone };
}

describe('CustomRegistryImportDialogComponent', () => {
  it('advances from the URL field to the token field on Enter instead of submitting', () => {
    const { dialog, onDone } = makeDialog();
    expect(plain(dialog)).toContain('next field');

    dialog.handleInput('\r');

    expect(onDone).not.toHaveBeenCalled();
    expect(plain(dialog)).toContain('Enter to submit');
  });

  it('switches fields with Up / Down arrows', () => {
    const { dialog } = makeDialog();
    dialog.handleInput(DOWN);
    expect(plain(dialog)).toContain('Enter to submit');
    dialog.handleInput(UP);
    expect(plain(dialog)).toContain('next field');
  });

  it('requires a non-empty Bearer token before submitting', () => {
    const { dialog, onDone } = makeDialog();
    dialog.handleInput('\r'); // url -> token
    dialog.handleInput('\r'); // attempt submit with an empty token
    expect(onDone).not.toHaveBeenCalled();
    expect(plain(dialog)).toContain('Bearer token cannot be empty');
  });

  it('submits the url and token once both are provided', () => {
    const { dialog, onDone } = makeDialog();
    dialog.handleInput('\r'); // url -> token
    for (const ch of 'sk-tok') dialog.handleInput(ch);
    dialog.handleInput('\r'); // submit from the token field

    expect(onDone).toHaveBeenCalledWith({
      kind: 'ok',
      value: { url: 'https://example.com/api.json', apiKey: 'sk-tok' },
    });
  });

  it('keeps every line within narrow widths', () => {
    const { dialog } = makeDialog('https://example.com/very/long/registry/path.json');

    for (const width of [39, 35, 20, 10]) {
      for (const line of dialog.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

function plainEndpoint(component: CustomEndpointImportDialogComponent, width = 80): string {
  return component.render(width).map(strip).join('\n');
}

describe('CustomEndpointImportDialogComponent', () => {
  it('collects endpoint and model fields, masking the API key', () => {
    const onDone = vi.fn();
    const dialog = new CustomEndpointImportDialogComponent(
      'chat',
      onDone as unknown as (result: CustomEndpointImportResult) => void,
    );
    dialog.focused = true;

    for (const ch of 'https://api.example.test/v1') dialog.handleInput(ch);
    dialog.handleInput('\r');
    for (const ch of 'sk-secret') dialog.handleInput(ch);
    expect(plainEndpoint(dialog)).not.toContain('sk-secret');
    dialog.handleInput('\r');
    dialog.handleInput('\r'); // keep default provider id "custom"
    for (const ch of 'model-wire-id') dialog.handleInput(ch);
    dialog.handleInput('\r');
    for (const ch of 'Model Display Name') dialog.handleInput(ch);
    dialog.handleInput('\r');
    dialog.handleInput('\r'); // keep the default context size and submit

    expect(onDone).toHaveBeenCalledWith({
      kind: 'ok',
      value: {
        protocol: 'chat',
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'sk-secret',
        providerId: 'custom',
        modelId: 'model-wire-id',
        modelName: 'Model Display Name',
        maxContextSize: 131072,
      },
    });
  });

  it('returns focus to the first invalid field on submit', () => {
    const onDone = vi.fn();
    const dialog = new CustomEndpointImportDialogComponent(
      'responses',
      onDone as unknown as (result: CustomEndpointImportResult) => void,
    );
    dialog.focused = true;

    for (let index = 0; index < 5; index++) dialog.handleInput('\t');
    dialog.handleInput('\r');

    expect(onDone).not.toHaveBeenCalled();
    expect(plainEndpoint(dialog)).toContain('Base URL must be a valid absolute URL');
    expect(plainEndpoint(dialog)).toContain('Enter next');
  });

  it('keeps every line within narrow widths', () => {
    const dialog = new CustomEndpointImportDialogComponent('anthropic', vi.fn());
    dialog.focused = true;

    for (const width of [39, 35, 20, 10]) {
      for (const line of dialog.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});
