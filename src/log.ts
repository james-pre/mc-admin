import { existsSync, watch, type FSWatcher } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { toLines } from './common/buffers.js';

export * from './common/log.js';

const blockSize = 64 * 1024;

/** The offset the last `count` lines of a file begin at. */
async function backfillOffset(handle: FileHandle, size: number, count: number): Promise<number> {
	if (count <= 0) return size;

	const block = new Uint8Array(blockSize);
	let end = size,
		found = 0;

	while (end > 0) {
		const start = Math.max(0, end - block.length);
		const { bytesRead } = await handle.read(block, 0, end - start, start);
		for (let i = bytesRead - 1; i >= 0; i--) {
			// The newline ending the final line doesn't start one.
			if (block[i] !== 0x0a || start + i === size - 1) continue;
			if (++found === count) return start + i + 1;
		}
		end = start;
	}

	return 0;
}

export interface FollowOptions {
	/** Lines of existing content to emit before following the end of the file. */
	backfill?: number;
	/** How long to wait between polls, in milliseconds, for changes the watcher misses. */
	interval?: number;
	signal?: AbortSignal;
	/** Called for errors the follow can recover from; without it, they abort the stream. */
	onError?: (error: Error) => void;
}

/** Follow a file, emitting bytes as they are appended, across rotation and truncation. */
export function follow(path: string, options: FollowOptions = {}): ReadableStream<Uint8Array<ArrayBuffer>> {
	const { backfill = 0, interval = 2000, signal, onError } = options;

	const block = new Uint8Array(blockSize);

	let handle: FileHandle | null = null,
		inode: number | null = null,
		position = 0,
		stopped = false,
		watcher: FSWatcher | null = null,
		wake = Promise.withResolvers<void>();

	let catchUp = existsSync(path);

	function notify() {
		wake.resolve();
		wake = Promise.withResolvers();
	}

	function attachWatcher() {
		if (watcher || stopped) return;
		try {
			watcher = watch(dirname(path), (_event, name) => {
				if (!name || name === basename(path)) notify();
			});
			watcher.on('error', () => {});
		} catch {
			// No directory yet; the poll finds the file once it appears.
		}
	}

	const timer = setInterval(notify, interval).unref();

	function stop() {
		stopped = true;
		watcher?.close();
		watcher = null;
		clearInterval(timer);
		void handle?.close().catch(() => {});
		handle = null;
		notify();
	}

	signal?.addEventListener('abort', stop, { once: true });

	/** Open the file, reopening it when it has been rotated or truncated. */
	async function reopen() {
		const stats = await stat(path).catch(() => null);
		if (!stats) return;
		if (handle && stats.ino === inode && stats.size >= position) return;

		await handle?.close().catch(() => {});
		handle = await open(path, 'r');
		attachWatcher();
		const opened = await handle.stat();
		inode = opened.ino;
		position = catchUp ? await backfillOffset(handle, opened.size, backfill) : 0;
		catchUp = false;
	}

	attachWatcher();

	return new ReadableStream<Uint8Array<ArrayBuffer>>({
		async pull(controller) {
			while (!stopped) {
				try {
					await reopen();
					if (handle) {
						const { bytesRead } = await handle.read(block, 0, block.length, position);
						if (bytesRead > 0) {
							position += bytesRead;
							controller.enqueue(block.slice(0, bytesRead));
							return;
						}
					}
				} catch (error) {
					if (!onError) throw error;
					onError(error as Error);
				}
				await wake.promise;
			}
			controller.close();
		},
		cancel: stop,
	});
}

/** Follow a file, emitting each line appended to it. */
export function tail(path: string, options?: FollowOptions): ReadableStream<string> {
	return toLines(follow(path, options));
}
