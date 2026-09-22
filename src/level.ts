import * as fs from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import type { Parsed as Chunk } from './common/chunk.js';
import type { RegionFile, RegionKind } from './common/level.js';
import { normalizeId, regionKinds, vanillaDimensions, vanillaIds } from './common/level.js';
import type { Named } from './common/nbt.js';
import { parseCompressed } from './common/nbt.js';
import { parseName, Region, regionSize } from './common/region.js';
export * from './common/level.js';

async function exists(path: string): Promise<boolean> {
	return await fs.access(path).then(
		() => true,
		() => false,
	);
}

/** The names of every subdirectory, sorted, or nothing when the directory is missing. */
async function subdirectories(path: string): Promise<string[]> {
	const entries = await fs.readdir(path, { withFileTypes: true }).catch(() => []);
	return entries
		.filter(entry => entry.isDirectory())
		.map(entry => entry.name)
		.sort();
}

/** Whether a directory is a level root rather than a single dimension's directory. */
export async function isLevel(path: string): Promise<boolean> {
	const markers = ['level.dat', 'dimensions', ...vanillaIds.keys()];
	const found = await Promise.all(markers.map(marker => exists(join(path, marker))));
	return found.includes(true);
}

const localCoord = (value: number) => ((value % regionSize) + regionSize) % regionSize;

/** One dimension's directory: its region files and the chunks in them. */
export class Dimension {
	public constructor(
		public readonly path: string,
		public readonly id: string,
		/** The level root this dimension belongs to. */
		public readonly level: string,
	) {}

	/** Where a region's file belongs, whether or not it exists. */
	public regionFile(kind: RegionKind, x: number, z: number): RegionFile {
		const name = `r.${x}.${z}.mca`;
		return { kind, x, z, name, path: join(this.path, kind, name) };
	}

	/** Every region file of one kind, sorted by name. */
	public async regionFiles(kind: RegionKind = 'region'): Promise<RegionFile[]> {
		const names = await fs.readdir(join(this.path, kind)).catch(() => []);
		const files: RegionFile[] = [];
		for (const name of names.sort()) {
			const coords = parseName(name);
			if (coords) files.push(this.regionFile(kind, coords.x, coords.z));
		}
		return files;
	}

	/** Each kind's file for one region, skipping the kinds that don't have it. */
	public async regionFilesAt(x: number, z: number): Promise<RegionFile[]> {
		const files = regionKinds.map(kind => this.regionFile(kind, x, z));
		const present = await Promise.all(files.map(file => exists(file.path)));
		return files.filter((_, i) => present[i]);
	}

	/** Read the region at region coordinates. */
	public async region(x: number, z: number, kind: RegionKind = 'region'): Promise<Region> {
		const { path } = this.regionFile(kind, x, z);
		return new Region(await fs.readFile(path));
	}

	/** The chunk at chunk coordinates, or null when the dimension has never stored it. */
	public async chunk(x: number, z: number, kind: RegionKind = 'region'): Promise<Chunk | null> {
		const file = this.regionFile(kind, Math.floor(x / regionSize), Math.floor(z / regionSize));
		try {
			const region = new Region(await fs.readFile(file.path));
			const entry = region.at(localCoord(x), localCoord(z));
			return entry && (await region.chunk(entry));
		} catch {
			return null;
		}
	}

	/** Every directory at or under `path` that holds region files. */
	static async *search(path: string, id: string, level: string): AsyncGenerator<Dimension> {
		if (await exists(join(path, 'region'))) {
			yield new Dimension(path, id, level);
			return;
		}
		for (const name of await subdirectories(path)) yield* Dimension.search(join(path, name), `${id}/${name}`, level);
	}

	/** The dimension a directory holds and the level root it belongs to, from the path alone. */
	static identify(path: string): { id: string; level: string } {
		const parts = resolve(path).split(sep);

		// Custom dimensions live at <level>/dimensions/<namespace>/<rest of the id>.
		const marker = parts.lastIndexOf('dimensions');
		if (marker >= 0 && parts.length > marker + 2)
			return { id: `${parts[marker + 1]}:${parts.slice(marker + 2).join('/')}`, level: parts.slice(0, marker).join(sep) };

		const id = vanillaIds.get(parts.at(-1)!);
		return id ? { id, level: parts.slice(0, -1).join(sep) } : { id: 'minecraft:overworld', level: parts.join(sep) };
	}

	/** A dimension directory, with its id and level root taken from the path. */
	public static at(path: string): Dimension {
		const { id, level } = Dimension.identify(path);
		return new Dimension(resolve(path), id, level);
	}
}

/** A level (world) directory. */
export class Level {
	public readonly path: string;

	public constructor(path: string) {
		this.path = resolve(path);
	}

	/** Read and parse an NBT file in the level directory. */
	public async nbt(...path: string[]): Promise<Named> {
		return await parseCompressed(await fs.readFile(join(this.path, ...path)));
	}

	/** The level's `level.dat`. */
	public async data(): Promise<Named> {
		return await this.nbt('level.dat');
	}

	/** The UUIDs of every player with saved data, sorted. */
	public async players(): Promise<string[]> {
		const names = await fs.readdir(join(this.path, 'playerdata')).catch(() => []);
		return names
			.filter(name => name.endsWith('.dat'))
			.map(name => basename(name, '.dat'))
			.sort();
	}

	/** Read and parse a player's `.dat`. */
	public async player(uuid: string): Promise<Named> {
		return await this.nbt('playerdata', `${uuid}.dat`);
	}

	/** Every dimension with a `region/` directory, vanilla ones first. */
	public async dimensions(): Promise<Dimension[]> {
		const dimensions: Dimension[] = [];

		for (const [id, sub] of Object.entries(vanillaDimensions)) {
			const dir = join(this.path, sub);
			if (await exists(join(dir, 'region'))) dimensions.push(new Dimension(dir, id, this.path));
		}

		const root = join(this.path, 'dimensions');
		for (const namespace of await subdirectories(root))
			for (const name of await subdirectories(join(root, namespace)))
				dimensions.push(
					...(await Array.fromAsync(Dimension.search(join(root, namespace, name), `${namespace}:${name}`, this.path))),
				);

		return dimensions;
	}

	/** The dimension with an id, or undefined when the level has none. */
	public async dimension(id: string): Promise<Dimension | undefined> {
		const wanted = normalizeId(id);
		return (await this.dimensions()).find(dimension => normalizeId(dimension.id) === wanted);
	}
}

/** The dimensions of a level directory, or the single dimension a dimension directory holds. */
export async function dimensionsOf(path: string): Promise<Dimension[]> {
	return (await isLevel(path)) ? await new Level(path).dimensions() : [Dimension.at(path)];
}
