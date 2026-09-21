import { decompress, toBytes } from './buffers.js';
import type { Tag } from './nbt.js';
import { parse } from './nbt.js';

/** Region files are addressed in 4 KiB sectors. */
export const sectorSize = 4096;

/** Chunks per region, per axis. */
export const regionSize = 32;

/** Chunks per region. */
export const chunkCount = regionSize * regionSize;

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
export interface ChunkEntry {
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

export interface RawChunk extends ChunkEntry {
	compression: Compression;
	/** The payload is in a `c.<x>.<z>.mcc` file next to the region, and `data` is empty. */
	external: boolean;
	/** The still-compressed NBT payload. */
	data: Uint8Array<ArrayBuffer>;
}

export interface Chunk extends RawChunk {
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
export async function payload(chunk: RawChunk): Promise<Uint8Array<ArrayBuffer>> {
	if (chunk.external) throw new Error(`chunk ${chunk.x},${chunk.z} is stored externally`);
	if (chunk.compression === Compression.None) return chunk.data;
	const format = formats[chunk.compression];
	if (!format)
		throw new Error(
			`chunk ${chunk.x},${chunk.z} uses unsupported compression (${Compression[chunk.compression] ?? chunk.compression})`
		);
	return await decompress(chunk.data, format);
}

const namePattern = /^r\.(-?\d+)\.(-?\d+)\.mca$/;

/** The region coordinates a file name encodes, or null if it isn't a region file. */
export function parseName(name: string): { x: number; z: number } | null {
	const match = namePattern.exec(name);
	return match ? { x: Number(match[1]), z: Number(match[2]) } : null;
}

export class Region {
	public readonly data: Uint8Array<ArrayBuffer>;
	protected readonly view: DataView;

	public constructor(data: BufferSource) {
		this.data = toBytes(data);
		this.view = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
	}

	/**
	 * Whether the file is too short to hold the header.
	 *
	 * The server creates region files before it has anything to put in them, so a zero-length or
	 * truncated file is normal rather than damage.
	 */
	public get empty(): boolean {
		return this.data.byteLength < sectorSize * 2;
	}

	/** Where chunk `index` lives, or null when the region has never stored it. */
	public entry(index: number): ChunkEntry | null {
		if (index < 0 || index >= chunkCount) throw new RangeError(`chunk index ${index} is outside the region`);
		if (this.empty) return null;

		// A location packs a 3-byte sector offset with a 1-byte sector count.
		const location = this.view.getUint32(index * 4);
		if (location === 0) return null;

		return {
			index,
			x: index % regionSize,
			z: Math.floor(index / regionSize),
			offset: (location >>> 8) * sectorSize,
			sectors: location & 0xff,
			timestamp: this.view.getInt32(sectorSize + index * 4),
		};
	}

	/** Where the chunk at region-local coordinates lives, or null when the region lacks it. */
	public at(x: number, z: number): ChunkEntry | null {
		return this.entry(x + z * regionSize);
	}

	/** Every chunk the region actually stores. */
	public *entries(): Generator<ChunkEntry> {
		for (let index = 0; index < chunkCount; index++) {
			const entry = this.entry(index);
			if (entry) yield entry;
		}
	}

	/**
	 * A chunk's record, still compressed.
	 *
	 * @throws When the header points outside the file, which means the region is truncated.
	 */
	public raw(entry: ChunkEntry): RawChunk {
		const { offset } = entry;
		if (offset + 5 > this.data.byteLength) throw new RangeError(`chunk ${entry.x},${entry.z} starts past the end of the region`);

		// The stored length counts the compression byte that follows it.
		const end = offset + 4 + this.view.getUint32(offset);
		if (end > this.data.byteLength) throw new RangeError(`chunk ${entry.x},${entry.z} runs past the end of the region`);

		const flags = this.view.getUint8(offset + 4);
		return {
			...entry,
			compression: flags & ~externalFlag,
			external: (flags & externalFlag) !== 0,
			data: this.data.subarray(offset + 5, end),
		};
	}

	/** A chunk's NBT. */
	public async chunk(entry: ChunkEntry): Promise<Chunk> {
		const raw = this.raw(entry);
		return { ...raw, tag: parse(await payload(raw)).tag };
	}

	/**
	 * Every chunk's NBT.
	 *
	 * A single bad chunk ends the iteration, since there is no way to report it otherwise. To
	 * survive damaged regions, walk {@link entries} and call {@link chunk} inside a try/catch.
	 */
	public async *chunks(): AsyncGenerator<Chunk> {
		for (const entry of this.entries()) yield await this.chunk(entry);
	}
}
