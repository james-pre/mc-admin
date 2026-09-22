import { Manager as ConfigManager } from '@james-pre/config';
import * as z from 'zod';
import { normalizeId } from './level.js';

export const configManager = new ConfigManager(
	z.object({
		world_path: z.string(),
		protected_regions: z
			.record(
				z.string().transform(dim => normalizeId(dim)),
				z.templateLiteral([z.int(), ',', z.int()]).array(),
			)
			.default({}),
		pruneThreshold: z.number().min(0).default(5),
	}),
	{ system: 'mc-admin' },
);

export const config = configManager.data;
