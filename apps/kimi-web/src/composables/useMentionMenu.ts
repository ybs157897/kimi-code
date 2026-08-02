// apps/kimi-web/src/composables/useMentionMenu.ts
import { nextTick, ref, type Ref } from 'vue';
import type { FileItem, MentionItem } from '../types';

export interface MentionExpertTeam {
  pluginId: string;
  name: string;
  description: string;
}

export interface MentionMenuDeps {
  /** The live composer text — the @token is read from it and rewritten on select. */
  text: Ref<string>;
  /** The textarea element, used to read the caret and place it after insertion. */
  textareaRef: Ref<HTMLTextAreaElement | null>;
  /** Re-fit the textarea after its text changes. */
  autosize: () => void;
  /** File search for the @-query (getter; undefined disables the menu). */
  searchFiles: () => ((q: string) => Promise<FileItem[]>) | undefined;
  /** Localized expert teams shown before file results. */
  expertTeams: () => MentionExpertTeam[];
  /** Activate the selected expert team for the current session. */
  selectExpertTeam: (pluginId: string) => void;
}

interface MentionToken {
  token: string;
  start: number;
  end: number;
}

/**
 * `@` file-mention menu: token detection, debounced search, keyboard navigation
 * state, and insertion.
 *
 * The composer keeps the keydown orchestration (arrow keys, Enter/Tab, Escape)
 * because it also juggles the slash menu and history recall; this composable
 * owns the menu's open/items/active/loading state and the search/insert logic.
 */
export function useMentionMenu(deps: MentionMenuDeps) {
  const { text, textareaRef, autosize, searchFiles, expertTeams, selectExpertTeam } = deps;

  const open = ref(false);
  const items = ref<MentionItem[]>([]);
  const active = ref(0);
  const loading = ref(false);

  // Debounce timer for the search.
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** Find the @token under the cursor in the current text value. Returns null if none. */
  function getMentionToken(): MentionToken | null {
    const val = text.value;
    const pos = textareaRef.value?.selectionStart ?? val.length;
    // Walk backwards from the cursor to find the start of a @token.
    let start = pos - 1;
    while (start >= 0 && !/\s/.test(val[start]!)) {
      start--;
    }
    start++;
    const tokenPart = val.slice(start, pos);
    if (!tokenPart.startsWith('@')) return null;
    // The end of the token is where the cursor is (or after the next space).
    return { token: tokenPart.slice(1), start, end: pos };
  }

  function update(): void {
    const mt = getMentionToken();
    const search = searchFiles();
    const teams = expertTeams();
    if (!mt || (!search && teams.length === 0)) {
      open.value = false;
      return;
    }
    const query = mt.token;
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const teamItems: MentionItem[] = teams
      .filter((team) => {
        if (!normalizedQuery) return true;
        return `${team.name} ${team.description} ${team.pluginId}`
          .toLocaleLowerCase()
          .includes(normalizedQuery);
      })
      .map((team) => ({ kind: 'expert-team', ...team }));

    if (timer !== null) clearTimeout(timer);
    items.value = teamItems;
    open.value = teams.length > 0;
    active.value = 0;
    loading.value = search !== undefined;
    if (!search) return;

    timer = setTimeout(async () => {
      open.value = true;
      try {
        const files = await search(query);
        items.value = [
          ...teamItems,
          ...files.map((file): MentionItem => ({ kind: 'file', ...file })),
        ];
      } catch {
        items.value = teamItems;
      } finally {
        loading.value = false;
      }
    }, 200);
  }

  function select(item: MentionItem): void {
    const mt = getMentionToken();
    if (!mt) return;
    const val = text.value;
    const insertion = item.kind === 'file' ? item.path : '';
    text.value = val.slice(0, mt.start) + insertion + val.slice(mt.end);
    if (item.kind === 'expert-team') selectExpertTeam(item.pluginId);
    open.value = false;
    void nextTick(() => {
      const el = textareaRef.value;
      if (!el) return;
      const newPos = mt.start + insertion.length;
      el.setSelectionRange(newPos, newPos);
      el.focus();
      autosize();
    });
  }

  return { open, items, active, loading, update, select };
}
