import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { binDir, digest, github, type GitHubRelease } from './utils.js';
import { EventEmitter } from 'node:events';
import { config } from './config.js';

const assets: Partial<Record<NodeJS.Architecture, string>> = {
	x64: 'playit-linux-amd64',
	arm64: 'playit-linux-aarch64',
	arm: 'playit-linux-armv7',
	ia32: 'playit-linux-i686',
};

export interface Release {
	version: string;
	url: string;
	/** The SHA-256 digest of the agent, as hex. */
	digest: string | null;
	prerelease: boolean;
}

let _releases: Release[];

/** Recent releases of the agent for this machine, newest first. */
export async function releases(): Promise<Release[]> {
	if (_releases) return _releases;

	const asset = process.platform == 'linux' ? assets[process.arch] : undefined;
	if (!asset) throw new Error(`Playit is not available for ${process.platform}-${process.arch}`);

	const releases = await github<GitHubRelease[]>('/repos/playit-cloud/playit-agent/releases');
	_releases = releases.flatMap(release => {
		const file = release.assets.find(a => a.name == asset);
		if (!file) return [];
		return {
			version: release.tag_name.replace(/^v/, ''),
			url: file.browser_download_url,
			digest: file.digest?.replace(/^sha256:/, '') ?? null,
			prerelease: release.prerelease,
		};
	});
	return _releases;
}

export async function latest(): Promise<Release> {
	const rel = await releases();
	const release = rel.find(r => !r.prerelease);
	if (!release) throw new Error('there is no stable release of Playit');
	return release;
}

/** Where the agent is installed for the service user. */
export function path(): string {
	return join(binDir(), 'playit');
}

/** The socket the agent accepts connections on. */
export function socketPath(): string {
	return resolve(config.path, config.playit.socket);
}

/**
 * The version of the agent at `path`, found by matching its digest against `releases`.
 * @returns null when it is missing, or `unrecognized` when it matches none of them
 */
export async function installedVersion(path: string): Promise<string | null> {
	const hash = await digest(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code == 'ENOENT') return null;
		throw error;
	});
	if (!hash) return null;
	const rel = await releases();
	return rel.find(r => r.digest == hash)?.version ?? 'unrecognized';
}

export interface Tunnel {
	display_address: string;
	destination: string;
	is_disabled: boolean;
	disabled_reason: string | null;
}

export interface AgentState {
	version: string;
	tunnels: Tunnel[];
	pending_tunnels: { id: string; status_msg: string }[];
	notices: { priority: string; message: string; resolve_link: string | null }[];
	account_status: 'unknown' | 'guest' | 'email_not_verified' | 'verified';
	agent_id: string;
	login_link: string | null;
	start_time: number;
}

export interface ServiceError {
	code: string;
	message: string;
	retryable: boolean;
}

export type Lifecycle =
	| { state: 'waiting_for_secret' | 'starting' | 'stopping' }
	| { state: 'has_invalid_secret' | 'disabled_over_limit' | 'error'; data: ServiceError }
	| { state: 'running'; data: AgentState };

const ipcVersion = 2;

/** Ask the agent listening on a socket what it is doing. */
export async function state(socket: string, timeout: number = 2000): Promise<Lifecycle> {
	const connection = createConnection(socket);
	connection.setTimeout(timeout, () => connection.destroy(new Error('Playit did not respond')));
	connection.write(JSON.stringify({ ipc_version: ipcVersion, request_id: 1, request: { type: 'get_state' } }) + '\n');

	try {
		for await (const line of createInterface({ input: connection, crlfDelay: Infinity })) {
			const message = JSON.parse(line) as { message_kind: string; data: { response: { type: string; data: unknown } } };
			if (message.message_kind != 'response') continue;
			const { response } = message.data;
			if (response.type == 'error') throw new Error((response.data as ServiceError).message);
			return response.data as Lifecycle;
		}
	} finally {
		connection.destroy();
	}

	throw new Error('Playit closed the connection');
}

export interface AgentOptions {
	/** The agent's executable. */
	path?: string;
	/** The directory the agent runs in, where it looks for its secret. */
	cwd?: string;
	socket?: string;
	log?: string;
	restartDelay?: number;
}

export class Agent extends EventEmitter<{
	exit: [code: number | null, signal: NodeJS.Signals | null];
	error: [error: Error];
}> {
	private child: ChildProcess | null = null;
	private stopped = false;
	private timer: NodeJS.Timeout | undefined;

	constructor(protected readonly options: AgentOptions = {}) {
		super();
	}

	start(): this {
		this.child = spawn(
			this.options.path || path(),
			[
				'--socket-path',
				this.options.socket || socketPath(),
				'--log-path',
				this.options.log || resolve(config.path, config.playit.log),
			],
			{
				cwd: this.options.cwd || resolve(config.path),
				stdio: 'ignore',
				detached: true,
			},
		);
		this.child.once('error', error => this.emit('error', error));
		this.child.once('exit', (code, signal) => {
			this.child = null;
			if (this.stopped) return;
			this.emit('exit', code, signal);
			this.timer = setTimeout(() => this.start(), this.options.restartDelay ?? 10_000);
		});
		return this;
	}

	/** Stop the agent, resolving once it has exited. */
	async stop() {
		this.stopped = true;
		clearTimeout(this.timer);
		if (!this.child) return;
		const { promise, resolve } = Promise.withResolvers();
		this.child.once('exit', resolve);
		this.child.kill('SIGTERM');
		await promise;
	}

	/** Signal the agent to stop without waiting for it. */
	kill() {
		this.stopped = true;
		clearTimeout(this.timer);
		this.child?.kill('SIGTERM');
	}
}
