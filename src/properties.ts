import { readFileSync } from 'node:fs';
import { parse } from './common/properties.js';

export * from './common/properties.js';

/** Read a `.properties` file, which is empty when it doesn't exist. */
export function read(path: string): Map<string, string> {
	try {
		return parse(readFileSync(path, 'utf8'));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code == 'ENOENT') return new Map();
		throw error;
	}
}
