import type { Compound, Tag } from './nbt.js';
import { TagType } from './nbt.js';

export interface ParseOptions {
	/**
	 * Accept unquoted words as string values, e.g. `{id:stone}`.
	 *
	 * Off by default, because {@link scan} relies on the strictness: without it, Brigadier's
	 * parse-error pointer `<--[HERE]` reads as a one-element list of the string `HERE` and gets
	 * treated like data. Minecraft always quotes the strings it prints, so nothing is lost.
	 */
	bareStrings?: boolean;
}

export class SnbtError extends SyntaxError {
	public constructor(
		message: string,
		/** Index into the source where parsing gave up. */
		public readonly position: number
	) {
		super(`${message} (at ${position})`);
		this.name = 'SnbtError';
	}
}

// Sticky, so they match at the cursor without slicing the source apart.
const numberPattern = /([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)([bslfdBSLFD]?)/y;
const wordPattern = /[A-Za-z0-9_.+-]+/y;
const arrayPattern = /([BIL]);/y;
const booleanPattern = /true|false/y;

// A bare number or word runs until the first character that can't be part of one.
const wordChar = /[A-Za-z0-9_.+-]/;
const integer = /^[-+]?\d+$/;
const hex = /^[0-9a-fA-F]{4}$/;

/** @internal */
export const escapes: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', s: ' ', t: '\t' };

/** @internal */
export const suffixes: Record<string, TagType> = {
	b: TagType.Byte,
	s: TagType.Short,
	l: TagType.Long,
	f: TagType.Float,
	d: TagType.Double,
};

/** @internal */
export class Parser {
	public offset = 0;
	protected readonly bareStrings: boolean;

	public constructor(
		protected readonly source: string,
		options: ParseOptions = {}
	) {
		this.bareStrings = options.bareStrings ?? false;
	}

	protected error(message: string, position: number = this.offset): never {
		throw new SnbtError(message, position);
	}

	protected get current(): string {
		return this.source.charAt(this.offset);
	}

	protected skipSpace(): void {
		while (/\s/.test(this.current)) this.offset++;
	}

	protected take(literal: string): boolean {
		if (!this.source.startsWith(literal, this.offset)) return false;
		this.offset += literal.length;
		return true;
	}

	protected expect(literal: string): void {
		if (!this.take(literal)) this.error(`expected "${literal}"`);
	}

	protected match(pattern: RegExp): RegExpExecArray | null {
		pattern.lastIndex = this.offset;
		return pattern.exec(this.source);
	}

	/** True when the character after a `length`-long match would continue the word. */
	protected continues(length: number): boolean {
		return wordChar.test(this.source.charAt(this.offset + length));
	}

	/** The character(s) a backslash stands for. */
	protected escape(): string {
		const start = this.offset;
		const char = this.source.charAt(this.offset++);
		if (char === '\\' || char === '"' || char === "'") return char;
		const mapped = escapes[char];
		if (mapped) return mapped;
		if (char === 'u') {
			const digits = this.source.slice(this.offset, this.offset + 4);
			if (!hex.test(digits)) this.error('invalid unicode escape', start);
			this.offset += 4;
			return String.fromCharCode(parseInt(digits, 16));
		}
		this.error(`invalid escape "\\${char}"`, start);
	}

	/** A quoted string, or null when the cursor isn't on a quote. */
	protected quoted(): string | null {
		const quote = this.current;
		if (quote !== '"' && quote !== "'") return null;
		const start = this.offset++;
		let value = '';
		while (this.offset < this.source.length) {
			const char = this.source.charAt(this.offset++);
			if (char === quote) return value;
			if (char !== '\\') {
				value += char;
				continue;
			}
			value += this.escape();
		}
		this.error('unterminated string', start);
	}

	/** A compound key: quoted, or a bare word. */
	protected key(): string {
		const quoted = this.quoted();
		if (quoted !== null) return quoted;
		const match = this.match(wordPattern);
		if (!match) this.error('expected a key');
		this.offset += match[0].length;
		return match[0];
	}

	/** A number with its optional type suffix, or null when the cursor isn't on one. */
	protected number(): Tag | null {
		const match = this.match(numberPattern);
		if (!match) return null;
		const [text, digits, suffix] = match;
		// `1.5x` isn't a number followed by a word; the whole run is one word.
		if (this.continues(text.length)) return null;
		const start = this.offset;
		this.offset += text.length;
		return this.numeric(digits, suffix, start);
	}

	/** `true` and `false` are how the game prints bytes it knows are flags. */
	protected boolean(): Tag | null {
		const match = this.match(booleanPattern);
		if (!match || this.continues(match[0].length)) return null;
		this.offset += match[0].length;
		return { type: TagType.Byte, value: match[0] === 'true' ? 1 : 0 };
	}

	/** An unsuffixed number is an int, or a double once it has a fraction or an exponent. */
	protected numeric(digits: string, suffix: string, position: number): Tag {
		const type = suffix ? suffixes[suffix.toLowerCase()] : /[.eE]/.test(digits) ? TagType.Double : TagType.Int;

		switch (type) {
			case TagType.Byte:
				return { type: TagType.Byte, value: this.whole(digits, position) };
			case TagType.Short:
				return { type: TagType.Short, value: this.whole(digits, position) };
			case TagType.Int:
				return { type: TagType.Int, value: this.whole(digits, position) };
			case TagType.Long:
				return { type: TagType.Long, value: BigInt(this.whole(digits, position)) };
			case TagType.Float:
				return { type: TagType.Float, value: Number(digits) };
			default:
				return { type: TagType.Double, value: Number(digits) };
		}
	}

	/** Integer types reject a fractional or exponential literal, e.g. `1.5b`. */
	protected whole(digits: string, position: number): number {
		if (!integer.test(digits)) this.error(`"${digits}" is not an integer`, position);
		return Number(digits);
	}

	/** The integer an array item carries, whatever suffix it was written with. */
	protected arrayItem(tag: Tag, position: number): bigint {
		switch (tag.type) {
			case TagType.Byte:
			case TagType.Short:
			case TagType.Int:
				return BigInt(tag.value);
			case TagType.Long:
				return tag.value;
			default:
				this.error(`expected an integer, got a ${TagType[tag.type]}`, position);
		}
	}

	protected compound(): Tag {
		this.expect('{');
		const value: Compound = new Map();
		this.skipSpace();
		if (this.take('}')) return { type: TagType.Compound, value };
		for (;;) {
			this.skipSpace();
			const key = this.key();
			this.skipSpace();
			this.expect(':');
			this.skipSpace();
			value.set(key, this.value());
			this.skipSpace();
			if (this.take(',')) continue;
			this.expect('}');
			return { type: TagType.Compound, value };
		}
	}

	/** A list, or one of the typed arrays that lead with their element type: `[I; 1, 2]`. */
	protected list(): Tag {
		this.expect('[');
		const array = this.match(arrayPattern);
		if (array) {
			this.offset += array[0].length;
			return this.array(array[1]);
		}

		const value: Tag[] = [];
		this.skipSpace();
		if (this.take(']')) return { type: TagType.List, of: TagType.End, value };
		for (;;) {
			this.skipSpace();
			const start = this.offset;
			const item = this.value();
			// Lists are homogeneous; the binary format has nowhere to put a second element type.
			if (value.length && item.type !== value[0].type) this.error(`expected a ${TagType[value[0].type]} item`, start);
			value.push(item);
			this.skipSpace();
			if (this.take(',')) continue;
			this.expect(']');
			return { type: TagType.List, of: value[0].type, value };
		}
	}

	/** The body of `[B;…]`, `[I;…]` or `[L;…]`, whose marker has already been consumed. */
	protected array(marker: string): Tag {
		const items: bigint[] = [];
		this.skipSpace();
		if (!this.take(']'))
			for (;;) {
				this.skipSpace();
				const start = this.offset;
				items.push(this.arrayItem(this.value(), start));
				this.skipSpace();
				if (this.take(',')) continue;
				this.expect(']');
				break;
			}

		switch (marker) {
			case 'B':
				return { type: TagType.ByteArray, value: Int8Array.from(items, Number) };
			case 'I':
				return { type: TagType.IntArray, value: Int32Array.from(items, Number) };
			default:
				return { type: TagType.LongArray, value: BigInt64Array.from(items) };
		}
	}

	public value(): Tag {
		const char = this.current;
		if (char === '{') return this.compound();
		if (char === '[') return this.list();

		const quoted = this.quoted();
		if (quoted !== null) return { type: TagType.String, value: quoted };

		const tag = this.boolean() ?? this.number();
		if (tag) return tag;

		if (this.bareStrings) {
			const match = this.match(wordPattern);
			if (match) {
				this.offset += match[0].length;
				return { type: TagType.String, value: match[0] };
			}
		}

		this.error('expected a value');
	}

	/** One value and nothing else, ignoring the whitespace around it. */
	public document(): Tag {
		this.skipSpace();
		const tag = this.value();
		this.skipSpace();
		if (this.offset < this.source.length) this.error('unexpected trailing input');
		return tag;
	}
}

/**
 * Parse a whole SNBT document.
 *
 * @throws SnbtError when the source isn't well-formed SNBT.
 */
export function parse(source: string, options?: ParseOptions): Tag {
	return new Parser(source, options).document();
}

export interface Span {
	/** Index of the value's first character. */
	start: number;
	/** Index just past its last character. */
	end: number;
	tag: Tag;
}

/**
 * Parse the value starting at `start`, returning it with the index just past it, or null when
 * what's there isn't well-formed SNBT. Unlike {@link parse}, trailing text is fine.
 */
export function parseAt(source: string, start = 0, options?: ParseOptions): Span | null {
	const parser = new Parser(source, options);
	parser.offset = start;
	try {
		const tag = parser.value();
		return { start, end: parser.offset, tag };
	} catch (error) {
		if (error instanceof SnbtError) return null;
		throw error;
	}
}

/**
 * Find the SNBT embedded in prose.
 */
export function* scan(text: string): Generator<Span> {
	let offset = 0;
	while (offset < text.length) {
		const char = text.charAt(offset);
		if (char === '{' || char === '[') {
			const span = parseAt(text, offset);
			if (span) {
				yield span;
				offset = span.end;
				continue;
			}
		}
		offset++;
	}
}
