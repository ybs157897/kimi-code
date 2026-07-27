export interface RuntimeAuthStatus {
  readonly loggedIn: boolean;
  readonly provider?: string;
}

/** Runtime-neutral device-code details shown by the interactive TUI. */
export interface RuntimeAuthDeviceCode {
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly userCode: string;
  readonly expiresIn: number | null;
  readonly interval: number;
}

export interface RuntimeAuthLoginOptions {
  readonly signal?: AbortSignal;
  readonly onDeviceCode?: (
    deviceCode: RuntimeAuthDeviceCode,
  ) => Promise<void> | void;
}

export interface RuntimeManagedUsageRow {
  readonly label: string;
  readonly used: number;
  readonly limit: number;
  readonly resetHint?: string;
}

export interface RuntimeManagedUsageExtraUsage {
  readonly balanceCents: number;
  readonly totalCents: number;
  readonly monthlyChargeLimitEnabled: boolean;
  readonly monthlyChargeLimitCents: number;
  readonly monthlyUsedCents: number;
  readonly currency: string;
}

export type RuntimeManagedUsageResult =
  | {
      readonly kind: 'ok';
      readonly summary: RuntimeManagedUsageRow | null;
      readonly limits: readonly RuntimeManagedUsageRow[];
      readonly extraUsage: RuntimeManagedUsageExtraUsage | null;
    }
  | {
      readonly kind: 'error';
      readonly message: string;
      readonly status?: number;
    };

export interface RuntimeFeedbackInput {
  readonly content: string;
  readonly sessionId: string;
  readonly version: string;
  readonly os: string;
  readonly model: string | null;
  readonly contact?: string;
  readonly info?: Readonly<Record<string, unknown>>;
}

export type RuntimeFeedbackResult =
  | { readonly kind: 'ok'; readonly feedbackId: number }
  | {
      readonly kind: 'error';
      readonly message: string;
      readonly status?: number;
    };

export interface RuntimeFeedbackUploadPart {
  readonly partNumber: number;
  readonly url: string;
  readonly method: string;
  readonly size: number;
}

export type RuntimeFeedbackUploadUrlResult =
  | {
      readonly kind: 'ok';
      readonly uploadId: number;
      readonly parts: readonly RuntimeFeedbackUploadPart[];
    }
  | {
      readonly kind: 'error';
      readonly message: string;
      readonly status?: number;
    };

export interface RuntimeFeedbackUploadUrlInput {
  readonly feedbackId: number;
  readonly filename: string;
  readonly size: number;
  readonly sha256: string;
}

export interface RuntimeFeedbackUploadCompleteInput {
  readonly uploadId: number;
  readonly parts: readonly {
    readonly partNumber: number;
    readonly etag: string;
  }[];
}

export type RuntimeFeedbackUploadCompleteResult =
  | { readonly kind: 'ok' }
  | {
      readonly kind: 'error';
      readonly message: string;
      readonly status?: number;
    };

/** Process-level authentication capabilities used by the interactive TUI. */
export interface RuntimeAuthPort {
  status(provider?: string): Promise<RuntimeAuthStatus>;
  login(provider?: string, options?: RuntimeAuthLoginOptions): Promise<void>;
  logout(provider?: string): Promise<void>;
  ensureReady(model?: string): Promise<void>;
  getManagedUsage(provider?: string): Promise<RuntimeManagedUsageResult>;
  submitFeedback(
    input: RuntimeFeedbackInput,
    provider?: string,
  ): Promise<RuntimeFeedbackResult>;
  createFeedbackUploadUrl(
    input: RuntimeFeedbackUploadUrlInput,
    provider?: string,
  ): Promise<RuntimeFeedbackUploadUrlResult>;
  completeFeedbackUpload(
    input: RuntimeFeedbackUploadCompleteInput,
    provider?: string,
  ): Promise<RuntimeFeedbackUploadCompleteResult>;
}

export function copyRuntimeManagedUsageResult(
  result: RuntimeManagedUsageResult,
): RuntimeManagedUsageResult {
  if (result.kind === 'error') {
    return {
      kind: 'error',
      message: result.message,
      status: result.status,
    };
  }

  return {
    kind: 'ok',
    summary:
      result.summary === null
        ? null
        : {
            label: result.summary.label,
            used: result.summary.used,
            limit: result.summary.limit,
            resetHint: result.summary.resetHint,
          },
    limits: result.limits.map((row) => ({
      label: row.label,
      used: row.used,
      limit: row.limit,
      resetHint: row.resetHint,
    })),
    extraUsage:
      result.extraUsage === null
        ? null
        : {
            balanceCents: result.extraUsage.balanceCents,
            totalCents: result.extraUsage.totalCents,
            monthlyChargeLimitEnabled:
              result.extraUsage.monthlyChargeLimitEnabled,
            monthlyChargeLimitCents:
              result.extraUsage.monthlyChargeLimitCents,
            monthlyUsedCents: result.extraUsage.monthlyUsedCents,
            currency: result.extraUsage.currency,
          },
  };
}
