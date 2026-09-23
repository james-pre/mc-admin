import { decodeUTF8, encodeUTF8 } from 'utilium';

/** A server's answer to a Server List Ping. */
export interface Status {
	version: { name: string; protocol: number };
	players?: {
		max: number;
		online: number;
		/** Some of the players online, which the server may leave out or anonymize. */
		sample?: { name: string; id: string }[];
	};
	description?: unknown;
	favicon?: string;
	enforcesSecureChat?: boolean;
}

function varInt(value: number): number[] {
	const bytes: number[] = [];
	value >>>= 0;
	do {
		const byte = value & 0x7f;
		value >>>= 7;
		bytes.push(value ? byte | 0x80 : byte);
	} while (value);
	return bytes;
}

/** The VarInt at `offset` and the offset after it, or null when it hasn't fully arrived. */
function readVarInt(bytes: Uint8Array, offset: number): [value: number, end: number] | null {
	let value = 0;
	for (let i = 0; i < 5; i++) {
		if (offset + i >= bytes.length) return null;
		const byte = bytes[offset + i];
		value |= (byte & 0x7f) << (7 * i);
		if (!(byte & 0x80)) return [value, offset + i + 1];
	}
	throw new Error('VarInt is too long');
}

function packet(id: number, ...fields: ArrayLike<number>[]): Uint8Array<ArrayBuffer> {
	const body = [...varInt(id), ...fields.flatMap(field => Array.from(field))];
	return new Uint8Array([...varInt(body.length), ...body]);
}

/** The handshake announcing a status request, followed by the request. */
export function encodeRequest(host: string, port: number): Uint8Array<ArrayBuffer> {
	const address = encodeUTF8(host);
	const handshake = packet(0, varInt(-1), varInt(address.byteLength), address, [port >> 8, port & 0xff], varInt(1));
	const request = packet(0);

	const bytes = new Uint8Array(handshake.byteLength + request.byteLength);
	bytes.set(handshake);
	bytes.set(request, handshake.byteLength);
	return bytes;
}

/** The status in a response packet, or null when the packet hasn't fully arrived. */
export function decodeResponse(bytes: Uint8Array): Status | null {
	const length = readVarInt(bytes, 0);
	if (!length) return null;
	const [size, start] = length;
	if (bytes.length < start + size) return null;

	const packet = bytes.subarray(start, start + size);
	const [id, afterId] = readVarInt(packet, 0) ?? truncated();
	if (id !== 0) throw new Error(`unexpected packet ${id} in response to a status request`);

	const [textLength, textStart] = readVarInt(packet, afterId) ?? truncated();
	if (packet.length < textStart + textLength) truncated();

	return JSON.parse(decodeUTF8(packet.subarray(textStart, textStart + textLength))) as Status;
}

function truncated(): never {
	throw new Error('truncated status response');
}

/** Ask a server for its status. */
export async function status(stream: ReadableWritablePair<Uint8Array, Uint8Array>, host: string, port: number): Promise<Status> {
	const writer = stream.writable.getWriter();
	await writer.write(encodeRequest(host, port));
	writer.releaseLock();

	const reader = stream.readable.getReader();
	let buffer = new Uint8Array(0);
	try {
		for (let next = await reader.read(); !next.done; next = await reader.read()) {
			const grown = new Uint8Array(buffer.byteLength + next.value.byteLength);
			grown.set(buffer);
			grown.set(next.value, buffer.byteLength);
			buffer = grown;

			const result = decodeResponse(buffer);
			if (result) return result;
		}
	} finally {
		reader.releaseLock();
	}

	throw new Error('the server closed the connection before responding');
}
