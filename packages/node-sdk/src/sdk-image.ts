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
  persistOriginalImage,
  sessionMediaOriginalsDir,
} from '@moonshot-ai/agent-core-v2/agent/media/image-originals';
export type { PersistOriginalImageOptions } from '@moonshot-ai/agent-core-v2/agent/media/image-originals';

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
  readonly maxEdgePx: number;
  readonly readByteBudget: number;

  constructor(
    env?: Readonly<Record<string, string | undefined>>,
    config?: { readonly maxEdgePx?: number; readonly readByteBudget?: number },
  ) {
    const e = env ?? process.env;
    this.maxEdgePx = positiveInt(e[ENV_MAX_EDGE_KEY]) ?? config?.maxEdgePx ?? 2000;
    this.readByteBudget = positiveInt(e[ENV_READ_BUDGET_KEY]) ?? config?.readByteBudget ?? 256 * 1024;
  }
}

// Re-export image format policy types that don't exist in the v2 barrel.
export type {
  CompressImageOptions as CompressImageOptions_,
  CompressImageResult as CompressImageResult_,
} from '@moonshot-ai/agent-core-v2/agent/media/image-compress';
