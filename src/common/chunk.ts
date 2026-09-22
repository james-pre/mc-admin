import { decompress } from './buffers.js';
import type { Tag } from './nbt.js';

export enum Compression {
	GZip = 1,
	ZLib = 2,
	None = 3,
	LZ4 = 4,
	Custom = 127,
}

/** Set on a chunk's compression byte when its payload lives in a `c.<x>.<z>.mcc` file instead. */
export const externalFlag = 0x80;

/** Where a chunk sits in the file, from the header alone. */
export interface Entry {
	/** The chunk's index in the header, `x + z * 32`. */
	index: number;
	/** Chunk coordinates within the region, 0 to 31. */
	x: number;
	z: number;
	/** Byte offset of the chunk's record. */
	offset: number;
	/** Length of the chunk's allocation, in sectors. */
	sectors: number;
	/** When the chunk was last written, in epoch seconds; 0 if it never was. */
	timestamp: number;
}

export interface Raw extends Entry {
	compression: Compression;
	/** The payload is in a `c.<x>.<z>.mcc` file next to the region, and `data` is empty. */
	external: boolean;
	/** The still-compressed NBT payload. */
	data: Uint8Array<ArrayBuffer>;
}

export interface Parsed extends Raw {
	tag: Tag;
}

const formats: Partial<Record<Compression, 'gzip' | 'deflate'>> = {
	[Compression.GZip]: 'gzip',
	[Compression.ZLib]: 'deflate',
};

/**
 * Decompress a chunk's NBT payload.
 *
 * @throws When the chunk is external, or compressed with a scheme this can't undo — LZ4 and the
 * `Custom` escape hatch, both of which only a modded server writes.
 */
export async function payload(chunk: Raw): Promise<Uint8Array<ArrayBuffer>> {
	if (chunk.external) throw new Error(`chunk ${chunk.x},${chunk.z} is stored externally`);
	if (chunk.compression === Compression.None) return chunk.data;
	const format = formats[chunk.compression];
	if (!format)
		throw new Error(
			`chunk ${chunk.x},${chunk.z} uses unsupported compression (${Compression[chunk.compression] ?? chunk.compression})`,
		);
	return await decompress(chunk.data, format);
}
