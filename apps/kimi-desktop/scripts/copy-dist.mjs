// Copies the built kimi-web bundle into frontend/dist for go:embed.
// Run via `pnpm run build:frontend` (which builds @moonshot-ai/kimi-web first).
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../../kimi-web/dist', import.meta.url));
const target = fileURLToPath(new URL('../frontend/dist', import.meta.url));

if (!existsSync(source)) {
  console.error('apps/kimi-web/dist not found — run `pnpm --filter @moonshot-ai/kimi-web build` first.');
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log(`copied kimi-web dist -> ${target}`);
