import { Command, InvalidArgumentError, Option } from 'commander';
import * as io from 'ioium/node';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { styleText } from 'node:util';
import { _throw, pick } from 'utilium';
import { bytes as formatBytes } from 'utilium/format';
import $pkg from '../package.json' with { type: 'json' };
import { config, configManager } from './config.js';
import * as prune from './prune.js';

const cli = new Command('mc-admin')
	.version($pkg.version)
	.description($pkg.description)
	.option('-C, --config <file>', 'configuration file to use')
	.option('-w, --world <path>', 'override the world path to use')
	.hook('preAction', () => {
		const opts = cli.opts();

		if (opts.config) configManager.loadFile(resolve(opts.config), {});
		else configManager.loadDefaults();

		if (opts.world) configManager.set('world_path', resolve(opts.world));
	});

const cli_regions = cli.command('regions').alias('region');

const secondsPattern = /^\d+(\.\d+)?$/,
	timeOnlyPattern = /^[\d.]+[smh]$/i;

function seconds(val: string) {
	if (secondsPattern.test(val)) return Number(val);
	if (timeOnlyPattern.test(val)) val = 'T' + val;
	try {
		return Temporal.Duration.from('P' + val.toUpperCase()).total('seconds');
	} catch {
		throw new InvalidArgumentError('expected seconds or a duration like 30s, 5m, 2h, or 1DT12H');
	}
}

const excludeReasons: Record<prune.ExcludeReason, string> = {
	excluded: 'protected',
	inhabited: 'inhabited',
	unreadable: 'unparsed chunks',
	conflict: 'destination conflict',
};

/** Kept regions are only worth reporting when the reason is something the user didn't ask for. */
const surprising: prune.ExcludeReason[] = ['unreadable', 'conflict'];

cli_regions
	.command('prune')
	.description('Prune region files')
	.option('-t, --threshold <duration>', 'keep regions with at least this much play time', seconds)
	.addOption(new Option('--move [dir]', 'move pruned region files').conflicts('delete'))
	.addOption(new Option('--delete', 'delete pruned region files').conflicts('move'))
	.option('--atomic', 'Stop at the first failure, leaving the remaining regions untouched')
	.option('-v, --verbose', 'Report every region that is kept, and why')
	.option(
		'--conflicting <mode>',
		`How to handle conflicts when moving regions (${prune.conflictModes.join(', ')})`,
		(val: string) =>
			prune.conflictModes.includes(val as prune.ConflictMode)
				? (val as prune.ConflictMode)
				: _throw(new InvalidArgumentError('Invalid conflict mode')),
		'throw',
	)
	.action(async function (options) {
		if (options.verbose) io._setDebugOutput(true);

		const threshold = BigInt(Math.round(options.threshold ?? config.prune_threshold) * 20); // seconds -> ticks

		const world = resolve(config.world_path);
		if (!existsSync(world)) io.exit(`invalid world directory: ${world}`);

		const into = typeof options.move == 'string' ? resolve(options.move) : null;

		const tx = new prune.Transaction(world)
			.on('prepare_error', (err, file, dim) =>
				io.error(styleText('dim', dim.id), styleText('bold', `${file.x},${file.z}`), io.errorText(err)),
			)
			.on('prepare_exclude', (reason, region) => {
				if (!options.verbose && !surprising.includes(reason)) return;
				const text = `${styleText('dim', region.dimension.id)} ${styleText('bold', region.name)} kept: ${excludeReasons[reason]}`;
				if (surprising.includes(reason)) io.warn(text);
				else io.log(text);
			})
			.on('execute_error', (err, region) => {
				io.error(
					styleText('dim', region.dimension.id),
					styleText('bold', region.name),
					styleText('gray', `(${region.kind})`),
					io.errorText(err),
				);
				process.exitCode = 1;
			});

		const pruneOpts = { threshold, exclude: config.protected_regions, into, ...pick(options, 'atomic', 'conflicting', 'delete') };

		await tx.prepare(pruneOpts);

		if (!tx.regions.length) {
			io.log('Found no prunable region files.');
			return;
		}

		io.setTableTargetWidth(process.stdout.columns);
		io.table(
			[
				{ name: 'Dimension', text: r => styleText('dim', r.dimension.id), grow: 0 },
				{ name: 'Region File', text: r => r.name },
				{ name: 'Chunks', text: r => styleText('blue', r.chunks.toString()), padStart: true },
				{ name: 'Size', text: r => styleText('cyan', formatBytes(r.size)), padStart: true },
				{ name: 'Max chunk time', text: r => (Number(r.inhabitedTicks) / 1200).toFixed(1) + ' min', padStart: true },
			],
			{ formatHead: t => styleText('bold', t) },
			tx.regions.filter(r => r.size),
		);

		const ioRegions = styleText('blue', tx.regions.length.toString()),
			ioSize = styleText('blue', formatBytes(tx.pruneSize));

		if (!options.delete && !options.move) {
			io.log('Found', ioRegions, 'prunable regions, totaling', ioSize);
			io.debug('Empty:', tx.regions.filter(r => !r.size).length);
			return;
		}

		io.log(
			'About to',
			options.delete ? styleText('red', 'DELETE') : styleText('yellow', 'move'),
			ioRegions,
			'regions, totaling',
			ioSize,
		);

		await io.assertYes();

		const { pruned, freed } = await tx.execute(pruneOpts);

		io.log(
			options.delete ? 'Deleted' : 'Moved',
			styleText('blue', pruned.length.toString()),
			'regions, freeing',
			styleText('blue', formatBytes(freed)),
		);
	});

cli.command('console')
	.alias('con')
	.alias('rcon')
	.alias('rc')
	.action(function () {
		//
	});

export default cli;
