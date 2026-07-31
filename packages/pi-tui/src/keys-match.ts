import {
	ARROW_CODEPOINTS,
	CODEPOINTS,
	FUNCTIONAL_CODEPOINTS,
	LOCK_MASK,
	MODIFIERS,
	SYMBOL_KEYS,
	normalizeKittyFunctionalCodepoint,
	normalizeShiftedLetterIdentityCodepoint,
} from "./keys-constants.ts";
import {
	isWindowsTerminalSession,
	matchesKittySequence,
	matchesModifyOtherKeys,
	matchesRawBackspace,
	parseKittySequence,
	parseModifyOtherKeysSequence,
} from "./keys-kitty.ts";
import {
	LEGACY_KEY_SEQUENCES,
	LEGACY_SEQUENCE_KEY_IDS,
	matchesLegacyModifierSequence,
	matchesLegacySequence,
} from "./keys-legacy-sequences.ts";
import { _kittyProtocolActive } from "./keys-state.ts";
import type { KeyId } from "./keys-types.ts";

// =============================================================================
// Generic Key Matching
// =============================================================================

/**
 * Get the control character for a key.
 * Uses the universal formula: code & 0x1f (mask to lower 5 bits)
 *
 * Works for:
 * - Letters a-z → 1-26
 * - Symbols [\]_ → 27, 28, 29, 31
 * - Also maps - to same as _ (same physical key on US keyboards)
 */
function rawCtrlChar(key: string): string | null {
	const char = key.toLowerCase();
	const code = char.charCodeAt(0);
	if ((code >= 97 && code <= 122) || char === "[" || char === "\\" || char === "]" || char === "_") {
		return String.fromCharCode(code & 0x1f);
	}
	// Handle - as _ (same physical key on US keyboards)
	if (char === "-") {
		return String.fromCharCode(31); // Same as Ctrl+_
	}
	return null;
}

function isDigitKey(key: string): boolean {
	return key >= "0" && key <= "9";
}

function matchesPrintableModifyOtherKeys(data: string, expectedKeycode: number, expectedModifier: number): boolean {
	if (expectedModifier === 0) return false;
	const parsed = parseModifyOtherKeysSequence(data);
	if (!parsed || parsed.modifier !== expectedModifier) return false;
	return (
		normalizeShiftedLetterIdentityCodepoint(parsed.codepoint, parsed.modifier) ===
		normalizeShiftedLetterIdentityCodepoint(expectedKeycode, expectedModifier)
	);
}

function formatKeyNameWithModifiers(keyName: string, modifier: number): string | undefined {
	const mods: string[] = [];
	const effectiveMod = modifier & ~LOCK_MASK;
	const supportedModifierMask = MODIFIERS.shift | MODIFIERS.ctrl | MODIFIERS.alt | MODIFIERS.super;
	if ((effectiveMod & ~supportedModifierMask) !== 0) return undefined;
	if (effectiveMod & MODIFIERS.shift) mods.push("shift");
	if (effectiveMod & MODIFIERS.ctrl) mods.push("ctrl");
	if (effectiveMod & MODIFIERS.alt) mods.push("alt");
	if (effectiveMod & MODIFIERS.super) mods.push("super");
	return mods.length > 0 ? `${mods.join("+")}+${keyName}` : keyName;
}

function parseKeyId(
	keyId: string,
): { key: string; ctrl: boolean; shift: boolean; alt: boolean; super: boolean } | null {
	const parts = keyId.toLowerCase().split("+");
	const key = parts[parts.length - 1];
	if (!key) return null;
	return {
		key,
		ctrl: parts.includes("ctrl"),
		shift: parts.includes("shift"),
		alt: parts.includes("alt"),
		super: parts.includes("super"),
	};
}

