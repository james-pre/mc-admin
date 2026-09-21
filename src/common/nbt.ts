import { decodeUTF8 } from 'utilium';
import { decompress, toBytes } from './buffers.js';

export enum TagType {
	End = 0,
	Byte = 1,
	Short = 2,
	Int = 3,
	Long = 4,
	Float = 5,
	Double = 6,
	ByteArray = 7,
	String = 8,
	List = 9,
	Compound = 10,
	IntArray = 11,
	LongArray = 12,
}

/** A compound's children, keyed by tag name. */
export type Compound = Map<string, Tag>;

/** The value carried by a tag of each type. */
export interface TagValues {
	[TagType.End]: never;
	[TagType.Byte]: number;
	[TagType.Short]: number;
	[TagType.Int]: number;
	[TagType.Long]: bigint;
	[TagType.Float]: number;
	[TagType.Double]: number;
	[TagType.ByteArray]: Int8Array;
	[TagType.String]: string;
	[TagType.List]: Tag[];
	[TagType.Compound]: Compound;
	[TagType.IntArray]: Int32Array;
	[TagType.LongArray]: BigInt64Array;
}

export interface TagOf<T extends TagType> {
	type: T;
	value: TagValues[T];
}

export interface ListTag extends TagOf<TagType.List> {
	/** The type shared by every item. `End` when the list is empty. */
	of: TagType;
}

/** Every type that can appear as a value. `End` only ever terminates a compound. */
export type ValueType = Exclude<TagType, TagType.End | TagType.List>;

export type Tag = { [T in ValueType]: TagOf<T> }[ValueType] | ListTag;

/** A root tag together with its name, which is usually empty. */
export interface Named {
	name: string;
	tag: Tag;
}

/**
 * Walks an NBT payload one tag at a time.
 * @internal
 */
export class Reader {
	protected readonly view: DataView;
	protected readonly bytes: Uint8Array;
	public offset = 0;

	public constructor(data: BufferSource) {
		this.bytes = toBytes(data);
		this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
	}

	protected int8(): number {
		return this.view.getInt8(this.offset++);
	}

	protected uint8(): number {
		return this.view.getUint8(this.offset++);
	}

	protected int16(): number {
		const value = this.view.getInt16(this.offset);
		this.offset += 2;
		return value;
	}

	protected int32(): number {
		const value = this.view.getInt32(this.offset);
		this.offset += 4;
		return value;
	}

	protected int64(): bigint {
		const value = this.view.getBigInt64(this.offset);
		this.offset += 8;
		return value;
	}

	protected float32(): number {
		const value = this.view.getFloat32(this.offset);
		this.offset += 4;
		return value;
	}

	protected float64(): number {
		const value = this.view.getFloat64(this.offset);
		this.offset += 8;
		return value;
	}

	/** A length-prefixed name or string value. */
	public string(): string {
		const length = this.view.getUint16(this.offset);
		this.offset += 2;
		if (this.offset + length > this.bytes.byteLength) throw new RangeError(`string runs past the end of the payload at ${this.offset}`);
		const value = decodeUTF8(this.bytes.subarray(this.offset, this.offset + length));
		this.offset += length;
		return value;
	}

	/** The type byte introducing the next tag. */
	public type(): TagType {
		const type = this.uint8();
		if (!(type in TagType)) throw new TypeError(`bad tag ${type} at ${this.offset - 1}`);
		return type;
	}

	/** The body of a tag whose type byte has already been read. */
	public tag(type: TagType): Tag {
		switch (type) {
			case TagType.Byte:
				return { type, value: this.int8() };
			case TagType.Short:
				return { type, value: this.int16() };
			case TagType.Int:
				return { type, value: this.int32() };
			case TagType.Long:
				return { type, value: this.int64() };
			case TagType.Float:
				return { type, value: this.float32() };
			case TagType.Double:
				return { type, value: this.float64() };
			case TagType.ByteArray: {
				const length = this.int32();
				if (this.offset + length > this.bytes.byteLength) throw new RangeError(`byte array runs past the end of the payload`);
				const value = new Int8Array(this.bytes.slice(this.offset, this.offset + length).buffer);
				this.offset += length;
				return { type, value };
			}
			case TagType.String:
				return { type, value: this.string() };
			case TagType.List: {
				const of = this.type();
				const length = this.int32();
				const value: Tag[] = [];
				if (of !== TagType.End) for (let i = 0; i < length; i++) value.push(this.tag(of));
				return { type, of, value };
			}
			case TagType.Compound: {
				const value: Compound = new Map();
				for (let child = this.type(); child !== TagType.End; child = this.type()) {
					const name = this.string();
					value.set(name, this.tag(child));
				}
				return { type, value };
			}
			case TagType.IntArray: {
				const length = this.int32();
				const value = new Int32Array(length);
				for (let i = 0; i < length; i++) value[i] = this.int32();
				return { type, value };
			}
			case TagType.LongArray: {
				const length = this.int32();
				const value = new BigInt64Array(length);
				for (let i = 0; i < length; i++) value[i] = this.int64();
				return { type, value };
			}
			default:
				throw new TypeError(`${TagType[type]} is not a value at ${this.offset - 1}`);
		}
	}
}

/** Parse an uncompressed NBT payload. */
export function parse(data: BufferSource): Named {
	const reader = new Reader(data);
	const type = reader.type();
	if (type === TagType.End) throw new TypeError('payload is empty');
	return { name: reader.string(), tag: reader.tag(type) };
}

/**
 * Parse an NBT file, decompressing it first when it needs it.
 */
export async function parseCompressed(data: BufferSource): Promise<Named> {
	const bytes = toBytes(data);
	if (bytes[0] === 0x1f && bytes[1] === 0x8b) return parse(await decompress(bytes, 'gzip'));
	if (bytes[0] === 0x78) return parse(await decompress(bytes, 'deflate'));
	return parse(bytes);
}

/**
 * Follow a path of compound keys and list indices, giving up rather than throwing when any step
 * is missing or the wrong type.
 */
export function get(tag: Tag | null, ...path: (string | number)[]): Tag | null {
	let current = tag;
	for (const key of path) {
		if (!current) return null;
		if (typeof key === 'number') {
			if (current.type !== TagType.List) return null;
			current = current.value[key];
			continue;
		}
		if (current.type !== TagType.Compound) return null;
		current = current.value.get(key) ?? null;
	}
	return current;
}
