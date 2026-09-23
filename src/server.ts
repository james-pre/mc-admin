import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, lstatSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { parseBytes } from 'utilium';
import type { Session } from './terminal.js';

const memoryFlags = {
	min: '-Xms',
	max: '-Xmx',
	stack: '-Xss',
	metaspace: '-XX:MetaspaceSize=',
	max_metaspace: '-XX:MaxMetaspaceSize=',
} as const;

/** Memory limits, as byte counts or sizes like `4G`. */
export type Memory = Partial<Record<keyof typeof memoryFlags, string | number>>;

const jvmUnits = [
	['g', 1024n ** 3n],
	['m', 1024n ** 2n],
	['k', 1024n],
] as const;

/** A size the way the JVM reads it, in the largest unit that holds it exactly. */
function jvmSize(value: string | number): string {
	const bytes = typeof value == 'number' ? BigInt(value) : parseBytes(value);
	if (bytes === null) throw new RangeError(`invalid size: ${value}`);
	const [unit, size] = jvmUnits.find(([, size]) => !(bytes % size)) ?? ['', 1n];
	return (bytes / size).toString() + unit;
}

export function memoryArgs(memory: Memory): string[] {
	return Object.entries(memoryFlags).flatMap(([key, flag]) => {
		const value = memory[key as keyof Memory];
		return value === undefined ? [] : [flag + jvmSize(value)];
	});
}

/** The version of a Java executable, or null when it can't be run. */
export function javaVersion(java: string): string | null {
	const { stderr, error } = spawnSync(java, ['-version'], { encoding: 'utf8', timeout: 10_000 });
	if (error) return null;
	return /version "([^"]+)"/.exec(stderr)?.[1] ?? null;
}

export interface LaunchOptions {
	/** The server directory, which the server runs in. */
	path: string;
	/** The server's jar, relative to its directory. */
	jar: string;
	/** @default 'java' */
	java?: string;
	/** Arguments for the JVM, before the jar. */
	jvmArgs?: readonly string[];
	/** Arguments for the server, after the jar. */
	args?: readonly string[];
}

export interface Exit {
	code: number | null;
	signal: NodeJS.Signals | null;
}

/** A running server, whose session ends once its output does. */
export interface Server extends Session {
	readonly process: ChildProcessWithoutNullStreams;
	readonly exited: Promise<Exit>;
}

/** Start a server in its own process group, so signals only reach it through its parent. */
export function launch(options: LaunchOptions): Server {
	const args = [...(options.jvmArgs ?? []), '-jar', options.jar, ...(options.args ?? [])];
	const child = spawn(options.java ?? 'java', args, { cwd: options.path, stdio: 'pipe', detached: true });

	const exited = new Promise<Exit>((resolve, reject) => {
		child.once('error', reject);
		child.once('exit', (code, signal) => resolve({ code, signal }));
	});
	exited.catch(() => {});

	child.stdin.on('error', () => {});

	let done = false;
	const output = new ReadableStream<string>({
		start(controller) {
			function finish(error?: Error) {
				if (done) return;
				done = true;
				if (error) controller.error(error);
				else controller.close();
			}

			let open = 2;
			for (const input of [child.stdout, child.stderr]) {
				createInterface({ input, crlfDelay: Infinity })
					.on('line', line => {
						if (!done) controller.enqueue(line);
					})
					.on('close', () => {
						if (!--open) finish();
					});
			}
			child.once('error', finish);
		},
		cancel() {
			done = true;
		},
	});

	function send(command: string): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		child.stdin.write(command + '\n', error => (error ? reject(error) : resolve()));
		return promise;
	}

	return { process: child, exited, output, send };
}

export function connectConsole(path: string): Promise<Socket> {
	const { promise, resolve, reject } = Promise.withResolvers<Socket>();
	const socket = createConnection(path);
	socket.once('error', reject);
	socket.once('connect', () => {
		socket.off('error', reject);
		resolve(socket);
	});
	return promise;
}

/** Remove a socket nothing is listening on, failing when something is. */
async function clearSocket(path: string): Promise<void> {
	const socket = await connectConsole(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code == 'ECONNREFUSED' && lstatSync(path).isSocket()) rmSync(path);
		else if (error.code != 'ENOENT') throw error;
		return null;
	});
	if (!socket) return;
	socket.destroy();
	throw new Error(`another server is already accepting console connections at ${path}`);
}

/** Accepts console connections, emitting each line received as a command. */
export class ConsoleServer extends EventEmitter<{ command: [command: string] }> {
	protected readonly sockets = new Set<Socket>();
	protected readonly server = createServer(socket => this.accept(socket));

	protected constructor(public readonly path: string) {
		super();
	}

	/**
	 * Accept console connections on a Unix socket, failing when another server already does.
	 * Anyone who can write to the socket, which is its owner and group, can run any command.
	 */
	public static async listen(path: string): Promise<ConsoleServer> {
		await clearSocket(path);

		const listener = new ConsoleServer(path);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		listener.server.once('error', reject).listen(path, resolve);
		await promise;
		chmodSync(path, 0o660);

		return listener;
	}

	protected accept(socket: Socket): void {
		this.sockets.add(socket);
		socket.on('error', () => {}).once('close', () => this.sockets.delete(socket));

		createInterface({ input: socket, crlfDelay: Infinity }).on('line', line => {
			const command = line.trim();
			if (command) this.emit('command', command);
		});
	}

	/** Stop accepting connections and drop the ones already open. */
	public close(): void {
		this.server.close();
		for (const socket of this.sockets) socket.destroy();
		rmSync(this.path, { force: true });
	}
}
