import { getUser } from '@james-pre/systemd';
import { spawn, type SpawnOptions } from 'node:child_process';
import { once } from 'node:events';
import { constants, statSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { homedir, constants as os } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import $pkg from '../package.json' with { type: 'json' };
import { config } from './config.js';

/** Fetch a URL, failing unless it responds successfully. */
export async function request(url: string, headers: Record<string, string> = {}): Promise<Response> {
	const response = await fetch(url, { headers: { 'User-Agent': `mc-admin/${$pkg.version}`, ...headers } });
	if (!response.ok) throw new Error(`could not fetch ${url}: ${response.status} ${response.statusText}`);
	return response;
}

export async function requestJSON<T>(url: string, headers?: Record<string, string>): Promise<T> {
	return (await request(url, headers)).json() as Promise<T>;
}

/** Fetch from GitHub's API, authenticating with `GITHUB_TOKEN` when it is set. */
export function github<T>(path: string): Promise<T> {
	const token = process.env.GITHUB_TOKEN;
	return requestJSON<T>('https://api.github.com' + path, {
		Accept: 'application/vnd.github+json',
		...(token && { Authorization: `Bearer ${token}` }),
	});
}

/**
 * Run a program to completion as a user, through sudo unless this process already is them, or as this process's user when null.
 * @returns the exit status, or 128 plus the number of the signal that killed it
 */
export async function runAs(user: string | null, file: string, args: readonly string[], options: SpawnOptions = {}): Promise<number> {
	if (user) {
		const account = getUser(user);
		if (!account) throw new Error(`the user ${user} does not exist`);
		if (account.uid != process.getuid?.()) [file, args] = ['sudo', ['-u', user, '-H', '--', file, ...args]];
	}

	const child = spawn(file, args, { stdio: 'inherit', ...options });
	const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
	return code ?? 128 + os.signals[signal!];
}

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
export async function moveFile(src: string, dest: string, overwrite: boolean = false): Promise<void> {
	await fs.mkdir(dirname(dest), { recursive: true });
	try {
		await fs.rename(src, dest);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
		const { atime, mtime } = await fs.stat(src);
		await fs.copyFile(src, dest, overwrite ? 0 : constants.COPYFILE_EXCL);
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

export function serverDir(): string {
	const path = resolve(config.path);
	if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`invalid server directory: ${path}`);
	return path;
}

export function serviceUser() {
	return config.service.scope == 'user' ? null : config.service.user;
}

/** Where mc-admin keeps downloads to reuse. */
export function dataDir(): string {
	return join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'mc-admin');
}
