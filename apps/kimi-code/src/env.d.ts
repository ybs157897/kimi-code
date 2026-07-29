// Raw-string imports for prompt sources. `agent-core-v2` loads several prompt
// templates via `*.md?raw`; this declaration lets the CLI's typecheck process
// those transitive imports. Vite/Vitest handles `?raw` natively; tsdown uses the
// shared `raw-text-plugin` for the same import shape.

declare module '*?raw' {
  const content: string;
  export default content;
}
