import { errorText } from 'ioium';
import * as fs from 'node:fs/promises';
import { resolve } from 'node:path';
import * as ferium from './ferium.js';
import * as fabric from './fabric.js';
import * as playit from './playit.js';
import { concurrent } from './utils.js';

/** How a component's current version relates to the one it should have and the newest. */
export type State = 'upgrade' | 'downgrade' | 'install' | 'unavailable' | 'outdated' | 'latest' | 'unknown';

export interface Component {
	name: string;
	/** Null when it is not installed. */
	current: string | null;
	/** Null when no version is compatible. */
	wanted: string | null;
	latest: string | null;
	state: State;
	/** Why the versions are unknown. */
	error?: string;
}

function compare<T>(current: T | null, wanted: T | null, latest: T | null): State {
	if (wanted === null) return 'unavailable';
	if (current === null) return 'install';
	if (current !== wanted) return 'upgrade';
	return current === latest ? 'latest' : 'outdated';
}

function component(name: string, current: string | null, wanted: string | null, latest: string | null = wanted): Component {
	return { name, current, wanted, latest, state: compare(current, wanted, latest) };
}

export interface CheckOptions {
	/** The server directory. */
	path: string;
	/** The Ferium executable. */
	ferium: string;
	/** The Playit agent, or null when the tunnel is disabled. */
	playit: string | null;
	/** The home directory Ferium runs with, or null to skip mods. */
	home: string | null;
	/** The Minecraft version to upgrade to, or `latest`. */
	minecraft?: string;
}

export interface Plan {
	minecraft: Component | null;
	fabric: Component | null;
	ferium: Component | null;
	playit: Component | null;
	mods: Component[];
	profile: ferium.Profile | null;
	/** The Minecraft version mods are checked for, which the profile needs to be set to. */
	game: string | null;
	feriumRelease: ferium.Release;
	/** The Playit release to upgrade to, or null when the tunnel is disabled. */
	playitRelease: playit.Release | null;
}

async function jarsIn(dir: string): Promise<Set<string>> {
	const names = await fs.readdir(dir).catch(() => []);
	return new Set(names.filter(name => name.endsWith('.jar')));
}

async function checkMod(mod: ferium.Mod, profile: ferium.Profile, game: string, installed: Set<string>): Promise<Component> {
	try {
		const files = await ferium.modFiles(mod);
		const loader = mod.check_mod_loader ? profile.mod_loader : null;
		const current = files.find(file => installed.has(file.filename)) ?? null;
		const wanted = ferium.compatibleFile(files, mod.check_game_version ? game : null, loader);
		const latest = ferium.compatibleFile(files, null, loader);
		return {
			name: mod.name,
			current: current?.version ?? null,
			wanted: wanted?.version ?? null,
			latest: latest?.version ?? null,
			state: compare(current, wanted, latest),
		};
	} catch (error) {
		return { name: mod.name, current: null, wanted: null, latest: null, state: 'unknown', error: errorText(error) };
	}
}

/** Find what an upgrade would change, without changing anything. */
export async function check(options: CheckOptions): Promise<Plan> {
	const [libraries, versions, feriumRelease, profile, playitRelease] = await Promise.all([
		fabric.libraryVersions(options.path),
		fabric.versions(),
		ferium.latest(),
		options.home ? ferium.activeProfile(options.home) : null,
		options.playit ? playit.latest() : null,
	]);

	const playitVersion = options.playit && (await playit.installedVersion(options.playit));

	const loader = versions.loader.find(v => v.stable)?.version;

	if (!loader) throw new Error('there is no stable Fabric loader');

	let fabricVersions: { minecraft: string; loader: string } | null = null;
	if (libraries) {
		const { intermediary: minecraft, 'fabric-loader': installedLoader } = libraries;
		if (!minecraft || !installedLoader)
			throw new Error(`could not find the Minecraft and Fabric loader versions in ${fabric.launcherPath}`);
		fabricVersions = { minecraft, loader: installedLoader };
	}

	const index = (version: string) => versions.game.findIndex(v => v.version == version);
	const newest = versions.game.find(v => v.stable)!.version;

	const target = options.minecraft == 'latest' ? newest : options.minecraft;
	if (target && index(target) == -1) throw new Error(`Fabric does not support Minecraft ${target}`);
	if (target && !fabricVersions) throw new Error('Fabric is not installed');

	let minecraft: Component | null = null;
	if (fabricVersions) {
		minecraft = component('Minecraft', fabricVersions.minecraft, target ?? fabricVersions.minecraft, newest);
		if (minecraft.state == 'upgrade' && index(minecraft.wanted!) > index(fabricVersions.minecraft)) minecraft.state = 'downgrade';
	}

	const feriumVersion = ferium.version(options.ferium);
	const game = profile ? (target ?? profile.game_version) : null;

	let mods: Component[] = [];
	if (feriumVersion && profile && game) {
		const installed = await jarsIn(resolve(options.path, profile.output_dir));
		mods = await concurrent(profile.mods, 8, mod => checkMod(mod, profile, game, installed));
	}

	return {
		minecraft,
		fabric: fabricVersions && component('Fabric Loader', fabricVersions.loader, loader),
		ferium: feriumVersion ? component('Ferium', feriumVersion, feriumRelease.version) : null,
		playit: playitRelease && component('Playit', playitVersion, playitRelease.version),
		mods,
		profile: feriumVersion ? profile : null,
		game,
		feriumRelease,
		playitRelease,
	};
}
