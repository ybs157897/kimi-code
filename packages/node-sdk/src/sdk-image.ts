/**
 * SDK-local image helpers — re-exports from the v2 agent-core image
 * compression and originals modules, plus the ImageLimits class.
 *
 * These were originally re-exported from `@moonshot-ai/agent-core`.  The v2
 * package already owns the canonical implementations; this module simply
 * re-exports them so the SDK barrel (`index.ts`) can drop the legacy dep.
 *
 * Node- / Uint8Array-specific helpers (compressImageForModel, etc.) are kept
 * here as thin re-exports from v2, which already imports Node-native Buffer /
 * pathe and is the single source of truth for compression logic.
 */

import { HostFileSystem } from '@moonshot-ai/agent-core-v2/os/backends/node-local/hostFsService';
import {
  persistOriginalImage as persistOriginalImageWithHostFs,
  type PersistOriginalImageOptions as CorePersistOriginalImageOptions,
} from '@moonshot-ai/agent-core-v2/agent/media/image-originals';

// ── Compression (image-compress.ts) ──────────────────────────────────────
export {
  buildImageCompressionCaption,
  compressImageForModel,
  compressBase64ForModel,
  compressImageContentParts,
  cropImageForModel,
  gateImageFormatParts,
  resolveMaxImageEdgePx,
  resolveReadImageByteBudget,
  IMAGE_BYTE_BUDGET,
  MAX_IMAGE_EDGE_PX,
  READ_IMAGE_BYTE_BUDGET,
  formatByteSize,
} from '@moonshot-ai/agent-core-v2/agent/media/image-compress';
export type {
  CompressAnnotateOptions,
  CompressedContentParts,
  CompressImageOptions,
  CompressImageResult,
  CompressBase64Result,
  CropImageOptions,
  CropImageOutcome,
  ImageCompressionCaptionInput,
  ImageCompressionTelemetry,
  ImageCropRegion,
  ImageVariantDescription,
} from '@moonshot-ai/agent-core-v2/agent/media/image-compress';

// ── Image format policy ──────────────────────────────────────────────────
export {
  buildUnsupportedImageNotice,
  decodeBase64Prefix,
  isModelAcceptedImageMime,
  normalizeImageMime,
  parseImageDataUrl,
} from '@moonshot-ai/agent-core-v2/agent/media/image-format-policy';

// ── Image originals persistence ──────────────────────────────────────────
export {
  originalImageCacheDir,
  sessionMediaOriginalsDir,
} from '@moonshot-ai/agent-core-v2/agent/media/image-originals';

export type PersistOriginalImageOptions = Omit<
  CorePersistOriginalImageOptions,
  'hostFs'
>;

const imageOriginalsHostFs = new HostFileSystem();

/**
 * Node SDK edge adapter for original-image persistence.
 *
 * The core helper requires its host filesystem port explicitly. SDK
 * consumers get the same narrow bytes-to-path capability without receiving
 * the engine's filesystem service or DI accessor.
 */
export function persistOriginalImage(
  bytes: Uint8Array,
  mimeType: string,
  options: PersistOriginalImageOptions = {},
): Promise<string | null> {
  return persistOriginalImageWithHostFs(bytes, mimeType, {
    ...options,
    hostFs: imageOriginalsHostFs,
  });
}

// ── ImageLimits class ────────────────────────────────────────────────────

const ENV_MAX_EDGE_KEY = 'KIMI_IMAGE_MAX_EDGE_PX';
const ENV_READ_BUDGET_KEY = 'KIMI_IMAGE_READ_BYTE_BUDGET';

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Owner-scoped resolution of image config limits.
 *
 * Resolution precedence: env var > owning config > built-in default.
 * One instance per owner (e.g. SDK client), matching the legacy pattern.
 */
export class ImageLimits {
  private readonly env: Readonly<Record<string, string | undefined>>;
  private config: { readonly maxEdgePx?: number; readonly readByteBudget?: number } | undefined;

  constructor(
    env?: Readonly<Record<string, string | undefined>>,
    config?: { readonly maxEdgePx?: number; readonly readByteBudget?: number },
  ) {
    this.env = env ?? process.env;
    this.config = config;
  }

  get maxEdgePx(): number {
    return positiveInt(this.env[ENV_MAX_EDGE_KEY]) ?? this.config?.maxEdgePx ?? 2000;
  }

  get readByteBudget(): number {
    return (
      positiveInt(this.env[ENV_READ_BUDGET_KEY]) ??
      this.config?.readByteBudget ??
      256 * 1024
    );
  }

  /** Refresh the owner-scoped values after a config reload. */
  setConfig(
    config: { readonly maxEdgePx?: number; readonly readByteBudget?: number } | undefined,
  ): void {
    this.config = config;
  }
}

// Re-export image format policy types that don't exist in the v2 barrel.
export type {
  CompressImageOptions as CompressImageOptions_,
  CompressImageResult as CompressImageResult_,
} from '@moonshot-ai/agent-core-v2/agent/media/image-compress';
