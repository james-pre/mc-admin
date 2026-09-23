export const logLevels = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const;

export type LogLevel = (typeof logLevels)[number];

/** A server log line, `[09:46:08] [Server thread/INFO]: message`. */
export interface LogLine {
	/** The time of day the line was logged, as `HH:MM:SS`. */
	timestamp: string;
	/** The thread that logged the line. */
	thread: string;
	level: LogLevel;
	message: string;
}

const linePattern = new RegExp(String.raw`^\[(\d{2}:\d{2}:\d{2})\] \[(.*?)\/(${logLevels.join('|')})\]:\s*(.*)$`);

/** Parse a server log line, or null when it isn't one. */
export function parse(line: string): LogLine | null {
	const match = linePattern.exec(line);
	if (!match) return null;
	const [, timestamp, thread, level, message] = match;
	return { timestamp, thread, level: level as LogLevel, message };
}

export interface Mod {
	id: string;
	version: string;
}

/** What a server log says about the server as it started. */
export interface StartupInfo {
	minecraft?: string;
	fabric?: string;
	/** The mods Fabric loaded, besides built-in ones and ones nested in others. */
	mods?: Mod[];
	/** How many mods Fabric loaded, including built-in and nested ones. */
	totalMods?: number;
}

const builtinMods = ['java', 'minecraft', 'fabricloader'];

const fabricPattern = /^Loading Minecraft (\S+) with Fabric Loader (\S+)$/,
	modCountPattern = /^Loading (\d+) mods:$/,
	modPattern = /^\t- (\S+) (\S+)$/,
	vanillaPattern = /^Starting minecraft server version (\S+)$/;

/** Parse the lines a server logs as it starts, stopping once it starts the game. */
export function parseStartupInfo(lines: Iterable<string>): StartupInfo {
	const startup: StartupInfo = {};

	for (const text of lines) {
		const line = parse(text);

		if (!line) {
			const mod = startup.mods && modPattern.exec(text);
			if (mod && !builtinMods.includes(mod[1])) startup.mods!.push({ id: mod[1], version: mod[2] });
			continue;
		}

		let match;
		if ((match = fabricPattern.exec(line.message))) [, startup.minecraft, startup.fabric] = match;
		else if ((match = modCountPattern.exec(line.message))) {
			startup.totalMods = Number(match[1]);
			startup.mods = [];
		} else if ((match = vanillaPattern.exec(line.message))) {
			startup.minecraft ??= match[1];
			break;
		}
	}

	return startup;
}
