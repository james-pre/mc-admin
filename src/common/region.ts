import { toBytes } from './buffers.js';
import * as chunk from './chunk.js';
import type { RegionFile } from './level.js';
import { parse } from './nbt.js';

/** Region files are addressed in 4 KiB sectors. */
export const sectorSize = 4096;

/** Chunks per region, per axis. */
export const regionSize = 32;

/** Chunks per region. */
export const chunkCount = regionSize * regionSize;

const namePattern = /^r\.(-?\d+)\.(-?\d+)\.mca$/;

/** The region coordinates a file name encodes, or null if it isn't a region file. */
export function parseName(name: string): { x: number; z: number } | null {
	const match = namePattern.exec(name);
	return match ? { x: Number(match[1]), z: Number(match[2]) } : null;
}

export class Region {
	public readonly data: Uint8Array<ArrayBuffer>;
	protected readonly view: DataView;

	public constructor(
		data: BufferSource,
		public readonly file?: RegionFile,
	) {
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
	public entry(index: number): chunk.Entry | null {
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
	public at(x: number, z: number): chunk.Entry | null {
		return this.entry(x + z * regionSize);
	}

	/** Every chunk the region actually stores. */
	public *entries(): Generator<chunk.Entry> {
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
	public raw(entry: chunk.Entry): chunk.Raw {
		const { offset } = entry;
		if (offset + 5 > this.data.byteLength) throw new RangeError(`chunk ${entry.x},${entry.z} starts past the end of the region`);

		// The stored length counts the compression byte that follows it.
		const end = offset + 4 + this.view.getUint32(offset);
		if (end > this.data.byteLength) throw new RangeError(`chunk ${entry.x},${entry.z} runs past the end of the region`);

		const flags = this.view.getUint8(offset + 4);
		return {
			...entry,
			compression: flags & ~chunk.externalFlag,
			external: (flags & chunk.externalFlag) !== 0,
			data: this.data.subarray(offset + 5, end),
		};
	}

	/** A chunk's NBT. */
	public async chunk(entry: chunk.Entry): Promise<chunk.Parsed> {
		const raw = this.raw(entry);
		return { ...raw, tag: parse(await chunk.payload(raw)).tag };
	}

	/**
	 * Every chunk's NBT.
	 *
	 * A single bad chunk ends the iteration, since there is no way to report it otherwise. To
	 * survive damaged regions, walk {@link entries} and call {@link chunk} inside a try/catch.
	 */
	public async *chunksUnsafe(): AsyncGenerator<chunk.Parsed> {
		for (const entry of this.entries()) yield await this.chunk(entry);
	}

	/**
	 * Every chunk's NBT.
	 */
	public async *chunks(onError?: (error: Error, entry: chunk.Entry) => void): AsyncGenerator<chunk.Parsed> {
		for (const entry of this.entries()) {
			try {
				yield await this.chunk(entry);
			} catch (e: any) {
				onError?.(e, entry);
			}
		}
	}

	public async filterChunks(predicate: (chunk: chunk.Parsed) => boolean): Promise<chunk.Parsed[]> {
		const chunks: chunk.Parsed[] = [];
		for (const entry of this.entries()) {
			try {
				const chunk = await this.chunk(entry);
				if (predicate(chunk)) chunks.push(chunk);
			} catch {
				// Ignore chunks that can't be read
			}
		}
		return chunks;
	}
}
