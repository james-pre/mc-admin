import { Command, Option } from 'commander';
import $pkg from '../package.json' with { type: 'json' };
import * as io from 'ioium/node';
import { styleText } from 'node:util';
import { bytes as formatBytes } from 'utilium/format';

const cli = new Command('mc-admin')
	.version($pkg.version)
	.description($pkg.description)
	.option('-C, --config <file>', 'configuration file to use')
	.option('-w, --world <path>', 'override the world path to use');

const cli_regions = cli.command('regions').alias('region');

const timeOnlyPattern = /^\d+[smh]$/i;

cli_regions
	.command('prune')
	.description('Prune region files')
	.option(
		'-t, --threshold <duration>',
		'',
		val => {
			if (timeOnlyPattern.test(val)) val = 'T' + val;
			return Temporal.Duration.from('P' + val).total('seconds');
		},
		300,
	)
	.addOption(new Option('--move [dir]', 'move pruned region files').conflicts('delete'))
	.addOption(new Option('--delete', 'delete pruned region files').conflicts('move'))
	.action(async function (options) {
		const threshold = BigInt(Math.round(options.threshold) * 20); // seconds -> ticks

		// @todo

		io.setTableTargetWidth(process.stdout.columns);
		io.table(
			[
				{ name: 'Region File', text: r => r.name },
				{ name: 'Chunks', text: r => r.chunks },
				{ name: 'Size', text: r => formatBytes(r.size) },
				{ name: 'Max chunk time', text: r => r.maxTime },
			],
			{ formatHead: t => styleText('bold', t) },
			prunedRegions,
		);

		const totalSize = prunedRegions.reduce((sum, r) => sum + r.size, 0n);

		const ioRegions = styleText('blue', prunedRegions.length.toString()),
			ioSize = styleText('blue', formatBytes(totalSize));

		if (!options.delete && !options.move) {
			io.log('Found', ioRegions, 'prunable region files, totaling', ioSize);
			return;
		}

		io.log(
			'About to',
			options.delete ? styleText('red', 'DELETE') : styleText('yellow', 'move'),
			ioRegions,
			'region files, totaling',
			ioSize,
		);

		await io.assertYes();

		// @todo
	});

cli.command('console')
	.alias('con')
	.alias('rcon')
	.alias('rc')
	.action(function () {
		//
	});

export default cli;
