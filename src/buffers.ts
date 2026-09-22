import { promisify } from 'node:util';
import { gunzip, inflate, inflateRaw } from 'node:zlib';
import { toBytes, useDecompress, type CompressionFormat } from './common/buffers.js';

export * from './common/buffers.js';

const inflaters: Record<CompressionFormat, (data: Uint8Array) => Promise<Buffer<ArrayBuffer>>> = {
	gzip: promisify(gunzip),
	deflate: promisify(inflate),
	'deflate-raw': promisify(inflateRaw),
};

useDecompress(async (data, format) => toBytes(await inflaters[format](toBytes(data))));
