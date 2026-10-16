import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { ZipFile } from 'node:zlib';
import { dataDir, exists, request, requestJSON } from './utils.js';

export interface Version {
	version: string;
	stable: boolean;
	/** Present except for game versions (unused) */
	maven?: string;
	/** Present for mappings versions (unused) */
	gameVersion?: string;
	/** Present for mappings and loader versions (unused) */
	separator?: string;
	/** Present for mappings and loader versions (unused) */
	build?: number;
}

export interface Versions {
	game: Version[];
	mappings: Version[];
	intermediary: Version[];
	loader: Version[];
	installer: (Version & { url: string })[];
}

let _versions: Promise<Versions>;

export function versions(): Promise<Versions> {
	_versions ||= requestJSON<Versions>('https://meta.fabricmc.net/v2/versions');
	return _versions;
}

/** The path to the newest stable Fabric installer jar, which is downloaded unless it is already cached, replacing older ones. */
export async function installer(): Promise<string> {
	const latest = (await versions()).installer.find(v => v.stable);
	if (!latest) throw new Error('there is no stable Fabric installer');

	const dir = dataDir();
	const name = `fabric-installer-${latest.version}.jar`;
	const path = join(dir, name);
	if (await exists(path)) return path;

	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path + '.part', await request(latest.url).then(r => r.bytes()));
	await fs.rename(path + '.part', path);

	for (const file of await fs.readdir(dir)) {
		if (file != name && /^fabric-installer-.+\.jar$/.test(file)) await fs.rm(join(dir, file), { force: true });
	}

	return path;
}

export const launcherPath = 'fabric-server-launch.jar';

/** The versions of the libraries the Fabric launcher in a server directory runs, by artifact, or null without one. */
export async function libraryVersions(dir: string): Promise<Record<string, string> | null> {
	await using jar = await ZipFile.open(join(dir, launcherPath)).catch((error: NodeJS.ErrnoException) => {
		if (error.code == 'ENOENT') return null;
		throw error;
	});
	if (!jar) return null;

	const manifest = await jar
		.get('META-INF/MANIFEST.MF')
		.then(mf => mf.content())
		.then(content => content.toString('utf8').replaceAll(/\r?\n /g, ''));
	const classPath = /^Class-Path: (.*)$/m.exec(manifest)?.[1] ?? '';

	return Object.fromEntries(
		classPath
			.split(' ')
			.map(path => path.split('/').slice(-3, -1))
			.filter(parts => parts.length == 2),
	);
}
