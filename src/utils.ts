import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { dirname } from 'node:path';

/** Run `task` over `items`, keeping at most `limit` of them in flight. */
export async function concurrent<T, U>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<U>): Promise<U[]> {
	const results: U[] = new Array(items.length);
	let next = 0;

	async function run() {
		while (next < items.length) {
			const index = next++;
			results[index] = await task(items[index], index);
		}
	}

	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
	return results;
}

/** Whether two files can be treated as the same: both empty, or byte-identical. */
export async function filesIdentical(a: string, b: string): Promise<boolean> {
	const [statA, statB] = await Promise.all([fs.stat(a), fs.stat(b)]);
	if (!statA.size && !statB.size) return true;
	if (statA.size !== statB.size) return false;

	const [dataA, dataB] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
	return dataA.equals(dataB);
}

/** Move a file, falling back to a copy when the destination is on another filesystem. */
export async function moveFile(src: string, dest: string): Promise<void> {
	await fs.mkdir(dirname(dest), { recursive: true });
	try {
		await fs.rename(src, dest);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
		const { atime, mtime } = await fs.stat(src);
		await fs.copyFile(src, dest, constants.COPYFILE_EXCL);
		await fs.utimes(dest, atime, mtime);
		await fs.rm(src);
	}
}

export async function exists(path: string): Promise<boolean> {
	return await fs.access(path).then(
		() => true,
		() => false,
	);
}

/** The names of every subdirectory, sorted, or nothing when the directory is missing. */
export async function subdirectories(path: string): Promise<string[]> {
	const entries = await fs.readdir(path, { withFileTypes: true }).catch(() => []);
	return entries
		.filter(entry => entry.isDirectory())
		.map(entry => entry.name)
		.sort();
}
