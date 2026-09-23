import { connect, type TcpSocketConnectOpts } from 'node:net';
import { Duplex } from 'node:stream';
import { status, type Status } from './common/ping.js';

export * from './common/ping.js';

export interface PingOptions extends TcpSocketConnectOpts {
	/** @default 5000 */
	timeout?: number;
}

/** Ask a server for its status over the Server List Ping protocol. */
export async function ping(options: PingOptions): Promise<Status> {
	const { host = 'localhost', port, timeout = 5000 } = options;

	const socket = connect({ ...options, host });
	socket.setTimeout(timeout, () => socket.destroy(new Error('timed out')));

	try {
		const opened = Promise.withResolvers();
		socket.once('error', opened.reject);
		socket.once('connect', opened.resolve);
		await opened.promise;

		return await status(Duplex.toWeb(socket) as ReadableWritablePair, host, port);
	} finally {
		socket.destroy();
	}
}
