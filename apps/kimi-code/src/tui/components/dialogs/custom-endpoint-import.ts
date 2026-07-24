import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';

import {
  DEFAULT_CUSTOM_ENDPOINT_CONTEXT_SIZE,
  normalizeCustomEndpointInput,
  type CustomEndpointInput,
  type CustomEndpointProtocol,
} from '#/utils/custom-endpoint-provider';
import { currentTheme } from '#/tui/theme';

export type CustomEndpointImportResult =
  | { readonly kind: 'ok'; readonly value: CustomEndpointInput }
  | { readonly kind: 'cancel' };

type FieldId = 'baseUrl' | 'apiKey' | 'providerId' | 'modelId' | 'modelName' | 'contextSize';

const FIELD_ORDER: readonly FieldId[] = [
  'baseUrl',
  'apiKey',
  'providerId',
  'modelId',
  'modelName',
  'contextSize',
];

const FIELD_LABELS: Readonly<Record<FieldId, string>> = {
  baseUrl: 'Base URL',
  apiKey: 'API key',
  providerId: 'Provider ID',
  modelId: 'Model ID',
  modelName: 'Model name',
  contextSize: 'Context size',
};

const PROTOCOL_LABELS: Readonly<Record<CustomEndpointProtocol, string>> = {
  chat: 'OpenAI Chat Completions',
  responses: 'OpenAI Responses',
  anthropic: 'Anthropic Messages',
};

