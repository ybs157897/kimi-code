// Raw-string imports for prompt sources. `agent-core-v2` loads several prompt
// templates via `*.md?raw`; this declaration lets the sidecar's typecheck
// process those transitive imports. At runtime the sidecar runs under tsx with
// the shared `build/register-raw-text-loader.mjs` loader for the same import
// shape.

declare module '*?raw' {
  const content: string;
  export default content;
}
