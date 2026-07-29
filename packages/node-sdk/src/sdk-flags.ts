/**
 * SDK-local flag types — re-exported from the v2 flag registry with the
 * `FlagDefinition` type alias that legacy consumers expect.
 *
 * These were originally re-exported from `@moonshot-ai/agent-core`.
 * The v2 `@moonshot-ai/agent-core-v2` is the canonical owner of the flag
 * domain; this module bridges the naming difference.
 */

// Types available from the v2 barrel.
export type {
  ExperimentalFeatureState,
  ExperimentalFlagMap,
  ExperimentalFlagSource,
  FlagId,
  FlagSurface,
} from '@moonshot-ai/agent-core-v2';
export type {
  FlagDefinitionInput,
} from '@moonshot-ai/agent-core-v2';

/** FlagId-typed view so consumers can fetch a definition by its literal id. */
export type FlagDefinition = import('@moonshot-ai/agent-core-v2').FlagDefinitionInput & { readonly id: import('@moonshot-ai/agent-core-v2').FlagId };