function maskInputLine(raw: string): string {
  const prefix = '> ';
  if (!raw.startsWith(prefix)) return raw;

  let end = raw.length;
  while (end > prefix.length && raw[end - 1] === ' ') {
    end--;
  }
  const padding = raw.slice(end);
  const content = raw.slice(prefix.length, end);
  const parts = content.split(/(\u001B(?:\[[0-9;]*m|_pi:c\u0007))/);
  const maskedContent = parts
    .map((part, index) => (index % 2 === 1 ? part : part.replaceAll(/[^ ]/g, '•')))
    .join('');
  return prefix + maskedContent + padding;
}

export class CustomEndpointImportDialogComponent extends Container implements Focusable {
  focused = false;

  private readonly inputs: Record<FieldId, Input> = {
    baseUrl: new Input(),
    apiKey: new Input(),
    providerId: new Input(),
    modelId: new Input(),
    modelName: new Input(),
    contextSize: new Input(),
  };
  private readonly protocol: CustomEndpointProtocol;
  private readonly onDone: (result: CustomEndpointImportResult) => void;
  private activeIndex = 0;
  private done = false;
  private errorHint: string | undefined;

  constructor(
    protocol: CustomEndpointProtocol,
    onDone: (result: CustomEndpointImportResult) => void,
  ) {
    super();
    this.protocol = protocol;
    this.onDone = onDone;
    this.inputs.providerId.setValue('custom');
    this.inputs.contextSize.setValue(String(DEFAULT_CUSTOM_ENDPOINT_CONTEXT_SIZE));

    for (let index = 0; index < FIELD_ORDER.length; index++) {
      const input = this.inputs[FIELD_ORDER[index]!];
      input.onSubmit = () => {
        if (index === FIELD_ORDER.length - 1) {
          this.handleSubmit();
        } else {
          this.focusIndex(index + 1);
        }
      };
    }
  }

  handleInput(data: string): void {
    if (this.done) return;
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl('c')) ||
      matchesKey(data, Key.ctrl('d'))
    ) {
      this.cancel();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.focusIndex((this.activeIndex + 1) % FIELD_ORDER.length);
      return;
    }
    if (matchesKey(data, Key.shift('tab'))) {
      this.focusIndex((this.activeIndex - 1 + FIELD_ORDER.length) % FIELD_ORDER.length);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.focusIndex(Math.min(this.activeIndex + 1, FIELD_ORDER.length - 1));
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.focusIndex(Math.max(this.activeIndex - 1, 0));
      return;
    }

    this.errorHint = undefined;
    this.activeInput().handleInput(data);
  }

  override invalidate(): void {
    super.invalidate();
    for (const input of Object.values(this.inputs)) input.invalidate();
  }

  override render(width: number): string[] {
    for (let index = 0; index < FIELD_ORDER.length; index++) {
      this.inputs[FIELD_ORDER[index]!].focused =
        this.focused && !this.done && index === this.activeIndex;
    }

    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];
    const innerWidth = Math.max(1, safeWidth - 4);
    const pad = '  ';
    const border = (text: string): string => currentTheme.fg('primary', text);
    const title = truncateToWidth(
      currentTheme.boldFg('textStrong', 'Configure custom API endpoint'),
      innerWidth,
      '…',
    );
    const subtitle = truncateToWidth(
      currentTheme.fg(
        this.errorHint === undefined ? 'textDim' : 'error',
        this.errorHint ?? `Protocol: ${PROTOCOL_LABELS[this.protocol]}`,
      ),
      innerWidth,
      '…',
    );
    const footer = truncateToWidth(
      currentTheme.fg(
        'textDim',
        this.activeIndex === FIELD_ORDER.length - 1
          ? 'Tab / ↑↓ switch field · Enter submit · Esc cancel'
          : 'Tab / ↑↓ switch field · Enter next · Esc cancel',
      ),
      innerWidth,
      '…',
    );

    const contentLines: string[] = [title, subtitle, ''];
    for (let index = 0; index < FIELD_ORDER.length; index++) {
      const field = FIELD_ORDER[index]!;
      const selected = index === this.activeIndex;
      contentLines.push(
        truncateToWidth(
          selected
            ? currentTheme.boldFg('accent', FIELD_LABELS[field])
            : currentTheme.fg('textDim', FIELD_LABELS[field]),
          innerWidth,
          '…',
        ),
      );
      const rawInputLine = this.inputs[field].render(innerWidth)[0] ?? '> ';
      contentLines.push(
        truncateToWidth(
          field === 'apiKey' && this.inputs.apiKey.getValue() !== ''
            ? maskInputLine(rawInputLine)
            : rawInputLine,
          innerWidth,
          '…',
        ),
      );
    }
    contentLines.push('', footer);

    if (safeWidth < 4) {
      return ['', ...contentLines.map((line) => truncateToWidth(line, safeWidth, '…'))];
    }

    const lines: string[] = [
      '',
      border('╭' + '─'.repeat(safeWidth - 2) + '╮'),
      border('│') + ' '.repeat(safeWidth - 2) + border('│'),
    ];
    for (const content of contentLines) {
      const rightPad = Math.max(0, innerWidth - visibleWidth(content));
      lines.push(border('│') + pad + content + ' '.repeat(rightPad) + border('│'));
    }
    lines.push(border('│') + ' '.repeat(safeWidth - 2) + border('│'));
    lines.push(border('╰' + '─'.repeat(safeWidth - 2) + '╯'));
    lines.push('');
    return lines.map((line) => truncateToWidth(line, safeWidth, '…'));
  }

  private activeInput(): Input {
    return this.inputs[FIELD_ORDER[this.activeIndex]!];
  }

  private focusIndex(index: number): void {
    this.activeIndex = index;
    this.errorHint = undefined;
  }

  private handleSubmit(): void {
    const contextSize = Number(this.inputs.contextSize.getValue().trim());
    const value: CustomEndpointInput = {
      protocol: this.protocol,
      baseUrl: this.inputs.baseUrl.getValue(),
      apiKey: this.inputs.apiKey.getValue(),
      providerId: this.inputs.providerId.getValue(),
      modelId: this.inputs.modelId.getValue(),
      modelName: this.inputs.modelName.getValue(),
      maxContextSize: contextSize,
    };
    try {
      const { providerType: _providerType, ...normalized } = normalizeCustomEndpointInput(value);
      this.done = true;
      this.onDone({ kind: 'ok', value: normalized });
    } catch (error) {
      this.errorHint = error instanceof Error ? error.message : String(error);
      this.focusFirstInvalidField(value);
    }
  }

  private focusFirstInvalidField(value: CustomEndpointInput): void {
    if (!isValidHttpUrl(value.baseUrl)) {
      this.activeIndex = FIELD_ORDER.indexOf('baseUrl');
    } else if (value.apiKey.trim().length === 0) {
      this.activeIndex = FIELD_ORDER.indexOf('apiKey');
    } else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.providerId.trim())) {
      this.activeIndex = FIELD_ORDER.indexOf('providerId');
    } else if (value.modelId.trim().length === 0) {
      this.activeIndex = FIELD_ORDER.indexOf('modelId');
    } else if (value.modelName.trim().length === 0) {
      this.activeIndex = FIELD_ORDER.indexOf('modelName');
    } else {
      this.activeIndex = FIELD_ORDER.indexOf('contextSize');
    }
  }

  private cancel(): void {
    if (this.done) return;
    this.done = true;
    this.onDone({ kind: 'cancel' });
  }
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
