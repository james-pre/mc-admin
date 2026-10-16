import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';
import { binDir, github, requestJSON, runAs, serverDir, serviceUser, type GitHubRelease } from './utils.js';

const ModIdentifier = z.union([
	z.object({ ModrinthProject: z.string() }),
	z.object({ CurseForgeProject: z.int() }),
	z.object({ GitHubRepository: z.tuple([z.string(), z.string()]) }),
]);

export const Mod = z.object({
	name: z.string(),
	identifier: ModIdentifier,
	check_game_version: z.boolean().default(true),
	check_mod_loader: z.boolean().default(true),
});
export type Mod = z.infer<typeof Mod>;

export const ModLoader = z.literal(['Quilt', 'Fabric', 'Forge', 'NeoForge']);
export type ModLoader = z.infer<typeof ModLoader>;

export const Profile = z.object({
	name: z.string(),
	output_dir: z.string(),
	game_version: z.string(),
	mod_loader: ModLoader,
	mods: Mod.array(),
});
export type Profile = z.infer<typeof Profile>;

const Config = z.object({
	active_profile: z.int().nonnegative().default(0),
	profiles: Profile.array().default([]),
});

/** Where Ferium keeps its configuration for a user. */
export function configPath(home: string): string {
	return join(home, '.config/ferium/config.json');
}

/** The active profile of a user's Ferium configuration, or null without one. */
export async function activeProfile(home: string): Promise<Profile | null> {
	let text: string;
	try {
		text = await fs.readFile(configPath(home), 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code == 'ENOENT') return null;
		throw error;
	}

	const config = Config.parse(JSON.parse(text));
	return config.profiles[config.active_profile] ?? null;
}

/** A file of a mod that Ferium can download. */
export interface ModFile {
	/** The version, as the mod's host names it. */
	version: string;
	filename: string;
	/** The game versions and mod loaders the file supports. */
	tags: string[];
	/** Whether a game version only has to be part of a tag, as with GitHub asset names. */
	partial?: boolean;
}

interface ModrinthVersion {
	version_number: string;
	game_versions: string[];
	loaders: string[];
	files: { filename: string; primary: boolean }[];
}

interface CurseForgeFile {
	displayName: string;
	fileName: string;
	fileDate: string;
	gameVersions: string[];
}

interface CurseForgePage {
	data: CurseForgeFile[];
	pagination: { totalCount: number };
}

const curseForgePageSize = 50;

/** Every file of a mod, newest first. */
export async function modFiles(mod: Mod): Promise<ModFile[]> {
	const id = mod.identifier;

	if ('ModrinthProject' in id) {
		const versions = await requestJSON<ModrinthVersion[]>(
			`https://api.modrinth.com/v2/project/${encodeURIComponent(id.ModrinthProject)}/version`,
		);
		return versions
			.filter(v => v.files.length)
			.map(v => ({
				version: v.version_number,
				filename: (v.files.find(f => f.primary) ?? v.files[0]).filename,
				tags: [...v.game_versions, ...v.loaders],
			}));
	}

	if ('CurseForgeProject' in id) {
		const key = process.env.CURSEFORGE_API_KEY;
		if (!key) throw new Error('set CURSEFORGE_API_KEY to check CurseForge mods');

		const files: CurseForgeFile[] = [];
		for (let index = 0; ; index += curseForgePageSize) {
			const page = await requestJSON<CurseForgePage>(
				`https://api.curseforge.com/v1/mods/${id.CurseForgeProject}/files?index=${index}&pageSize=${curseForgePageSize}`,
				{ 'x-api-key': key },
			);
			files.push(...page.data);
			if (index + curseForgePageSize >= page.pagination.totalCount) break;
		}

		return files
			.sort((a, b) => Date.parse(b.fileDate) - Date.parse(a.fileDate))
			.map(f => ({ version: f.displayName, filename: f.fileName, tags: f.gameVersions }));
	}

	const [owner, repo] = id.GitHubRepository;
	const releases = await github<GitHubRelease[]>(`/repos/${owner}/${repo}/releases`);
	return releases.flatMap(release =>
		release.assets
			.filter(asset => asset.name.endsWith('.jar') && !asset.name.includes('source'))
			.map(asset => ({ version: release.tag_name, filename: asset.name, tags: asset.name.slice(0, -4).split('-'), partial: true })),
	);
}

/** The newest file compatible with a game version and mod loader the way Ferium picks it, with Quilt falling back to Fabric. */
export function compatibleFile(files: readonly ModFile[], game: string | null, loader: ModLoader | null): ModFile | null {
	const find = (loader: string | null) =>
		files.find(
			file =>
				(!game || file.tags.some(tag => (file.partial ? tag.includes(game) : tag == game)))
				&& (!loader || file.tags.some(tag => tag.trim().toLowerCase() == loader)),
		);

	const name = loader?.toLowerCase() ?? null;
	return find(name) ?? (name == 'quilt' ? find('fabric') : undefined) ?? null;
}

const feriumAssets: Partial<Record<NodeJS.Architecture, string>> = {
	x64: 'ferium-linux-nogui.zip',
	arm64: 'ferium-linux-arm64-nogui.zip',
};

export interface Release {
	version: string;
	url: string;
}

/** The newest Ferium release for this machine. */
export async function latest(): Promise<Release> {
	const asset = process.platform == 'linux' ? feriumAssets[process.arch] : undefined;
	if (!asset) throw new Error(`Ferium is not available for ${process.platform}-${process.arch}`);

	const release = await github<GitHubRelease>('/repos/gorilla-devs/ferium/releases/latest');

	const url = release.assets.find(a => a.name == asset)?.browser_download_url;
	if (!url) throw new Error(`Ferium ${release.tag_name} has no ${asset}`);

	return { version: release.tag_name.replace(/^v/, ''), url };
}

/** The version of a Ferium executable, or null when it can't be run. */
export function version(path: string): string | null {
	const { stdout, status, error } = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 10_000 });
	if (error || status) return null;
	return /^ferium (\S+)/.exec(stdout)?.[1] ?? null;
}

/** Where Ferium is installed for the service user. */
export function path(): string {
	return join(binDir(), 'ferium');
}

/** Run Ferium as the service user, failing when it is not installed. */
export function run(args: readonly string[]): Promise<number> {
	const ferium = path();
	if (!existsSync(ferium)) throw new Error(`Ferium is not installed at ${ferium}. To install it, run: mc-admin install-ferium`);
	return runAs(serviceUser(), ferium, args, { cwd: serverDir() });
}