/**
 * Match input data against a key identifier string.
 *
 * Supported key identifiers:
 * - Single keys: "escape", "tab", "enter", "backspace", "delete", "home", "end", "space"
 * - Arrow keys: "up", "down", "left", "right"
 * - Ctrl combinations: "ctrl+c", "ctrl+z", etc.
 * - Shift combinations: "shift+tab", "shift+enter"
 * - Alt combinations: "alt+enter", "alt+backspace"
 * - Super combinations: "super+k", "super+enter"
 * - Combined modifiers: "shift+ctrl+p", "ctrl+alt+x", "ctrl+super+k"
 *
 * Use the Key helper for autocomplete: Key.ctrl("c"), Key.escape, Key.ctrlShift("p"), Key.super("k")
 *
 * @param data - Raw input data from terminal
 * @param keyId - Key identifier (e.g., "ctrl+c", "escape", Key.ctrl("c"))
 */
export function matchesKey(data: string, keyId: KeyId): boolean {
	const parsed = parseKeyId(keyId);
	if (!parsed) return false;

	const { key, ctrl, shift, alt, super: superModifier } = parsed;
	let modifier = 0;
	if (shift) modifier |= MODIFIERS.shift;
	if (alt) modifier |= MODIFIERS.alt;
	if (ctrl) modifier |= MODIFIERS.ctrl;
	if (superModifier) modifier |= MODIFIERS.super;

	switch (key) {
		case "escape":
		case "esc":
			if (modifier !== 0) return false;
			return (
				data === "\x1b" ||
				matchesKittySequence(data, CODEPOINTS.escape, 0) ||
				matchesModifyOtherKeys(data, CODEPOINTS.escape, 0)
			);

		case "space":
			if (!_kittyProtocolActive) {
				if (modifier === MODIFIERS.ctrl && data === "\x00") {
					return true;
				}
				if (modifier === MODIFIERS.alt && data === "\x1b ") {
					return true;
				}
			}
			if (modifier === 0) {
				return (
					data === " " ||
					matchesKittySequence(data, CODEPOINTS.space, 0) ||
					matchesModifyOtherKeys(data, CODEPOINTS.space, 0)
				);
			}
			return (
				matchesKittySequence(data, CODEPOINTS.space, modifier) ||
				matchesModifyOtherKeys(data, CODEPOINTS.space, modifier)
			);

		case "tab":
			if (modifier === MODIFIERS.shift) {
				return (
					data === "\x1b[Z" ||
					matchesKittySequence(data, CODEPOINTS.tab, MODIFIERS.shift) ||
					matchesModifyOtherKeys(data, CODEPOINTS.tab, MODIFIERS.shift)
				);
			}
			if (modifier === 0) {
				return data === "\t" || matchesKittySequence(data, CODEPOINTS.tab, 0);
			}
			return (
				matchesKittySequence(data, CODEPOINTS.tab, modifier) ||
				matchesModifyOtherKeys(data, CODEPOINTS.tab, modifier)
			);

		case "enter":
		case "return":
			if (modifier === MODIFIERS.shift) {
				// CSI u sequences (standard Kitty protocol)
				if (
					matchesKittySequence(data, CODEPOINTS.enter, MODIFIERS.shift) ||
					matchesKittySequence(data, CODEPOINTS.kpEnter, MODIFIERS.shift)
				) {
					return true;
				}
				// xterm modifyOtherKeys format (fallback when Kitty protocol not enabled)
				if (matchesModifyOtherKeys(data, CODEPOINTS.enter, MODIFIERS.shift)) {
					return true;
				}
				// When Kitty protocol is active, legacy sequences are custom terminal mappings
				// \x1b\r = Kitty's "map shift+enter send_text all \e\r"
				// \n = Ghostty's "keybind = shift+enter=text:\n"
				if (_kittyProtocolActive) {
					return data === "\x1b\r" || data === "\n";
				}
				return false;
			}
			if (modifier === MODIFIERS.alt) {
				// CSI u sequences (standard Kitty protocol)
				if (
					matchesKittySequence(data, CODEPOINTS.enter, MODIFIERS.alt) ||
					matchesKittySequence(data, CODEPOINTS.kpEnter, MODIFIERS.alt)
				) {
					return true;
				}
				// xterm modifyOtherKeys format (fallback when Kitty protocol not enabled)
				if (matchesModifyOtherKeys(data, CODEPOINTS.enter, MODIFIERS.alt)) {
					return true;
				}
				// \x1b\r is alt+enter only in legacy mode (no Kitty protocol)
				// When Kitty protocol is active, alt+enter comes as CSI u sequence
				if (!_kittyProtocolActive) {
					return data === "\x1b\r";
				}
				return false;
			}
			if (modifier === 0) {
				return (
					data === "\r" ||
					(!_kittyProtocolActive && data === "\n") ||
					data === "\x1bOM" || // SS3 M (numpad enter in some terminals)
					matchesKittySequence(data, CODEPOINTS.enter, 0) ||
					matchesKittySequence(data, CODEPOINTS.kpEnter, 0)
				);
			}
			return (
				matchesKittySequence(data, CODEPOINTS.enter, modifier) ||
				matchesKittySequence(data, CODEPOINTS.kpEnter, modifier) ||
				matchesModifyOtherKeys(data, CODEPOINTS.enter, modifier)
			);

		case "backspace":
			if (modifier === MODIFIERS.alt) {
				if (data === "\x1b\x7f" || data === "\x1b\b") {
					return true;
				}
				return (
					matchesKittySequence(data, CODEPOINTS.backspace, MODIFIERS.alt) ||
					matchesModifyOtherKeys(data, CODEPOINTS.backspace, MODIFIERS.alt)
				);
			}
			if (modifier === MODIFIERS.ctrl) {
				// Legacy raw 0x08 is ambiguous: it can be Ctrl+Backspace on Windows
				// Terminal or plain Backspace on other terminals, while also
				// overlapping with Ctrl+H.
				if (matchesRawBackspace(data, MODIFIERS.ctrl)) return true;
				return (
					matchesKittySequence(data, CODEPOINTS.backspace, MODIFIERS.ctrl) ||
					matchesModifyOtherKeys(data, CODEPOINTS.backspace, MODIFIERS.ctrl)
				);
			}
			if (modifier === 0) {
				return (
					matchesRawBackspace(data, 0) ||
					matchesKittySequence(data, CODEPOINTS.backspace, 0) ||
					matchesModifyOtherKeys(data, CODEPOINTS.backspace, 0)
				);
			}
			return (
				matchesKittySequence(data, CODEPOINTS.backspace, modifier) ||
				matchesModifyOtherKeys(data, CODEPOINTS.backspace, modifier)
			);

		case "insert":
			if (modifier === 0) {
				return (
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.insert) ||
					matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.insert, 0)
				);
			}
			if (matchesLegacyModifierSequence(data, "insert", modifier)) {
				return true;
			}
			return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.insert, modifier);

		case "delete":
			if (modifier === 0) {
				return (
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.delete) ||
					matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.delete, 0)
				);
			}
			if (matchesLegacyModifierSequence(data, "delete", modifier)) {
				return true;
			}
			return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.delete, modifier);

		case "clear":
			if (modifier === 0) {
				return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.clear);
			}
			return matchesLegacyModifierSequence(data, "clear", modifier);

		case "home":
			if (modifier === 0) {
				return (
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.home) ||
					matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.home, 0)
				);
			}
			if (matchesLegacyModifierSequence(data, "home", modifier)) {
				return true;
			}
			return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.home, modifier);

		case "end":
			if (modifier === 0) {
				return (
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.end) ||
					matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.end, 0)
				);
			}
			if (matchesLegacyModifierSequence(data, "end", modifier)) {
				return true;
			}
			return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.end, modifier);

		case "pageup":
			if (modifier === 0) {
				return (
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.pageUp) ||
					matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageUp, 0)
				);
			}
			if (matchesLegacyModifierSequence(data, "pageUp", modifier)) {
				return true;
			}
			return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageUp, modifier);

		case "pagedown":
			if (modifier === 0) {
				return (
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.pageDown) ||
					matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageDown, 0)
				);
			}
			if (matchesLegacyModifierSequence(data, "pageDown", modifier)) {
				return true;
			}
			return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageDown, modifier);

		case "up":
			if (modifier === MODIFIERS.alt) {
				return data === "\x1bp" || matchesKittySequence(data, ARROW_CODEPOINTS.up, MODIFIERS.alt);
			}
			if (modifier === 0) {
				return (
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.up) ||
					matchesKittySequence(data, ARROW_CODEPOINTS.up, 0)
				);
			}
			if (matchesLegacyModifierSequence(data, "up", modifier)) {
				return true;
			}
			return matchesKittySequence(data, ARROW_CODEPOINTS.up, modifier);

		case "down":
			if (modifier === MODIFIERS.alt) {
				return data === "\x1bn" || matchesKittySequence(data, ARROW_CODEPOINTS.down, MODIFIERS.alt);
			}
			if (modifier === 0) {
				return (
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.down) ||
					matchesKittySequence(data, ARROW_CODEPOINTS.down, 0)
				);
			}
			if (matchesLegacyModifierSequence(data, "down", modifier)) {
				return true;
			}
			return matchesKittySequence(data, ARROW_CODEPOINTS.down, modifier);

		case "left":
			if (modifier === MODIFIERS.alt) {
				return (
					data === "\x1b[1;3D" ||
					(!_kittyProtocolActive && data === "\x1bB") ||
					data === "\x1bb" ||
					matchesKittySequence(data, ARROW_CODEPOINTS.left, MODIFIERS.alt)
				);
			}
			if (modifier === MODIFIERS.ctrl) {
				return (
					data === "\x1b[1;5D" ||
					matchesLegacyModifierSequence(data, "left", MODIFIERS.ctrl) ||
					matchesKittySequence(data, ARROW_CODEPOINTS.left, MODIFIERS.ctrl)
				);
			}
			if (modifier === 0) {
				return (
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.left) ||
					matchesKittySequence(data, ARROW_CODEPOINTS.left, 0)
				);
			}
			if (matchesLegacyModifierSequence(data, "left", modifier)) {
				return true;
			}
			return matchesKittySequence(data, ARROW_CODEPOINTS.left, modifier);

		case "right":
			if (modifier === MODIFIERS.alt) {
				return (
					data === "\x1b[1;3C" ||
					(!_kittyProtocolActive && data === "\x1bF") ||
					data === "\x1bf" ||
					matchesKittySequence(data, ARROW_CODEPOINTS.right, MODIFIERS.alt)
				);
			}
			if (modifier === MODIFIERS.ctrl) {
				return (
					data === "\x1b[1;5C" ||
					matchesLegacyModifierSequence(data, "right", MODIFIERS.ctrl) ||
					matchesKittySequence(data, ARROW_CODEPOINTS.right, MODIFIERS.ctrl)
				);
			}
			if (modifier === 0) {
				return (
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.right) ||
					matchesKittySequence(data, ARROW_CODEPOINTS.right, 0)
				);
			}
			if (matchesLegacyModifierSequence(data, "right", modifier)) {
				return true;
			}
			return matchesKittySequence(data, ARROW_CODEPOINTS.right, modifier);

		case "f1":
		case "f2":
		case "f3":
		case "f4":
		case "f5":
		case "f6":
		case "f7":
		case "f8":
		case "f9":
		case "f10":
		case "f11":
		case "f12": {
			if (modifier !== 0) {
				return false;
			}
			const functionKey = key as keyof typeof LEGACY_KEY_SEQUENCES;
			return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES[functionKey]);
		}
	}

	// Handle single letter/digit keys and symbols
	if (key.length === 1 && ((key >= "a" && key <= "z") || isDigitKey(key) || SYMBOL_KEYS.has(key))) {
		const codepoint = key.charCodeAt(0);
		const rawCtrl = rawCtrlChar(key);
		const isLetter = key >= "a" && key <= "z";
		const isDigit = isDigitKey(key);

		if (modifier === MODIFIERS.ctrl + MODIFIERS.alt && !_kittyProtocolActive && rawCtrl) {
			// Legacy: ctrl+alt+key is ESC followed by the control character.
			// If that legacy form does not match, continue so CSI-u and
			// modifyOtherKeys sequences from tmux can still be recognized.
			if (data === `\x1b${rawCtrl}`) return true;
		}

		if (modifier === MODIFIERS.alt && !_kittyProtocolActive && (isLetter || isDigit)) {
			// Legacy: alt+letter/digit is ESC followed by the key
			if (data === `\x1b${key}`) return true;
		}

		if (modifier === MODIFIERS.ctrl) {
			// Legacy: ctrl+key sends the control character
			if (rawCtrl && data === rawCtrl) return true;
			return (
				matchesKittySequence(data, codepoint, MODIFIERS.ctrl) ||
				matchesPrintableModifyOtherKeys(data, codepoint, MODIFIERS.ctrl)
			);
		}

		if (modifier === MODIFIERS.shift + MODIFIERS.ctrl) {
			return (
				matchesKittySequence(data, codepoint, MODIFIERS.shift + MODIFIERS.ctrl) ||
				matchesPrintableModifyOtherKeys(data, codepoint, MODIFIERS.shift + MODIFIERS.ctrl)
			);
		}

		if (modifier === MODIFIERS.shift) {
			// Legacy: shift+letter produces uppercase
			if (isLetter && data === key.toUpperCase()) return true;
			return (
				matchesKittySequence(data, codepoint, MODIFIERS.shift) ||
				matchesPrintableModifyOtherKeys(data, codepoint, MODIFIERS.shift)
			);
		}

		if (modifier !== 0) {
			return (
				matchesKittySequence(data, codepoint, modifier) ||
				matchesPrintableModifyOtherKeys(data, codepoint, modifier)
			);
		}

		// Check both raw char and Kitty sequence (needed for release events)
		return data === key || matchesKittySequence(data, codepoint, 0);
	}

	return false;
}

