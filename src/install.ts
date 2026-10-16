import { ZipBuffer } from 'node:zlib';
import $pkg from '../package.json' with { type: 'json' };

async function get(url: string, accept?: string): Promise<Response> {
	const response = await fetch(url, { headers: { 'User-Agent': `mc-admin/${$pkg.version}`, ...(accept && { Accept: accept }) } });
	if (!response.ok) throw new Error(`could not fetch ${url}: ${response.status} ${response.statusText}`);
	return response;
}

export interface Download {
	version: string;
	data: Uint8Array;
}

interface FabricInstallerVersion {
	url: string;
	version: string;
	stable: boolean;
}

/** Download the newest stable Fabric installer jar. */
export async function fabricInstaller(): Promise<Download> {
	const versions = (await get('https://meta.fabricmc.net/v2/versions/installer').then(r => r.json())) as FabricInstallerVersion[];
	const latest = versions.find(v => v.stable);
	if (!latest) throw new Error('there is no stable Fabric installer');
	return { version: latest.version, data: await get(latest.url).then(r => r.bytes()) };
}

/**
 * Arguments for the Fabric installer that install or upgrade a server in a directory.
 * @param minecraft The Minecraft version, or null for the latest release
 */
export function fabricInstallerArgs(dir: string, minecraft: string | null): string[] {
	return ['server', '-dir', dir, '-downloadMinecraft', ...(minecraft ? ['-mcversion', minecraft] : [])];
}

interface GitHubRelease {
	tag_name: string;
	assets: { name: string; browser_download_url: string }[];
}

const feriumAssets: Partial<Record<NodeJS.Architecture, string>> = {
	x64: 'ferium-linux-nogui.zip',
	arm64: 'ferium-linux-arm64-nogui.zip',
};

/** Download the newest Ferium executable for this machine. */
export async function ferium(): Promise<Download> {
	const asset = process.platform == 'linux' ? feriumAssets[process.arch] : undefined;
	if (!asset) throw new Error(`Ferium is not available for ${process.platform}-${process.arch}`);

	const release = (await get('https://api.github.com/repos/gorilla-devs/ferium/releases/latest', 'application/vnd.github+json').then(r =>
		r.json(),
	)) as GitHubRelease;

	const url = release.assets.find(a => a.name == asset)?.browser_download_url;
	if (!url) throw new Error(`Ferium ${release.tag_name} has no ${asset}`);

	const zip = new ZipBuffer(await get(url).then(r => r.bytes()));
	return { version: release.tag_name, data: await zip.get('ferium').content() };
}
