/** A view of the same bytes, without copying them. */
export function toBytes(data: BufferSource): Uint8Array<ArrayBuffer> {
	return ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
}

export type CompressionFormat = 'gzip' | 'deflate' | 'deflate-raw';

export type Decompressor = (data: BufferSource, format: CompressionFormat) => Promise<Uint8Array<ArrayBuffer>>;

/** Decompress using the streams every host has. */
export const decompressStream: Decompressor = async function (data, format) {
	const stream = new DecompressionStream(format);

	const writer = stream.writable.getWriter();
	void writer
		.write(toBytes(data))
		.then(() => writer.close())
		.catch(() => {});

	const reader = stream.readable.getReader();

	const parts: Uint8Array[] = [];
	let length = 0;
	for (let next = await reader.read(); !next.done; next = await reader.read()) {
		parts.push(next.value);
		length += next.value.byteLength;
	}

	const result = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.byteLength;
	}
	return result;
};

export let decompress: Decompressor = decompressStream;

/** Decompress with `decompressor` from now on, such as a host-native one that beats the streams. */
export function useDecompress(decompressor: Decompressor): void {
	decompress = decompressor;
}

/** Split text into lines, holding a partial line until the rest of it arrives. */
export function lines(): TransformStream<string, string> {
	let partial = '';
	return new TransformStream({
		transform(chunk, controller) {
			partial += chunk;
			const parts = partial.split(/\r?\n/);
			partial = parts.pop()!;
			for (const part of parts) controller.enqueue(part);
		},
		flush(controller) {
			if (partial) controller.enqueue(partial);
		},
	});
}

/** Split a byte stream into lines of text. */
export function toLines(source: ReadableStream<BufferSource>): ReadableStream<string> {
	return source.pipeThrough(new TextDecoderStream()).pipeThrough(lines());
}