/**
 * Parse input data and return the key identifier if recognized.
 *
 * @param data - Raw input data from terminal
 * @returns Key identifier string (e.g., "ctrl+c") or undefined
 */
function formatParsedKey(codepoint: number, modifier: number, baseLayoutKey?: number): string | undefined {
	const normalizedCodepoint = normalizeKittyFunctionalCodepoint(codepoint);
	const identityCodepoint = normalizeShiftedLetterIdentityCodepoint(normalizedCodepoint, modifier);

	// Use base layout key only when codepoint is not a recognized Latin
	// letter (a-z), digit (0-9), or symbol (/, -, [, ;, etc.). For those,
	// the codepoint is authoritative regardless of physical key position.
	// This prevents remapped layouts (Dvorak, Colemak, xremap, etc.) from
	// reporting the wrong key name based on the QWERTY physical position.
	const isLatinLetter = identityCodepoint >= 97 && identityCodepoint <= 122; // a-z
	const isDigit = identityCodepoint >= 48 && identityCodepoint <= 57; // 0-9
	const isKnownSymbol = SYMBOL_KEYS.has(String.fromCharCode(identityCodepoint));
	const effectiveCodepoint =
		isLatinLetter || isDigit || isKnownSymbol ? identityCodepoint : (baseLayoutKey ?? identityCodepoint);

	let keyName: string | undefined;
	if (effectiveCodepoint === CODEPOINTS.escape) keyName = "escape";
	else if (effectiveCodepoint === CODEPOINTS.tab) keyName = "tab";
	else if (effectiveCodepoint === CODEPOINTS.enter || effectiveCodepoint === CODEPOINTS.kpEnter) keyName = "enter";
	else if (effectiveCodepoint === CODEPOINTS.space) keyName = "space";
	else if (effectiveCodepoint === CODEPOINTS.backspace) keyName = "backspace";
	else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.delete) keyName = "delete";
	else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.insert) keyName = "insert";
	else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.home) keyName = "home";
	else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.end) keyName = "end";
	else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.pageUp) keyName = "pageUp";
	else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.pageDown) keyName = "pageDown";
	else if (effectiveCodepoint === ARROW_CODEPOINTS.up) keyName = "up";
	else if (effectiveCodepoint === ARROW_CODEPOINTS.down) keyName = "down";
	else if (effectiveCodepoint === ARROW_CODEPOINTS.left) keyName = "left";
	else if (effectiveCodepoint === ARROW_CODEPOINTS.right) keyName = "right";
	else if (effectiveCodepoint >= 48 && effectiveCodepoint <= 57) keyName = String.fromCharCode(effectiveCodepoint);
	else if (effectiveCodepoint >= 97 && effectiveCodepoint <= 122) keyName = String.fromCharCode(effectiveCodepoint);
	else if (SYMBOL_KEYS.has(String.fromCharCode(effectiveCodepoint))) keyName = String.fromCharCode(effectiveCodepoint);

	if (!keyName) return undefined;
	return formatKeyNameWithModifiers(keyName, modifier);
}

