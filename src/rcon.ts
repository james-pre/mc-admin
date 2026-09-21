export * from './common/rcon.js';
import { connect as connectSocket, type Socket, type TcpSocketConnectOpts } from 'node:net';
import { Connection, type ConnectionOptions } from './common/rcon.js';
import { Duplex } from 'node:stream';

export interface ConnectOptions extends ConnectionOptions, TcpSocketConnectOpts {}

/**
 * Connect to an RCON server.
 * You will need to authenticate before sending any commands!
 */
export async function connect(options: ConnectOptions): Promise<Connection & { socket: Socket }> {
	const socket = connectSocket(options);
	socket.setNoDelay(true);

	const opened = Promise.withResolvers();
	socket.once('error', opened.reject);
	socket.once('connect', opened.resolve);
	await opened.promise;
	socket.removeAllListeners('error');

	const connection = new Connection(Duplex.toWeb(socket) as ReadableWritablePair, options);
	return Object.assign(connection, { socket });
}
