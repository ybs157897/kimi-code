/**
 * Local `ToolInputDisplay` subset used by the migrator to attach recovered
 * user-facing tool-call displays to translated assistant messages.
 *
 * This intentionally mirrors the v2 `ToolInputDisplay` shape only for the
 * variants that can appear in legacy kimi-cli wire files. Keeping the type
 * local to `migration-legacy` lets the package avoid a production dependency
 * on the legacy agent-core package while still producing wire-compatible
 * display metadata.
 */
export type ToolInputDisplay =
  | {
      readonly kind: 'command';
      readonly command: string;
      readonly cwd?: string | undefined;
      readonly description?: string | undefined;
      readonly language?: 'bash' | undefined;
    }
  | {
      readonly kind: 'diff';
      readonly path: string;
      readonly before: string;
      readonly after: string;
      readonly hunks?: number | undefined;
    }
  | {
      readonly kind: 'todo_list';
      readonly items: ReadonlyArray<{ readonly title: string; readonly status: string }>;
    }
  | {
      readonly kind: 'generic';
      readonly summary: string;
      readonly detail?: unknown;
    };
