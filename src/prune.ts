import * as fs from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { WithRequired } from 'utilium';
import { TagType } from './nbt.js';
import { Dimension, isLevel, Level, normalizeId, type RegionFile } from './level.js';
import { Region as RegionData } from './region.js';
import { concurrent, exists, filesIdentical, moveFile } from './utils.js';
import { EventEmitter } from 'node:events';

export type ExcludeReason = 'excluded' | 'unreadable' | 'inhabited' | 'conflict';

export interface MoveInfo {
	src: string;
	dest: string;
	/** The destination already holds an identical file, so the source is dropped rather than moved. */
	duplicate: boolean;
	/** The destination holds a different file that this one replaces. */
	overwrite: boolean;
}

export interface Region extends RegionFile {
	dimension: Dimension;
	/** The size of the region's files in bytes */
	size: number;
	/** How many chunks the region stores. */
	chunks: number;
	/** How many chunks that could not be parsed. */
	unreadable: number;
	/** The longest players have spent in any one chunk. */
	inhabitedTicks: bigint;
	keep?: ExcludeReason | null;
	moves: MoveInfo[];
	deletes: string[];
	error?: Error;
}

export interface ExecuteOptions {
	/** How many regions operate on at once. */
	concurrency?: number;
	/** Whether the first failure stops the transaction, leaving the remaining regions untouched. */
	atomic?: boolean;
}

export const conflictModes = ['throw', 'exclude', 'overwrite', 'preserve'] as const;

export type ConflictMode = (typeof conflictModes)[number];

export interface PrepareOptions extends ExecuteOptions {
	/** Keep regions where players have spent at least this long in a chunk, in ticks. */
	threshold: bigint;
	/** Region coordinates to keep regardless of other constraints, as `<x>,<z>`, keyed by dimension id. */
	exclude?: Readonly<Record<string, readonly string[]>>;
	/** Delete the files instead of moving them. */
	delete?: boolean;
	/**
	 * Where moved files go.
	 * Relative paths are to the region directory, absolute paths will mirror the world directory layout
	 * @default 'old'
	 */
	into?: string | null;
	/**
	 * How to handle conflicts when moving regions
	 * - throw: emit an error for the given region, stopping the transaction when `atomic` is also set
	 * - exclude: the region will not be pruned
	 * - overwrite: the old region will be overwritten with the new one
	 * - preserve: the old region will be kept and the new one will be deleted (you probably do not want this)
	 * @default 'throw'
	 */
	conflicting?: ConflictMode;
	/** If set, completely ignore empty region files. This is helpful when mods like distant horizons touch empty files */
	ignoreEmpty?: boolean;
}

export interface Result {
	pruned: Region[];
	/** Bytes of region data removed. */
	freed: number;
	failed: { region: Region; error: Error }[];
	/** Regions left untouched because an earlier failure stopped an atomic transaction. */
	skipped: Region[];
}