export function parseKey(data: string): string | undefined {
	const kitty = parseKittySequence(data);
	if (kitty) {
		return formatParsedKey(kitty.codepoint, kitty.modifier, kitty.baseLayoutKey);
	}

	const modifyOtherKeys = parseModifyOtherKeysSequence(data);
	if (modifyOtherKeys) {
		return formatParsedKey(modifyOtherKeys.codepoint, modifyOtherKeys.modifier);
	}

	// Mode-aware legacy sequences
	// When Kitty protocol is active, ambiguous sequences are interpreted as custom terminal mappings:
	// - \x1b\r = shift+enter (Kitty mapping), not alt+enter
	// - \n = shift+enter (Ghostty mapping)
	if (_kittyProtocolActive) {
		if (data === "\x1b\r" || data === "\n") return "shift+enter";
	}

	const legacySequenceKeyId = LEGACY_SEQUENCE_KEY_IDS[data];
	if (legacySequenceKeyId) return legacySequenceKeyId;

	// Legacy sequences (used when Kitty protocol is not active, or for unambiguous sequences)
	if (data === "\x1b") return "escape";
	if (data === "\x1c") return "ctrl+\\";
	if (data === "\x1d") return "ctrl+]";
	if (data === "\x1f") return "ctrl+-";
	if (data === "\x1b\x1b") return "ctrl+alt+[";
	if (data === "\x1b\x1c") return "ctrl+alt+\\";
	if (data === "\x1b\x1d") return "ctrl+alt+]";
	if (data === "\x1b\x1f") return "ctrl+alt+-";
	if (data === "\t") return "tab";
	if (data === "\r" || (!_kittyProtocolActive && data === "\n") || data === "\x1bOM") return "enter";
	if (data === "\x00") return "ctrl+space";
	if (data === " ") return "space";
	if (data === "\x7f") return "backspace";
	if (data === "\x08") return isWindowsTerminalSession() ? "ctrl+backspace" : "backspace";
	if (data === "\x1b[Z") return "shift+tab";
	if (!_kittyProtocolActive && data === "\x1b\r") return "alt+enter";
	if (!_kittyProtocolActive && data === "\x1b ") return "alt+space";
	if (data === "\x1b\x7f" || data === "\x1b\b") return "alt+backspace";
	if (!_kittyProtocolActive && data === "\x1bB") return "alt+left";
	if (!_kittyProtocolActive && data === "\x1bF") return "alt+right";
	if (!_kittyProtocolActive && data.length === 2 && data[0] === "\x1b") {
		const code = data.charCodeAt(1);
		if (code >= 1 && code <= 26) {
			return `ctrl+alt+${String.fromCharCode(code + 96)}`;
		}
		// Legacy alt+letter/digit (ESC followed by the key)
		if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) {
			return `alt+${String.fromCharCode(code)}`;
		}
	}
	if (data === "\x1b[A") return "up";
	if (data === "\x1b[B") return "down";
	if (data === "\x1b[C") return "right";
	if (data === "\x1b[D") return "left";
	if (data === "\x1b[H" || data === "\x1bOH") return "home";
	if (data === "\x1b[F" || data === "\x1bOF") return "end";
	if (data === "\x1b[3~") return "delete";
	if (data === "\x1b[5~") return "pageUp";
	if (data === "\x1b[6~") return "pageDown";

	// Raw Ctrl+letter
	if (data.length === 1) {
		const code = data.charCodeAt(0);
		if (code >= 1 && code <= 26) {
			return `ctrl+${String.fromCharCode(code + 96)}`;
		}
		if (code >= 32 && code <= 126) {
			return data;
		}
	}

	return undefined;
}
