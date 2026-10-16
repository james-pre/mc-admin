declare module 'node:zlib' {
	interface ZipContentOptions {
		verify?: boolean;
		maxSize?: number;
	}

	export class ZipEntry {
		readonly name: string;
		readonly size: number;
		readonly mode: number;
		readonly isFile: boolean;
		readonly isDirectory: boolean;
		readonly isSymlink: boolean;
		content(options?: ZipContentOptions): Promise<Buffer>;
		contentSync(options?: ZipContentOptions): Buffer;
	}

	/** An in-memory view over a ZIP archive, which must not be modified while in use. */
	export class ZipBuffer implements Iterable<[string, ZipEntry]> {
		constructor(buffer: ArrayBuffer | ArrayBufferView);
		readonly size: number;
		/** @throws when there is no such entry */
		get(name: string): ZipEntry;
		has(name: string): boolean;
		keys(): IterableIterator<string>;
		values(): IterableIterator<ZipEntry>;
		entries(): IterableIterator<[string, ZipEntry]>;
		[Symbol.iterator](): IterableIterator<[string, ZipEntry]>;
	}

	/** A view over a ZIP archive on disk, which reads entries lazily. */
	export class ZipFile implements AsyncDisposable {
		static open(filename: string, options?: { writable?: boolean }): Promise<ZipFile>;
		readonly size: number;
		/** @throws when there is no such entry */
		get(name: string): Promise<ZipEntry>;
		has(name: string): boolean;
		keys(): IterableIterator<string>;
		close(): Promise<void>;
		[Symbol.asyncDispose](): Promise<void>;
	}
}
