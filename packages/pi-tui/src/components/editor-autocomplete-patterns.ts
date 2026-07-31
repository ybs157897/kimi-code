import type { SelectListLayoutOptions } from "./select-list.ts";

export const SLASH_COMMAND_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

export const ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS = 20;
export const DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS = ["@", "#"];

function escapeCharacterClass(value: string): string {
	return value.replace(/[\\^$.*+?()[\]{}|-]/g, "\\$&");
}

export function buildTriggerPattern(triggerCharacters: string[]): RegExp {
	return new RegExp(`(?:^|[\\s])[${triggerCharacters.map(escapeCharacterClass).join("")}][^\\s]*$`);
}

export function buildDebouncePattern(triggerCharacters: string[]): RegExp {
	const escapedWithoutAt = triggerCharacters.filter((character) => character !== "@").map(escapeCharacterClass);
	return new RegExp(`(?:^|[ \\t])(?:@(?:"[^"]*|[^\\s]*)|[${escapedWithoutAt.join("")}][^\\s]*)$`);
}