export class Transaction extends EventEmitter<{
	prepare_error: [error: Error, file: RegionFile, dimension: Dimension];
	prepare_exclude: [reason: ExcludeReason, region: Region];
	execute_error: [error: Error, region: Region];
}> {
	public readonly regions: Region[] = [];

	/** *All* of the regions, including excluded ones. */
	public readonly allRegions: Region[] = [];

	constructor(public readonly path: string) {
		super({ captureRejections: true });
	}

	public get pruneSize(): number {
		return this.regions.reduce((sum, r) => sum + r.size, 0);
	}

	public get isEmpty(): boolean {
		return !this.regions.length;
	}

	#started = false;
	#prepared = false;

	public get isPrepared(): boolean {
		return this.#prepared;
	}

	async prepare(options: PrepareOptions): Promise<void> {
		if (this.#started) throw new Error('Transaction already prepared');
		this.#started = true;

		const isForLevel = await isLevel(this.path);

		const dimensions = isForLevel
			? await new Level(this.path).dimensions()
			: (await exists(join(this.path, 'region')))
				? [Dimension.at(this.path)]
				: [];

		if (!dimensions.length) throw new Error('Transaction path does not match any dimensions');

		const into = options.into ?? 'old';

		const checkedDirs = new Set<string>();

		for (const dimension of dimensions) {
			const excluded = new Set(options.exclude?.[normalizeId(dimension.id)]);

			await concurrent(await dimension.regionFiles(), options.concurrency ?? 4, async file => {
				try {
					if (options.ignoreEmpty && !(await fs.promises.stat(file.path)).size) return;

					const region = new RegionData(await fs.promises.readFile(file.path), file) as WithRequired<RegionData, 'file'>;

					const stored = Array.from(region.entries()).length;

					let unreadable = 0,
						inhabitedTicks = 0n;

					for (const entry of region.entries()) {
						try {
							const tag = await region.pick(entry, 'InhabitedTime');
							if (tag?.type === TagType.Long && tag.value > inhabitedTicks) inhabitedTicks = tag.value;
						} catch {
							unreadable++;
						}
					}

					let keep: ExcludeReason | null = excluded.has(`${region.file.x},${region.file.z}`)
						? 'excluded'
						: unreadable
							? 'unreadable'
							: inhabitedTicks >= options.threshold
								? 'inhabited'
								: null;

					const files = await dimension.regionFilesAt(region.file.x, region.file.z);

					const txRegion: Region = {
						...region.file,
						dimension,
						size: 0,
						chunks: stored,
						unreadable,
						inhabitedTicks,
						keep,
						moves: [],
						deletes: [],
					};

					this.allRegions.push(txRegion);

					if (keep) {
						this.emit('prepare_exclude', keep, txRegion);
						return;
					}

					await Promise.all(
						files.map(async file => {
							if (!checkedDirs.has(dirname(file.path))) {
								await fs.promises.access(dirname(file.path), fs.constants.W_OK | fs.constants.X_OK);
								checkedDirs.add(dirname(file.path));
							}
							const { size } = await fs.promises.stat(file.path);

							if (options.delete) {
								txRegion.deletes.push(file.path);
								txRegion.size += size;
								return;
							}

							const dest = isAbsolute(into)
								? join(into, isForLevel ? relative(dimension.level, dimension.path) : '', file.kind, file.name)
								: join(dimension.path, file.kind, into, file.name);

							try {
								if (await filesIdentical(file.path, dest)) {
									txRegion.moves.push({ src: file.path, dest, duplicate: true, overwrite: false });
									txRegion.size += size;
									return;
								}

								switch (options.conflicting) {
									case 'exclude':
										keep = 'conflict';
										break;
									case 'preserve':
										txRegion.deletes.push(file.path);
										txRegion.size += size;
										break;
									case 'overwrite':
										txRegion.moves.push({ src: file.path, dest, duplicate: false, overwrite: true });
										txRegion.size += size;
										break;
									case 'throw':
									default:
										throw new Error(`destination exists and differs: ${dest}`);
								}
							} catch (e: any) {
								if (e.code !== 'ENOENT') throw e;
								txRegion.size += size;
								txRegion.moves.push({ src: file.path, dest, duplicate: false, overwrite: false });
							}
						}),
					);

					if (keep) {
						Object.assign(txRegion, { keep, size: 0, moves: [], deletes: [] });
						this.emit('prepare_exclude', keep, txRegion);
						return;
					}

					this.regions.push(txRegion);
				} catch (e: any) {
					if (options.atomic) throw e;
					this.emit('prepare_error', e, file, dimension);
				}
			});
		}

		const order = new Map(dimensions.map((dimension, index) => [dimension, index]));

		const compare = (a: Region, b: Region) => order.get(a.dimension)! - order.get(b.dimension)! || a.x - b.x || a.z - b.z;

		this.regions.sort(compare);
		this.allRegions.sort(compare);

		this.#prepared = true;
	}

	/**
	 * Apply one region's plan with rollback on failure
	 */
	async #executeRegion(region: Region): Promise<void> {
		const moved: MoveInfo[] = [];

		try {
			for (const move of region.moves) {
				if (move.duplicate) continue;
				await moveFile(move.src, move.dest, move.overwrite);
				moved.push(move);
			}
		} catch (error) {
			for (const move of moved.reverse()) await moveFile(move.dest, move.src, true).catch(() => {});
			throw error;
		}

		for (const move of region.moves) if (move.duplicate) await fs.promises.rm(move.src);
		for (const path of region.deletes) await fs.promises.rm(path);
	}

	async execute(options: ExecuteOptions = {}): Promise<Result> {
		if (!this.#prepared) throw new Error('Transaction is not prepared');

		const result: Result = { pruned: [], freed: 0, failed: [], skipped: [] };

		let stopped = false;

		const errors = await concurrent(this.regions, options.concurrency ?? 4, async region => {
			if (stopped) return 'skipped' as const;
			try {
				await this.#executeRegion(region);
				return null;
			} catch (error) {
				if (options.atomic) stopped = true;
				return error as Error;
			}
		});

		for (const [index, error] of errors.entries()) {
			const region = this.regions[index];

			if (error === 'skipped') {
				result.skipped.push(region);
			} else if (error) {
				region.error = error;
				this.emit('execute_error', error, region);
				result.failed.push({ region, error });
			} else {
				result.pruned.push(region);
				result.freed += region.size;
			}
		}

		return result;
	}
}
