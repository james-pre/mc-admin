/** A view of the same bytes, without copying them. */
export function toBytes(data: BufferSource): Uint8Array<ArrayBuffer> {
	return ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
}

export type CompressionFormat = 'gzip' | 'deflate' | 'deflate-raw';

/** Inflate a payload with `DecompressionStream`, the one decompressor every host agrees on. */
export async function decompress(data: BufferSource, format: CompressionFormat): Promise<Uint8Array<ArrayBuffer>> {
	const input = new ReadableStream<BufferSource>({
		start(controller) {
			controller.enqueue(toBytes(data));
			controller.close();
		},
	});

	const reader = input.pipeThrough(new DecompressionStream(format)).getReader();

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
