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

const linePattern = new RegExp(String.raw`^\[(\d{2}:\d{2}:\d{2})\] \[([^\]]*)\/(${logLevels.join('|')})\]:\s*(.*)$`);

/** Parse a server log line, or null when it isn't one. */
export function parse(line: string): LogLine | null {
	const match = linePattern.exec(line);
	if (!match) return null;
	const [, timestamp, thread, level, message] = match;
	return { timestamp, thread, level: level as LogLevel, message };
}
