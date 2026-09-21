import { decodeUTF8, encodeUTF8 } from 'utilium';

/* eslint-disable @typescript-eslint/no-duplicate-enum-values */
export const enum PacketType {
	/** A command's output. */
	Value = 0,
	/** Run a command. */
	Command = 2,
	/** Whether a login was accepted. */
	AuthResponse = 2,
	/** Log in. */
	AuthRequest = 3,
}

/** Every packet opens with three `int32`s and ends with two nulls terminating the body. */
const headerSize = 12;

/** `length` counts everything after itself, never its own four bytes. */
const lengthSize = 4;

/** What `length` covers besides the body: `id`, `type`, and the two nulls. */
const overhead = 10;

export interface Packet {
	id: number;
	type: PacketType;
	body: string;
}

/** A request, ready to hand to a transport. */
export function encode(id: number, type: PacketType, body: string): Uint8Array<ArrayBuffer> {
	const bytes = encodeUTF8(body);
	const packet = new Uint8Array(headerSize + bytes.byteLength + 2);

	const view = new DataView(packet.buffer);
	view.setInt32(0, overhead + bytes.byteLength, true);
	view.setInt32(lengthSize, id, true);
	view.setInt32(lengthSize + 4, type, true);

	packet.set(bytes, headerSize);
	return packet;
}

export interface ConnectionOptions {
	/**
	 * If set, resolve a command as soon as the first response packet is received rather than collecting the whole response.
	 */
	shortCommandOutput?: boolean;
}

/** A command waiting on the server. */
interface Pending extends PromiseWithResolvers<string> {
	id: number;
	received: string[];
	endId: number | null;
}

/** A client RCON session */
export class Connection {
	protected readonly pending = new Map<number, Pending>();
	protected auth: PromiseWithResolvers<void> | null = null;
	protected nextId = 1;
	protected readonly writer: WritableStreamDefaultWriter<Uint8Array>;

	/** Settles when the server's half of the stream ends */
	public readonly closed: Promise<void>;

	/**
	 * @param stream The transport. Use Node.js `Socket`'s with `Duplex.toWeb`.
	 */
	public constructor(
		stream: ReadableWritablePair<Uint8Array, Uint8Array>,
		protected readonly options: ConnectionOptions = {},
	) {
		this.writer = stream.writable.getWriter();
		this.closed = this.read(stream.readable);
		// Keep a lone failure from surfacing as an unhandled rejection; callers still see it.
		this.closed.catch(() => {});
	}

	/** Pull packets until the server stops sending them. */
	protected async read(readable: ReadableStream<Uint8Array>): Promise<void> {
		const reader = readable.getReader();
		try {
			for (let next = await reader.read(); !next.done; next = await reader.read())
				for (const packet of this.push(next.value)) this.accept(packet);
		} catch (error) {
			this.abort(error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
		this.abort(new Error('the connection closed'));
	}

	protected buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);

	/** Every whole packet the bytes received so far complete. */
	protected *push(chunk: Uint8Array): Generator<Packet> {
		const grown = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
		grown.set(this.buffer);
		grown.set(chunk, this.buffer.byteLength);
		this.buffer = grown;

		// Every packet is at least `headerSize + 2` bytes long.
		// Waiting for a whole header before reading `length` can't stall a packet that has fully arrived.
		while (this.buffer.byteLength >= headerSize) {
			const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
			const length = view.getInt32(0, true);
			if (length < overhead) throw new Error(`RCON packet claims an impossible length (${length})`);

			const end = lengthSize + length;
			if (this.buffer.byteLength < end) return;

			yield {
				id: view.getInt32(lengthSize, true),
				type: view.getInt32(lengthSize + 4, true),
				body: decodeUTF8(this.buffer.subarray(headerSize, end - 2)),
			};
			this.buffer = this.buffer.subarray(end);
		}
	}

	protected accept(packet: Packet): void {
		if (this.auth) {
			if (packet.type !== PacketType.AuthResponse) return;
			const auth = this.auth;
			this.auth = null;
			if (packet.id === -1) auth.reject(new Error('authentication failed (bad password)'));
			else auth.resolve();
			return;
		}

		const pending = this.pending.get(packet.id);
		if (!pending) return;

		if (pending.endId === null) {
			this.pending.delete(pending.id);
			pending.resolve(packet.body);
			return;
		}

		if (packet.id !== pending.endId) {
			pending.received.push(packet.body);
			return;
		}

		this.pending.delete(pending.id);
		this.pending.delete(pending.endId);
		pending.resolve(pending.received.join(''));
	}

	/** Log in. Replies are treated as auth results until this settles. */
	public async authenticate(password: string): Promise<void> {
		if (this.auth) throw new Error('already authenticating');
		const auth = Promise.withResolvers<void>();
		this.auth = auth;
		await this.writer.write(encode(this.nextId++, PacketType.AuthRequest, password));
		await auth.promise;
	}

	/** Run a command and wait for its output. */
	public async command(text: string): Promise<string> {
		const id = this.nextId++;
		const pending: Pending = { ...Promise.withResolvers<string>(), id, received: [], endId: null };
		this.pending.set(id, pending);

		if (!this.options.shortCommandOutput) {
			pending.endId = this.nextId++;
			this.pending.set(pending.endId, pending);
		}

		await this.writer.write(encode(id, PacketType.Command, text));
		if (pending.endId !== null) await this.writer.write(encode(pending.endId, PacketType.Command, ''));

		const result = await pending.promise;
		return result.trimEnd();
	}

	/** Close this end of the stream, leaving whatever owns the transport to tear it down. */
	public async close(): Promise<void> {
		await this.writer.close();
	}

	/** Fail everything still in flight, e.g. once the socket closes. */
	public abort(reason: Error): void {
		const auth = this.auth;
		this.auth = null;
		auth?.reject(reason);
		for (const pending of this.pending.values()) pending.reject(reason);
		this.pending.clear();
	}
}
