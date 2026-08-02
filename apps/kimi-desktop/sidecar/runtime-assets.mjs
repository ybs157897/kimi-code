/**
 * Single source of truth for resources that a packaged desktop sidecar must
 * materialize outside the Node SEA virtual filesystem.
 */

export const RUNTIME_FILE_ASSETS = [
  { id: 'extensionHostApi', target: 'extension-host.cjs', env: 'KIMI_EXTENSION_HOST_API' },
  { id: 'jitiBabel', target: 'jiti-babel.cjs', env: 'KIMI_JITI_BABEL_PATH' },
  { id: 'webTreeSitter', target: 'web-tree-sitter.cjs', env: 'KIMI_WEB_TREE_SITTER_PATH' },
  { id: 'webTreeSitterWasm', target: 'web-tree-sitter.wasm' },
];

export const TREE_SITTER_WASM_ASSETS = [
  ['tree-sitter-typescript', 'tree-sitter-typescript.wasm'],
  ['tree-sitter-typescript', 'tree-sitter-tsx.wasm'],
  ['tree-sitter-javascript', 'tree-sitter-javascript.wasm'],
  ['tree-sitter-python', 'tree-sitter-python.wasm'],
  ['tree-sitter-go', 'tree-sitter-go.wasm'],
  ['tree-sitter-rust', 'tree-sitter-rust.wasm'],
  ['tree-sitter-java', 'tree-sitter-java.wasm'],
  ['tree-sitter-ruby', 'tree-sitter-ruby.wasm'],
  ['tree-sitter-php', 'tree-sitter-php.wasm'],
  ['tree-sitter-scala', 'tree-sitter-scala.wasm'],
  ['tree-sitter-cpp', 'tree-sitter-cpp.wasm'],
  ['tree-sitter-c-sharp', 'tree-sitter-c_sharp.wasm'],
  ['@tree-sitter-grammars/tree-sitter-kotlin', 'tree-sitter-kotlin.wasm'],
  ['@moonshot-ai/understand-core', 'assets/tree-sitter-dart.wasm'],
  ['@moonshot-ai/understand-core', 'assets/tree-sitter-swift.wasm'],
];

export const TREE_SITTER_ASSETS_ENV = 'KIMI_TREE_SITTER_ASSETS_DIR';
export const TREE_SITTER_ASSETS_DIR = 'tree-sitter-assets';
