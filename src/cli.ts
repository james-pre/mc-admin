import { configCommand } from '@james-pre/config/cli';
import * as systemd from '@james-pre/systemd';
import { serviceCommand } from '@james-pre/systemd/cli';
import { Command, InvalidArgumentError, Option } from 'commander';
import * as io from 'ioium/node';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, statSync } from 'node:fs';
import { constants, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { styleText, type InspectColor } from 'node:util';
import { ZipBuffer } from 'node:zlib';
import { _throw, pick } from 'utilium';
import { bytes as formatBytes } from 'utilium/format';
import $pkg from '../package.json' with { type: 'json' };
import { config, configManager } from './config.js';
import * as fabric from './fabric.js';
import * as ferium from './ferium.js';
import { dimensionsAt, type Dimension, type RegionStats } from './level.js';
import * as log from './log.js';
import ping from './ping.js';
import * as playit from './playit.js';
import * as properties from './properties.js';
import * as prune from './prune.js';
import * as rcon from './rcon.js';
import * as server from './server.js';
import { interact, Terminal, type Session } from './terminal.js';
import * as upgrade from './upgrade.js';
import { concurrent, replaceFile, request, runAs, serverDir, serviceUser } from './utils.js';

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
	.action(async options => {
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

cli_regions
	.command('stats')
	.alias('stat')
	.description('Show how many regions and chunks each dimension stores, and how much space they take')
	.option('-l, --long', 'show stats for each region file')
	.action(async options => {
		const world = resolve(config.path, config.world);
		if (!existsSync(world)) io.exit(`invalid world directory: ${world}`);

		const dimensions = await dimensionsAt(world);
		if (!dimensions.length) io.exit(`no dimensions found in ${world}`);

		const totals: { dimension: Dimension; regions: RegionStats[] }[] = [];

		for (const dimension of dimensions) {
			const stats = await concurrent(await dimension.regionFiles(), 8, file =>
				dimension.regionStats(file).catch((err: Error) => {
					io.error(styleText('dim', dimension.id), styleText('bold', file.name), io.errorText(err));
					process.exitCode = 1;
					return null;
				}),
			);
			totals.push({ dimension, regions: stats.filter(s => s !== null) });
		}

		io.setTableTargetWidth(process.stdout.columns);

		if (options.long) {
			io.table(
				[
					{ name: 'Dimension', text: r => styleText('dim', r.dimension.id), grow: 0 },
					{ name: 'Region File', text: r => r.name },
					{ name: 'Chunks', text: r => styleText('blue', r.chunks.toString()), padStart: true },
					{ name: 'Size', text: r => styleText('cyan', formatBytes(r.size)), padStart: true },
				],
				{ formatHead: t => styleText('bold', t) },
				totals.flatMap(({ dimension, regions }) => regions.map(r => ({ ...r, dimension }))),
			);
			console.log();
		}

		const sum = (regions: RegionStats[], key: 'chunks' | 'size') => regions.reduce((total, r) => total + r[key], 0);

		io.table(
			[
				{ name: 'Dimension', text: t => styleText('dim', t.dimension.id), grow: 0 },
				{ name: 'Regions', text: t => styleText('blue', t.regions.length.toString()), padStart: true },
				{ name: 'Chunks', text: t => styleText('blue', sum(t.regions, 'chunks').toString()), padStart: true },
				{ name: 'Size', text: t => styleText('cyan', formatBytes(sum(t.regions, 'size'))), padStart: true },
			],
			{ formatHead: t => styleText('bold', t) },
			totals,
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
	.action(async options => {
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
	.action(async options => {
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

		let agent: playit.Agent | null = null;
		if (config.playit.enabled && !existsSync(playit.path()))
			io.warn('Playit is enabled but not installed. To install it, run: mc-admin install-playit');
		else if (config.playit.enabled)
			agent = new playit.Agent()
				.on('exit', (code, signal) => io.warn(`Playit exited with ${signal ?? `status ${code}`}, restarting it.`))
				.on('error', error => io.warn(`Could not run Playit: ${error.message}`))
				.start();

		const stop = (signal: NodeJS.Signals) => instance.process.kill(signal);
		for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, stop);
		process.once('exit', () => {
			stop('SIGTERM');
			agent?.kill();
		});

		try {
			await interact(new Terminal({ history: historyFile }), instance, { persist: true, onInterrupt: () => stop('SIGINT') });
		} finally {
			consoleServer?.close();
		}

		const { code, signal } = await instance.exited;
		await agent?.stop();
		process.exitCode = code ?? 128 + constants.signals[signal!];
	});

function service(user?: boolean) {
	return new systemd.Service(config.service.name, { user: user ?? config.service.scope == 'user' });
}

const unknown = styleText('dim', 'unknown');

async function describeTunnel(socket: string): Promise<string> {
	const lifecycle = await playit.state(socket).catch(() => null);
	if (!lifecycle) return styleText('dim', 'not running');

	switch (lifecycle.state) {
		case 'running': {
			const { tunnels, pending_tunnels } = lifecycle.data;
			if (!tunnels.length) return styleText('yellow', pending_tunnels.length ? 'tunnels pending' : 'no tunnels');
			return tunnels
				.map(t =>
					t.is_disabled
						? styleText('red', `${t.display_address} (disabled${t.disabled_reason ? ': ' + t.disabled_reason : ''})`)
						: `${styleText('green', t.display_address)} → ${t.destination}`,
				)
				.join(', ');
		}
		case 'waiting_for_secret':
			return styleText('yellow', 'waiting for a secret');
		case 'starting':
		case 'stopping':
			return styleText('dim', lifecycle.state);
		default:
			return styleText('red', lifecycle.data.message);
	}
}

cli.command('status')
	.description('Show the state of the server')
	.action(async () => {
		const path = resolve(config.path);
		const props = properties.read(join(path, 'server.properties'));

		console.log(styleText('whiteBright', 'Daemon:'), service().shortStatus());

		if (config.playit.enabled) console.log(styleText('whiteBright', 'Tunnel:'), await describeTunnel(playit.socketPath()));

		const status = await ping({
			host: props.get('server-ip') || 'localhost',
			port: Number(props.get('server-port') || 25565),
		}).catch(() => null);

		let players = unknown;
		if (status?.players) {
			const { online, max, sample = [] } = status.players;
			const names = sample.map(player => player.name);
			if (online > names.length && names.length) names.push(styleText('dim', `and ${online - names.length} more`));
			players = [`${online}/${max}`, names.join(', ')].filter(v => v).join(' ');
		}
		console.log(styleText('whiteBright', 'Players:'), players);

		const startup = log.readStartupInfo(join(path, 'logs/latest.log'));

		console.log(styleText('whiteBright', 'Minecraft:'), startup.minecraft ?? status?.version.name ?? unknown);
		console.log(styleText('whiteBright', 'Fabric:'), startup.fabric ?? unknown);
		console.log(styleText('whiteBright', 'Java:'), server.javaVersion(config.java) ?? styleText('red', `${config.java} not found`));

		const mods = startup.mods ? `${startup.mods.length} ${styleText('dim', `(${startup.totalMods} total)`)}` : unknown;
		console.log(styleText('whiteBright', 'Mods:'), mods);
	});

serviceCommand(cli, {
	service,
	serviceUser: service =>
		service.options.user ? undefined : { name: config.service.user, home: resolve(config.path), shell: '/bin/bash' },
	source(service) {
		const user = !!service.options.user;

		const path = resolve(config.path);

		const stats = statSync(path, { throwIfNoEntry: false });
		if (!stats?.isDirectory()) io.exit(`invalid server directory: ${path}`);

		const account = user ? null : systemd.getUser(config.service.user);
		if (account && stats.uid != account.uid)
			io.warn(
				`The server directory is owned by someone else, so ${account.name} may not be able to use it. To fix this, run: chown -R ${account.name}: ${path}`,
			);

		const argv = [join(import.meta.dirname, 'main.js')];
		const { config: configFile } = cli.opts();
		if (configFile) argv.push('--config', resolve(configFile));
		argv.push('run');

		return {
			unit: {
				Unit: {
					Description: 'Minecraft server',
					Wants: 'network-online.target',
					After: 'network-online.target',
					RequiresMountsFor: systemd.literal(path),
				},
				Service: {
					Type: 'simple',
					User: account?.name,
					Group: user ? undefined : config.service.group,
					WorkingDirectory: systemd.literal(path),
					ExecStart: systemd.command(...argv),
					KillMode: 'mixed',
					SuccessExitStatus: 143,
					Restart: 'on-failure',
					RestartSec: 10,
				},
				Install: { WantedBy: user ? 'default.target' : 'multi-user.target' },
			},
		};
	},
}).description('Manage the systemd service that runs the server');

/**
 * Run an mc-admin command as the service user unless this process already is them, exiting when it fails.
 * @returns whether the command was run
 */
async function delegate(args: string[]): Promise<boolean> {
	const user = serviceUser();
	if (!user) return false;

	const account = systemd.getUser(user);
	if (!account) io.exit(`the user ${user} does not exist`);
	if (account.uid == process.getuid?.()) return false;

	const { config: file } = cli.opts();
	const argv = [...process.execArgv, join(import.meta.dirname, 'main.js'), ...(file ? ['--config', resolve(file)] : []), ...args];
	const status = await runAs(user, process.execPath, argv);
	if (status) process.exit(status);
	return true;
}

/** Install Fabric as the service user, exiting when the installer fails. */
async function installFabric(minecraft: string | null, loader?: string): Promise<void> {
	if (await delegate(['install-fabric', minecraft ?? 'latest', ...(loader ? ['--loader', loader] : [])])) return;

	const path = serverDir();

	const jar = await io.track('Getting the Fabric installer', fabric.installer());

	const { status, error } = spawnSync(
		config.java,
		[
			'-jar',
			jar,
			'server',
			'-dir',
			path,
			'-downloadMinecraft',
			...(minecraft ? ['-mcversion', minecraft] : []),
			...(loader ? ['-loader', loader] : []),
		],
		{ cwd: path, stdio: 'inherit' },
	);
	if (error) io.exit(error);
	if (status) io.exit('The Fabric installer failed.', status);

	if (config.jar == fabric.launcherPath) return;

	io.warn('The server is configured to run', config.jar, 'instead of Fabric.');
	if (await io.confirm('Do you want to update the configuration?', true)) {
		configManager.update({ jar: fabric.launcherPath });
	}
}

/** Install Ferium as the service user, exiting when it can't be. */
async function installFerium(release?: ferium.Release): Promise<void> {
	if (await delegate(['install-ferium'])) return;

	const dest = ferium.path();

	release ??= await io.track('Finding the latest Ferium', ferium.latest());
	const archive = await io.track(
		`Downloading Ferium ${release.version}`,
		request(release.url).then(r => r.bytes()),
	);

	await replaceFile(dest, await new ZipBuffer(archive).get('ferium').content(), 0o775);

	io.log(`Installed Ferium ${release.version} to ${dest}`);
}

/** Install the Playit agent as the service user unless the release is already installed, then offer to enable the tunnel. */
async function installPlayit(release?: playit.Release): Promise<void> {
	if (await delegate(['install-playit'])) return;

	const dest = playit.path();

	release ??= await io.track('Finding the latest Playit', playit.latest());

	if ((await playit.installedVersion(dest)) == release.version) io.log(`Playit ${release.version} is already installed.`);
	else {
		const data = await io.track(
			`Downloading Playit ${release.version}`,
			request(release.url).then(r => r.bytes()),
		);
		if (release.digest && createHash('sha256').update(data).digest('hex') != release.digest)
			io.exit(`The download of Playit ${release.version} does not match its digest.`);

		await replaceFile(dest, data, 0o775);

		io.log(`Installed Playit ${release.version} to ${dest}`);
	}

	if (!config.playit.enabled && (await io.confirm('Enable the tunnel, so the server runs Playit?', true)))
		configManager.update({ playit: { enabled: true } });
}

cli.command('install-fabric')
	.description('Install or upgrade the Fabric server, as the service user')
	.argument('<version>', 'Minecraft version, or "latest" for the latest release')
	.option('--loader <version>', 'Fabric loader version (default: the latest stable)')
	.action(async (version, options) => {
		if (service().status().active == 'active') io.exit('The server is running. To stop it, run: mc-admin service stop');
		await installFabric(version == 'latest' ? null : version, options.loader);
	});

cli.command('install-ferium')
	.description('Install or upgrade Ferium, as the service user')
	.action(() => installFerium());

cli.command('install-playit')
	.description('Install or upgrade the Playit agent, which `run` starts alongside the server, as the service user')
	.action(() => installPlayit());

const passthrough = cli
	.command('ferium')
	.alias('mods')
	.description('Run Ferium as the service user')
	.argument('[args...]', 'arguments for Ferium')
	.helpOption(false)
	.action(async args => {
		process.exitCode = await ferium.run(args);
	});

const stateColors = {
	upgrade: 'red',
	downgrade: 'red',
	install: 'red',
	unavailable: 'yellow',
	outdated: 'yellow',
	latest: 'green',
	unknown: 'dim',
} as const satisfies Record<upgrade.State, InspectColor>;

/** The sections of an upgrade's transaction, in order, with whether they change anything. */
const sections = [
	['upgrade', 'Upgrading', true],
	['downgrade', 'Downgrading', true],
	['install', 'Installing', true],
	['unavailable', 'Skipping', false],
] as const satisfies [upgrade.State, string, boolean][];

const none = styleText('dim', 'none');

/** Whether upgrading changes a component. */
function changing(component: upgrade.Component | null): boolean {
	return sections.some(([state, , changes]) => changes && state == component?.state);
}

cli.command('upgrade')
	.aliases(['update', 'up'])
	.description('Upgrade Minecraft, Fabric, Ferium, Playit, and mods')
	.option('--mc <version>', 'upgrade to this Minecraft version, or "latest"')
	.option('--check', 'only show the current, wanted, and latest versions')
	.option('-y, --yes', 'upgrade without asking')
	.action(async options => {
		const path = serverDir();
		const user = serviceUser();

		const plan = await io
			.track(
				'Checking for upgrades',
				upgrade.check({
					path,
					ferium: ferium.path(),
					playit: config.playit.enabled ? playit.path() : null,
					home: user ? (systemd.getUser(user)?.home ?? null) : homedir(),
					minecraft: options.mc,
				}),
			)
			.catch(io.exit);

		if (!plan.minecraft) io.info('Fabric is not installed. To install it, run: mc-admin install-fabric <version>');
		if (!plan.ferium) io.info('Ferium is not installed. To install it, run: mc-admin install-ferium');
		else if (!plan.profile) io.info('Ferium has no profile, so there are no mods to upgrade.');
		else if (!options.mc && plan.minecraft && plan.profile.game_version != plan.minecraft.current)
			io.warn(
				`Ferium's profile is for Minecraft ${plan.profile.game_version}, but the server runs ${plan.minecraft.current}. To fix this, pass --mc ${plan.minecraft.current}`,
			);

		const components = [plan.minecraft, plan.fabric, plan.ferium, plan.playit, ...plan.mods].filter(c => c !== null);

		for (const { name, error } of components) if (error) io.warn(`Could not check ${name}: ${error}`);

		if (options.check) {
			io.table(
				[
					{ name: 'Name', text: c => c.name },
					{ name: 'Current', text: c => styleText(stateColors[c.state], c.current ?? (c.error ? 'unknown' : 'missing')) },
					{ name: 'Wanted', text: c => (c.error ? unknown : c.wanted ? styleText('green', c.wanted) : none) },
					{ name: 'Latest', text: c => (c.error ? unknown : c.latest ? styleText('magenta', c.latest) : none) },
				],
				{ formatHead: t => styleText('bold', t) },
				components,
			);
			return;
		}

		if (!components.some(changing)) {
			io.log('Nothing to do.');
			return;
		}

		type Row = [name: string, current: string, next: string];

		const entries = sections
			.map(([state, label]) => ({
				label,
				rows: components
					.filter(c => c.state == state)
					.map((c): Row => [
						' ' + c.name,
						c.current ?? '',
						c.wanted
							? styleText(state == 'downgrade' ? 'red' : 'green', c.wanted)
							: styleText('yellow', `none for ${plan.game}`),
					]),
			}))
			.filter(entry => entry.rows.length);

		const header = ['Component', 'Current', 'New'].map(text => styleText('bold', text)) as Row;
		const print = io.table<Row>(
			[0, 1, 2].map(i => ({ text: row => row[i] })),
			{ noOutput: true },
			[header, ...entries.flatMap(entry => entry.rows)],
		);

		print(header);
		for (const { label, rows } of entries) {
			console.log(label + ':');
			rows.forEach(print);
		}

		console.log(styleText('bold', '\nSummary:'));
		const width = Math.max(...entries.map(entry => entry.label.length)) + 2;
		for (const { label, rows } of entries)
			console.log(` ${(label + ':').padEnd(width)}${rows.length} ${rows.length == 1 ? 'component' : 'components'}`);

		if (changing(plan.minecraft))
			io.warn(`Changing the Minecraft version converts the world, which can not be undone. You may want to create a backup.`);

		if (!options.yes) await io.assertYes();

		if (changing(plan.ferium)) await installFerium(plan.feriumRelease);

		const playitChanged = changing(plan.playit);
		if (playitChanged) await installPlayit(plan.playitRelease!);

		const fabricChanged = changing(plan.minecraft) || changing(plan.fabric);
		if (fabricChanged) await installFabric(plan.minecraft!.wanted, plan.fabric!.wanted!);

		const gameChanged = !!plan.profile && plan.game != plan.profile.game_version;
		if (gameChanged) {
			const status = await ferium.run(['profile', 'configure', '--game-version', plan.game!]);
			if (status) io.exit("Could not set the Minecraft version of Ferium's profile.", status);
		}

		const modsChanged = plan.mods.some(changing);
		if (gameChanged || modsChanged) process.exitCode = await ferium.run(['upgrade']);

		const svc = service();
		if (!(fabricChanged || gameChanged || modsChanged || playitChanged)) return;
		if (svc.status().active != 'active') return;

		if (!options.yes && !(await io.confirm('Restart the server now?'))) {
			io.info('Restart the server to use the upgrades.');
			return;
		}

		try {
			svc.restart();
		} catch (error) {
			io.exit(error);
		}
		io.log('Restarted the server.');
	});

const parseOptions = cli.parseOptions.bind(cli);

/** Leave everything after a passthrough command to it, rather than parsing global options out of it. */
cli.parseOptions = args => {
	const index = args.findIndex(arg => arg == passthrough.name() || passthrough.aliases().includes(arg));
	if (index == -1) return parseOptions(args);
	const head = parseOptions(args.slice(0, index + 1));
	return head.operands.length == 1 && !head.unknown.length
		? { operands: head.operands, unknown: args.slice(index + 1) }
		: parseOptions(args);
};

passthrough.parseOptions = args => ({ operands: args, unknown: [] });

configCommand(cli, configManager);

export default cli;
