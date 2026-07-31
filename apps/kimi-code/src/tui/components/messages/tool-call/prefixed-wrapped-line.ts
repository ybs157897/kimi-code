/**
 * A wrapped text line with a first-row prefix and a continuation prefix,
 * optionally tail-capped / min-padded to a fixed display-row window.
 */

import { Text, truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';
import type { Component } from '@moonshot-ai/pi-tui';

import { isRenderCacheEnabled } from '#/tui/utils/render-cache';

export class PrefixedWrappedLine implements Component {
  private renderCache: { width: number; lines: string[] } | undefined;

  constructor(
    private readonly firstPrefix: string,
    private readonly continuationPrefix: string,
    private readonly text: string,
    // When set, only the last N wrapped display rows are kept, so a long
    // unwrapped paragraph scrolls within a fixed window instead of growing
    // unbounded. The first kept row still gets `firstPrefix`.
    private readonly tailLines?: number,
    // When set, the output is padded with empty continuation rows until it
    // reaches this many display rows, so a short paragraph still fills a
    // fixed-height window. Applied after `tailLines`.
    private readonly minLines?: number,
  ) { }

  invalidate(): void {
    this.renderCache = undefined;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    if (isRenderCacheEnabled() && this.renderCache?.width === safeWidth) {
      return this.renderCache.lines;
    }

    const prefixWidth = Math.max(
      visibleWidth(this.firstPrefix),
      visibleWidth(this.continuationPrefix),
    );
    const contentWidth = Math.max(1, safeWidth - prefixWidth);
    const wrapped = new Text(this.text, 0, 0).render(contentWidth);
    const lines =
      this.tailLines !== undefined && wrapped.length > this.tailLines
        ? wrapped.slice(wrapped.length - this.tailLines)
        : wrapped;
    if (this.minLines !== undefined) {
      while (lines.length < this.minLines) lines.push('');
    }
    const rendered = lines
      .map((line, index) =>
        index === 0 ? `${this.firstPrefix}${line}` : `${this.continuationPrefix}${line}`,
      )
      .map((line) => truncateToWidth(line, safeWidth, '…'));
    if (isRenderCacheEnabled()) {
      this.renderCache = { width: safeWidth, lines: rendered };
    }
    return rendered;
  }
}
