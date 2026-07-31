// =============================================================================
// Constants
// =============================================================================

export const SYMBOL_KEYS = new Set([
	"`",
	"-",
	"=",
	"[",
	"]",
	"\\",
	";",
	"'",
	",",
	".",
	"/",
	"!",
	"@",
	"#",
	"$",
	"%",
	"^",
	"&",
	"*",
	"(",
	")",
	"_",
	"+",
	"|",
	"~",
	"{",
	"}",
	":",
	"<",
	">",
	"?",
]);

export const MODIFIERS = {
	shift: 1,
	alt: 2,
	ctrl: 4,
	super: 8,
} as const;

export const LOCK_MASK = 64 + 128; // Caps Lock + Num Lock

export const CODEPOINTS = {
	escape: 27,
	tab: 9,
	enter: 13,
	space: 32,
	backspace: 127,
	kpEnter: 57414, // Numpad Enter (Kitty protocol)
} as const;

export const ARROW_CODEPOINTS = {
	up: -1,
	down: -2,
	right: -3,
	left: -4,
} as const;

export const FUNCTIONAL_CODEPOINTS = {
	delete: -10,
	insert: -11,
	pageUp: -12,
	pageDown: -13,
	home: -14,
	end: -15,
} as const;

const KITTY_FUNCTIONAL_KEY_EQUIVALENTS = new Map<number, number>([
	[57399, 48], // KP_0 -> 0
	[57400, 49], // KP_1 -> 1
	[57401, 50], // KP_2 -> 2
	[57402, 51], // KP_3 -> 3
	[57403, 52], // KP_4 -> 4
	[57404, 53], // KP_5 -> 5
	[57405, 54], // KP_6 -> 6
	[57406, 55], // KP_7 -> 7
	[57407, 56], // KP_8 -> 8
	[57408, 57], // KP_9 -> 9
	[57409, 46], // KP_DECIMAL -> .
	[57410, 47], // KP_DIVIDE -> /
	[57411, 42], // KP_MULTIPLY -> *
	[57412, 45], // KP_SUBTRACT -> -
	[57413, 43], // KP_ADD -> +
	[57415, 61], // KP_EQUAL -> =
	[57416, 44], // KP_SEPARATOR -> ,
	[57417, ARROW_CODEPOINTS.left],
	[57418, ARROW_CODEPOINTS.right],
	[57419, ARROW_CODEPOINTS.up],
	[57420, ARROW_CODEPOINTS.down],
	[57421, FUNCTIONAL_CODEPOINTS.pageUp],
	[57422, FUNCTIONAL_CODEPOINTS.pageDown],
	[57423, FUNCTIONAL_CODEPOINTS.home],
	[57424, FUNCTIONAL_CODEPOINTS.end],
	[57425, FUNCTIONAL_CODEPOINTS.insert],
	[57426, FUNCTIONAL_CODEPOINTS.delete],
]);

export function normalizeKittyFunctionalCodepoint(codepoint: number): number {
	return KITTY_FUNCTIONAL_KEY_EQUIVALENTS.get(codepoint) ?? codepoint;
}

export function normalizeShiftedLetterIdentityCodepoint(codepoint: number, modifier: number): number {
	const effectiveModifier = modifier & ~LOCK_MASK;
	if ((effectiveModifier & MODIFIERS.shift) !== 0 && codepoint >= 65 && codepoint <= 90) {
		return codepoint + 32;
	}
	return codepoint;
}
