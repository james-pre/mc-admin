const escapes: Record<string, string> = { t: '\t', n: '\n', r: '\r', f: '\f' };

function unescape(text: string): string {
	return text.replace(/\\(u[\da-fA-F]{4}|.)/gs, (_, escape: string) =>
		escape.length > 1 ? String.fromCharCode(parseInt(escape.slice(1), 16)) : (escapes[escape] ?? escape),
	);
}

/** A line ending in an odd number of backslashes continues on the next. */
const continuation = /(?<!\\)(?:\\\\)*\\$/;

const entryPattern = /^((?:\\.|[^\\=:\s])*)\s*[=:]?\s*(.*)$/s;

/** Parse a Java `.properties` file, such as `server.properties`. */
export function parse(text: string): Map<string, string> {
	const properties = new Map<string, string>();
	const lines = text.split(/\r\n|\r|\n/);

	for (let i = 0; i < lines.length; i++) {
		let line = lines[i].trimStart();
		if (!line || line[0] == '#' || line[0] == '!') continue;

		while (continuation.test(line) && i + 1 < lines.length) line = line.slice(0, -1) + lines[++i].trimStart();

		const [, key, value] = entryPattern.exec(line)!;
		properties.set(unescape(key), unescape(value));
	}

	return properties;
}
