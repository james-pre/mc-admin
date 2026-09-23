import { appendFileSync, readFileSync } from 'node:fs';
import { clearLine, cursorTo } from 'node:readline';
import { createInterface, type Interface } from 'node:readline/promises';
import { styleText } from 'node:util';
import { format, formatOutput } from './log.js';

export interface TerminalOptions {
	/** A file to keep command history in across sessions. */
	history?: string | null;
}

const historySize = 1000;

function readHistory(path: string): string[] {
	try {
		return readFileSync(path, 'utf8').split('\n').filter(Boolean).reverse().slice(0, historySize);
	} catch {
		return [];
	}
}

/**
 * Reads commands from the user while printing output above the prompt.
 * Without a TTY on both ends, there is no prompt or history.
 */
export class Terminal {
	public readonly interactive = !!(process.stdin.isTTY && process.stdout.isTTY);

	/** Whether output is colored, rather than printed exactly as the server wrote it. */
	public readonly styled = !!process.stdout.hasColors?.();

	protected readonly rl: Interface;

	/** Created up front so lines are buffered until something reads them. */
	protected readonly lines: AsyncIterator<string>;

	protected closed = false;

	public constructor(protected readonly options: TerminalOptions = {}) {
		const history = this.interactive && options.history ? readHistory(options.history) : [];
		this.rl = createInterface({ input: process.stdin, output: process.stdout, terminal: this.interactive, history, historySize });
		this.lines = this.rl[Symbol.asyncIterator]();
	}

	public prompt(): void {
		if (this.interactive && !this.closed) this.rl.prompt(true);
	}

	/** Print text above the prompt, keeping whatever has been typed so far. */
	public print(text: string): void {
		if (this.closed) return;
		if (!this.interactive) return void process.stdout.write(text + '\n');

		cursorTo(process.stdout, 0);
		clearLine(process.stdout, 0);
		process.stdout.write(text + '\n');
		this.rl.prompt(true);
	}

	/**
	 * Commands as they are entered, until input ends or the terminal is closed.
	 * A command is saved to the history once the next one is asked for, so one the caller stops at is left out.
	 */
	public async *commands(): AsyncGenerator<string> {
		this.prompt();

		for (let next = await this.lines.next(); !next.done; next = await this.lines.next()) {
			const command = next.value.trim();
			if (!command) {
				this.prompt();
				continue;
			}

			yield command;
			if (this.interactive && this.options.history) appendFileSync(this.options.history, command + '\n');
		}
	}

	/** Handle Ctrl+C, which otherwise pauses input. */
	public onInterrupt(handler: () => void): void {
		this.rl.on('SIGINT', handler);
	}

	public close(): void {
		if (this.closed) return;
		this.closed = true;

		if (this.interactive) {
			cursorTo(process.stdout, 0);
			clearLine(process.stdout, 0);
		}

		this.rl.close();
	}
}

/** A connection to a server that takes commands and produces log output. */
export interface Session {
	/** Server log lines. */
	output: ReadableStream<string>;
	/** Run a command, resolving with its output when the transport replies with any. */
	send(command: string): Promise<string | void>;
	/** Settles when the session ends from the server's side. Without it, the session ends with its output. */
	closed?: Promise<unknown>;
}

export interface InteractOptions {
	/** Input that ends the session rather than being sent. */
	exit?: readonly string[];
	/** Called on Ctrl+C, instead of ending the session. */
	onInterrupt?: () => void;
	/** Stay in the session after input ends, until the server's side closes. */
	persist?: boolean;
}

export type EndReason = 'closed' | 'left';

/**
 * Print a session's output and send it commands until either side ends it, then close the terminal.
 * Rejects when the session ends with an error.
 */
export async function interact(terminal: Terminal, session: Session, options: InteractOptions = {}): Promise<EndReason> {
	const ended = Promise.withResolvers<EndReason>();

	const style = (text: string, format: (text: string) => string) => (terminal.styled ? format(text) : text);

	const stopOutput = new AbortController();
	const printed = session.output.pipeTo(new WritableStream({ write: line => terminal.print(style(line, format)) }), {
		signal: stopOutput.signal,
	});

	if (session.closed) {
		session.closed.then(() => ended.resolve('closed'), ended.reject);
		printed.catch((error: Error) => {
			if (!stopOutput.signal.aborted) terminal.print(styleText('red', `Output error: ${error.message}`));
		});
	} else {
		printed.then(() => ended.resolve('closed'), ended.reject);
	}

	terminal.onInterrupt(options.onInterrupt ?? (() => ended.resolve('left')));

	void (async () => {
		for await (const command of terminal.commands()) {
			if (options.exit?.includes(command)) return ended.resolve('left');

			try {
				const reply = await session.send(command);
				if (reply) terminal.print(style(reply, formatOutput));
				else terminal.prompt();
			} catch (error) {
				terminal.print(styleText('red', `Error: ${(error as Error).message}`));
			}
		}

		if (!options.persist) ended.resolve('left');
	})().catch(ended.reject);

	try {
		return await ended.promise;
	} finally {
		stopOutput.abort();
		terminal.close();
	}
}
