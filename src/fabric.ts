import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { ZipFile } from 'node:zlib';
import { dataDir, exists, request, requestJSON } from './utils.js';

const metaUrl = 'https://meta.fabricmc.net/v2/versions';

export interface Version {
	version: string;
	stable: boolean;
}

interface InstallerVersion extends Version {
	url: string;
}

/** The path to the newest stable Fabric installer jar, which is downloaded unless it is already cached, replacing older ones. */
export async function installer(): Promise<string> {
	const versions = await requestJSON<InstallerVersion[]>(`${metaUrl}/installer`);
	const latest = versions.find(v => v.stable);
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

/** Every Minecraft version Fabric supports, newest first. */
export function minecraftVersions(): Promise<Version[]> {
	return requestJSON<Version[]>(`${metaUrl}/game`);
}

export async function latestLoader(): Promise<string> {
	const loader = (await requestJSON<Version[]>(`${metaUrl}/loader`)).find(v => v.stable);
	if (!loader) throw new Error('there is no stable Fabric loader');
	return loader.version;
}

export const launcher = 'fabric-server-launch.jar';

/** The versions of the libraries the Fabric launcher in a server directory runs, by artifact, or null without one. */
export async function libraryVersions(dir: string): Promise<Record<string, string> | null> {
	await using jar = await ZipFile.open(join(dir, launcher)).catch((error: NodeJS.ErrnoException) => {
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
