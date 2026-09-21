#!/usr/bin/env node

import * as io from 'ioium/node';
import cli from './cli.js';

try {
	await cli.parseAsync();
} catch (e) {
	io.exit(e);
}
