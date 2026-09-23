import { Manager as ConfigManager } from '@james-pre/config';
import { parseBytes } from 'utilium';
import * as z from 'zod';
import { normalizeId } from './level.js';

function isSize(value: string): boolean {
	try {
		return parseBytes(value) !== null;
	} catch {
		return false;
	}
}

/** A byte count, or a size like `4G`. */
const size = z.union([z.int().nonnegative(), z.string().refine(isSize, 'expected a size like 512M or 4G')]);

export const configManager = new ConfigManager(
	z.object({
		path: z.string().default('/srv/mc'),
		// relative to the server path
		world: z.string().default('world'),
		protected_regions: z
			.record(
				z.string().transform(dim => normalizeId(dim)),
				z.templateLiteral([z.int(), ',', z.int()]).array(),
			)
			.default({}),
		/** Keep regions with at least this much play time, in seconds. */
		prune_threshold: z.number().min(0).default(300),
		/** The Java executable that runs the server. */
		java: z.string().default('java'),
		/** The server's jar, relative to the server path. */
		jar: z.string().default('server.jar'),
		/** Extra arguments for the JVM, before the jar. */
		java_args: z.string().array().default([]),
		/** Arguments for the server, after the jar. */
		server_args: z.string().array().default(['nogui']),
		/** The JVM's memory limits. */
		memory: z
			.object({
				/** Initial heap size, `-Xms`. */
				min: size.optional(),
				/** Maximum heap size, `-Xmx`. */
				max: size.optional(),
				/** Thread stack size, `-Xss`. */
				stack: size.optional(),
				/** Metaspace size that triggers the first collection of it, `-XX:MetaspaceSize`. */
				metaspace: size.optional(),
				/** Maximum metaspace size, `-XX:MaxMetaspaceSize`. */
				max_metaspace: size.optional(),
			})
			.prefault({}),
		/** The socket a running server accepts console connections on, relative to the server path. */
		socket: z.string().default('console.sock'),
		service: z
			.object({
				name: z.string().default('minecraft'),
				/** Whether the service belongs to the system's service manager or the user's (`systemctl --user`). */
				scope: z.enum(['system', 'user']).default('system'),
				/** Who a system service runs as, by default the owner of the server path. */
				user: z.string().optional(),
				group: z.string().optional(),
			})
			.prefault({}),
	}),
	{ system: 'mc-admin' },
);

export const config = configManager.data;
