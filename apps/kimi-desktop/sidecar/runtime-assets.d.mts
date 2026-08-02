export interface RuntimeFileAsset {
  readonly id: string;
  readonly target: string;
  readonly env?: string;
}

export const RUNTIME_FILE_ASSETS: readonly RuntimeFileAsset[];
export const TREE_SITTER_WASM_ASSETS: readonly (readonly [string, string])[];
export const TREE_SITTER_ASSETS_ENV: string;
export const TREE_SITTER_ASSETS_DIR: string;
