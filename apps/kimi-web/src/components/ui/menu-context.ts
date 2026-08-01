// apps/kimi-web/src/components/ui/menu-context.ts
// Shared contract between Menu and MenuItem: the roving-tabindex marker that
// says which item button is the current keyboard target (tabindex 0).
import type { InjectionKey, ShallowRef } from 'vue';

/** Corner of the menu surface that meets its trigger — anchors the open/close
 *  transform-origin and the direction of the small drift. */
export type MenuOrigin = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface MenuContext {
  /** Item button that currently owns keyboard focus (null while closed). */
  tabTarget: ShallowRef<HTMLElement | null>;
}

export const menuContextKey: InjectionKey<MenuContext> = Symbol('ui-menu');
