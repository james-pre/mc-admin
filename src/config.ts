import { Manager as ConfigManager } from '@james-pre/config';
import * as z from 'zod';
import { normalizeId } from './level.js';

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
	}),
	{ system: 'mc-admin' },
);

export const config = configManager.data;
