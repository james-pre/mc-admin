import { Command } from 'commander';
import $pkg from '../../package.json' with { type: 'json' };

const cli = new Command('mc-admin').version($pkg.version).description($pkg.description);

export default cli;
