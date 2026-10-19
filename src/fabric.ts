import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ZipFile } from 'node:zlib';
import { cacheDir, exists, replaceFile, request, requestJSON } from './utils.js';
import { config } from './config.js';
import * as properties from './properties.js';

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

	const dir = cacheDir();
	const name = `fabric-installer-${latest.version}.jar`;
	const path = join(dir, name);
	if (await exists(path)) return path;

	await replaceFile(path, await request(latest.url).then(r => r.bytes()));

	for (const file of await fs.readdir(dir)) {
		if (file != name && /^fabric-installer-.+\.jar$/.test(file)) await fs.rm(join(dir, file), { force: true });
	}

	return path;
}

export const launcherPath = 'fabric-server-launch.jar';

/** Open a jar, or null when it doesn't exist. */
function openJar(path: string): Promise<ZipFile | null> {
	return ZipFile.open(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code == 'ENOENT') return null;
		throw error;
	});
}

/** The versions of the libraries the Fabric launcher in a server directory runs, by artifact, or null without one. */
export async function libraryVersions(dir: string = config.path): Promise<Record<string, string> | null> {
	await using jar = await openJar(join(dir, launcherPath));
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

/** The version of the Minecraft server jar the Fabric launcher in a server directory runs, or null without one. */
export async function minecraftVersion(dir: string = config.path): Promise<string | null> {
	const serverJar = properties.read(join(dir, 'fabric-server-launcher.properties')).get('serverJar') || 'server.jar';
	await using jar = await openJar(resolve(dir, serverJar));
	if (!jar) return null;

	const version = await jar.get('version.json').then(entry => entry.content());
	return JSON.parse(version.toString('utf8')).id;
}
