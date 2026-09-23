import * as systemd from '@james-pre/systemd';
import { Command, InvalidArgumentError, Option } from 'commander';
import * as io from 'ioium/node';
import { once } from 'node:events';
import { existsSync, statSync } from 'node:fs';
import { constants, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { styleText } from 'node:util';
import { _throw, pick } from 'utilium';
import { bytes as formatBytes } from 'utilium/format';
import $pkg from '../package.json' with { type: 'json' };
import { config, configManager } from './config.js';
import * as log from './log.js';
import * as properties from './properties.js';
import * as prune from './prune.js';
import * as rcon from './rcon.js';
import * as server from './server.js';
import { interact, Terminal, type Session } from './terminal.js';

const cli = new Command('mc-admin')
	.version($pkg.version)
	.description($pkg.description)
	.option('-C, --config <file>', 'configuration file to use')
	.option('-w, --world <path>', 'override the world path to use')
	.hook('preAction', () => {
		const opts = cli.opts();

		if (opts.config) configManager.loadFile(resolve(opts.config), {});
		else configManager.loadDefaults();

		if (opts.world) configManager.set('world', resolve(opts.world));
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
	.option('-i, --ignore-empty', 'ignore empty region files')
	.action(async function (options) {
		if (options.verbose) io._setDebugOutput(true);

		const threshold = BigInt(Math.round(options.threshold ?? config.prune_threshold) * 20); // seconds -> ticks

		const world = resolve(config.path, config.world);
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

		const pruneOpts = {
			threshold,
			exclude: config.protected_regions,
			into,
			...pick(options, 'atomic', 'conflicting', 'delete', 'ignoreEmpty'),
		};

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

function count(value: string) {
	const n = Number(value);
	if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError('expected a non-negative integer');
	return n;
}

const historyFile = join(homedir(), '.mc_console_history');

/** How the console reaches the server, besides reading its log. */
interface Transport extends Omit<Session, 'output'> {
	/** What the console is connected to. */
	name: string;
	close(): void;
}

async function attachTransport(required: boolean): Promise<Transport | null> {
	const path = resolve(config.path, config.socket);

	try {
		const socket = await server.connectConsole(path);
		return {
			name: `the server at ${path}`,
			send: command => new Promise((resolve, reject) => socket.write(command + '\n', e => (e ? reject(e) : resolve()))),
			closed: once(socket, 'close'),
			close: () => socket.destroy(),
		};
	} catch (error) {
		const { code, message } = error as NodeJS.ErrnoException;
		if (required) io.exit(`Could not attach to the server at ${path}: ${message}`);
		if (code != 'ENOENT' && code != 'ECONNREFUSED') io.warn(`Could not attach to the server, using RCON instead: ${message}`);
		return null;
	}
}

async function rconTransport(options: { host: string; port?: number; password?: string }): Promise<Transport> {
	const props = properties.read(resolve(config.path, 'server.properties'));
	const { host } = options;
	const port = options.port ?? Number(props.get('rcon.port') || 25575);
	const password = options.password ?? process.env.RCON_PASSWORD ?? props.get('rcon.password');
	if (!password) io.exit('The RCON password is not set: pass --password, set RCON_PASSWORD, or set rcon.password in server.properties');

	const connection = await rcon.connect({ host, port }).catch(io.exit);
	await connection.authenticate(password).catch(io.exit);

	return {
		name: `${host}:${port} over RCON`,
		send: command => connection.command(command),
		closed: connection.closed,
		close: () => connection.socket.destroy(),
	};
}

cli.command('console')
	.alias('con')
	.alias('rcon')
	.alias('rc')
	.description('Open a console to the server, attaching to it when it was started with `run` or using RCON otherwise')
	.addOption(new Option('-a, --attach', 'only attach to a server started with `run`').conflicts('rcon'))
	.addOption(new Option('-r, --rcon', 'only connect using RCON').conflicts('attach'))
	.option('-H, --host <host>', 'RCON server to connect to', 'localhost')
	.option('-P, --port <port>', 'RCON port (default: rcon.port from server.properties)', count)
	.option('-p, --password <password>', 'RCON password (default: RCON_PASSWORD, or rcon.password from server.properties)')
	.option('-l, --log <file>', 'server log to follow (default: logs/latest.log in the server directory)')
	.option('-n, --lines <count>', 'lines of log to show on startup', count, 10)
	.action(async function (options) {
		const transport = (options.rcon ? null : await attachTransport(!!options.attach)) ?? (await rconTransport(options));

		io.info(`Connected to ${transport.name}. Type "exit" or Ctrl+C to quit.`);

		const terminal = new Terminal({ history: historyFile });

		const output = log.tail(resolve(options.log ?? join(config.path, 'logs/latest.log')), {
			backfill: options.lines,
			onError: error => terminal.print(styleText('red', `Log error: ${error.message}`)),
		});

		const ended = await interact(terminal, { ...transport, output }, { exit: ['exit', 'quit'] }).catch((error: Error) =>
			io.exit(`Connection lost: ${error.message}`),
		);

		transport.close();
		if (ended == 'closed') io.warn('The server closed the connection.');
	});

cli.command('run')
	.description('Run the server in the foreground')
	.option('--no-socket', 'do not accept connections from `console`')
	.action(async function (options) {
		const path = resolve(config.path);

		const stats = statSync(path, { throwIfNoEntry: false });
		if (!stats?.isDirectory()) io.exit(`invalid server directory: ${path}`);
		if (process.getuid && stats.uid != process.getuid())
			io.warn(
				`The server directory is owned by another user (${stats.uid}), who may not be able to use the files the server creates.`,
			);

		const consoleServer = options.socket ? await server.ConsoleServer.listen(resolve(path, config.socket)) : null;

		const instance = server.launch({
			path,
			java: config.java,
			jar: config.jar,
			jvmArgs: [...server.memoryArgs(config.memory), ...config.java_args],
			args: config.server_args,
		});

		consoleServer?.on('command', command => void instance.send(command).catch(() => {}));

		const stop = (signal: NodeJS.Signals) => instance.process.kill(signal);
		for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, stop);
		process.once('exit', () => stop('SIGTERM'));

		try {
			await interact(new Terminal({ history: historyFile }), instance, { persist: true, onInterrupt: () => stop('SIGINT') });
		} finally {
			consoleServer?.close();
		}

		const { code, signal } = await instance.exited;
		process.exitCode = code ?? 128 + constants.signals[signal!];
	});

const cli_service = cli
	.command('service')
	.description('Manage the systemd service that runs the server')
	.addOption(new Option('--user', "use the user's service manager").conflicts('system'))
	.addOption(new Option('--system', "use the system's service manager").conflicts('user'));

function service(): systemd.Service {
	const { user, system } = cli_service.opts();
	const scope = user ? 'user' : system ? 'system' : config.service.scope;
	return new systemd.Service(config.service.name, { user: scope == 'user' });
}

function assertCanManage(service: systemd.Service) {
	if (!service.options.user && process.getuid?.() !== 0)
		io.exit('Managing a system service requires root, try again with sudo or use --user.');
}

/** A unit that runs this CLI's `run` with the same configuration. */
function serverUnit(user: boolean): systemd.UnitFile {
	const path = resolve(config.path);

	const stats = statSync(path, { throwIfNoEntry: false });
	if (!stats?.isDirectory()) io.exit(`invalid server directory: ${path}`);

	let account = user ? undefined : config.service.user;
	if (!user && !account) {
		if (stats.uid) account = stats.uid.toString();
		else io.warn('The server directory is owned by root, so the server will run as root. Set service.user to run it as someone else.');
	}

	const argv = [process.execPath, fileURLToPath(new URL('main.js', import.meta.url))];
	const { config: configFile } = cli.opts();
	if (configFile) argv.push('--config', resolve(configFile));
	argv.push('run');

	return {
		Unit: {
			Description: 'Minecraft server',
			Wants: 'network-online.target',
			After: 'network-online.target',
			RequiresMountsFor: systemd.literal(path),
		},
		Service: {
			Type: 'simple',
			User: account,
			Group: user ? undefined : config.service.group,
			WorkingDirectory: systemd.literal(path),
			ExecStart: systemd.command(...argv),
			KillMode: 'mixed',
			SuccessExitStatus: 143,
			Restart: 'on-failure',
			RestartSec: 10,
		},
		Install: { WantedBy: user ? 'default.target' : 'multi-user.target' },
	};
}

cli_service
	.command('install')
	.description('Install the service')
	.option('-e, --enable', 'start the server on boot')
	.option('-s, --start', 'start the server now')
	.option('-r, --replace', 'replace the service if it is already installed')
	.action(function (options) {
		const svc = service();
		assertCanManage(svc);

		svc.install({ unit: serverUnit(!!svc.options.user) }, options);
		io.log('Installed', styleText('bold', svc.unit), 'to', svc.path);

		if (svc.options.user && options.enable && !systemd.isLingering())
			io.warn(`${svc.unit} will not start until you log in. To start it on boot, run: loginctl enable-linger`);
	});

cli_service
	.command('uninstall')
	.description('Stop and remove the service')
	.option('-k, --keep-running', 'leave the server running')
	.action(function (options) {
		const svc = service();
		assertCanManage(svc);

		if (svc.uninstall({ stop: !options.keepRunning })) io.log('Uninstalled', styleText('bold', svc.unit));
		else io.log(svc.unit, 'is not installed');
	});

const stateColors: Partial<Record<systemd.ActiveState, 'green' | 'red'>> = { active: 'green', failed: 'red' };

cli_service
	.command('status')
	.description('Show the state of the service')
	.action(function () {
		const svc = service();
		const status = svc.status();

		if (status.load == 'not-found') {
			io.log(svc.unit, styleText('dim', 'is not installed'));
			process.exitCode = 4;
			return;
		}

		const since = status.since ? styleText('dim', ` since ${status.since.toLocaleString()}`) : '';

		io.log(styleText('bold', svc.unit), styleText('dim', svc.options.user ? '(user)' : '(system)'));
		io.log('   State:', styleText(stateColors[status.active] ?? 'yellow', `${status.active} (${status.sub})`) + since);
		io.log('    Boot:', status.enabled ?? styleText('dim', 'unknown'));
		if (status.pid) io.log('     PID:', status.pid);
		if (status.memory !== null) io.log('  Memory:', formatBytes(status.memory));
		if (status.result != 'success')
			io.log('  Result:', styleText('red', status.result), styleText('dim', `(exit status ${status.exitStatus})`));
		io.log('    Unit:', styleText('dim', status.path ?? svc.path));

		if (status.active != 'active') process.exitCode = 3;
	});

for (const [name, description] of [
	['start', 'Start the server'],
	['stop', 'Stop the server'],
	['restart', 'Restart the server'],
] as const) {
	cli_service
		.command(name)
		.description(description)
		.action(() => service()[name]());
}

cli_service
	.command('enable')
	.description('Start the server on boot')
	.option('--now', 'also start it now')
	.action(options => service().enable(options));

cli_service
	.command('disable')
	.description('Stop starting the server on boot')
	.option('--now', 'also stop it now')
	.action(options => service().disable(options));

export default cli;
