export * from './common/snbt.js';
import { styleText, type InspectColor } from 'node:util';
import { TagType, type Tag, type TagOf } from './common/nbt.js';
import { arrayMarkers, tagSuffixes, escapes } from './common/snbt.js';

export const colors: Record<'name' | 'string' | 'number' | 'suffix', InspectColor> = {
	name: 'cyan',
	string: 'green',
	number: 'yellow',
	suffix: 'red',
};

/** `escapes` read backwards: the letter to write for each character that needs one. */
const escaped = new Map(
	Object.entries(escapes)
		.filter(([letter]) => letter != 's')
		.map(([letter, char]) => [char, letter] as const)
);

/**
 * A string is always enclosed by double or single quotes.
 * If the string does not contain any quote marks, double quotes are used.
 * If the string contains a double quote then single quotes are used, and vice versa.
 * If the string contains both then the opposite of the first instance of either in the string is used
 * (e.g. if a " appears before a ' then the string will be enclosed in single quotes)
 * @see https://minecraft.wiki/w/NBT_format#Conversion_to_SNBT
 */
export function escapeString(value: string): string {
	const double = value.indexOf('"'),
		single = value.indexOf("'");
	const quote = double == -1 ? '"' : single == -1 ? "'" : double < single ? "'" : '"';

	let out = quote;
	for (const char of value) {
		if (char == '\\' || char == quote) {
			out += '\\' + char;
			continue;
		}
		const escape = escaped.get(char);
		if (escape) {
			out += '\\' + escape;
			continue;
		}
		const code = char.codePointAt(0)!;
		out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? '\\u' + code.toString(16).padStart(4, '0') : char;
	}
	return out + quote;
}

const isArrayTag = (tag: Tag): tag is TagOf<TagType.ByteArray> | TagOf<TagType.IntArray> | TagOf<TagType.LongArray> =>
	tag.type in arrayMarkers;

function num(value: number | bigint, suffix?: string): string {
	const decimal = suffix === 'f' || suffix === 'd';
	const text = decimal && Number.isInteger(value) ? Number(value).toFixed(1) : String(value);
	return styleText(colors.number, text) + (suffix ? styleText(colors.suffix, suffix) : '');
}

export function format(tag: Tag): string {
	if (tag.type == TagType.String) return styleText(colors.string, escapeString(tag.value));

	if (tag.type == TagType.Compound) {
		const entries = Array.from(tag.value).map(([key, child]) => `${styleText(colors.name, key)}:${format(child)}`);
		return `{${entries.join(',')}}`;
	}

	if (tag.type == TagType.List) return `[${tag.value.map(v => format(v)).join(',')}]`;

	if (isArrayTag(tag)) {
		const [marker, suffix] = arrayMarkers[tag.type];
		const items = [...tag.value].map(item => num(item, suffix));
		return `[${styleText(colors.suffix, marker)};${items.join(',')}]`;
	}

	return num(tag.value, tagSuffixes[tag.type as keyof typeof tagSuffixes] ?? '');
}
