/**
 * Tiny, dependency-free argv parser for the `tunnelkit` CLI.
 *
 * Kept separate from `cli.ts` (which auto-executes) so the parsing logic can be
 * unit-tested in isolation. Supports `--key value`, `--key=value`, repeated
 * flags (collected into arrays), bare boolean flags, short aliases, and a `--`
 * terminator after which everything is treated as a positional.
 */

export interface ParsedArgs {
	/** Bare arguments, in order (e.g. the port for `quick`, the name for `local`). */
	positionals: string[];
	/** Value options. Repeated flags collect every value, in order. */
	values: Record<string, string[]>;
	/** Boolean flags that appeared without a value. */
	flags: Set<string>;
}

export interface ParseOptions {
	/** Long names that are always boolean — they never consume the next token. */
	booleans?: string[];
	/** Short alias → long name, e.g. `{ h: 'help', v: 'version' }`. */
	aliases?: Record<string, string>;
}

/** Parse an argv slice into positionals, value options, and boolean flags. */
export function parseCliArgs(argv: string[], options: ParseOptions = {}): ParsedArgs {
	const booleans = new Set(options.booleans ?? []);
	const aliases = options.aliases ?? {};

	const positionals: string[] = [];
	const values: Record<string, string[]> = {};
	const flags = new Set<string>();

	const addValue = (key: string, value: string): void => {
		(values[key] ??= []).push(value);
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];

		// Everything after a bare `--` is positional.
		if (arg === '--') {
			positionals.push(...argv.slice(i + 1));
			break;
		}

		if (arg.startsWith('--')) {
			let key = arg.slice(2);
			let inlineValue: string | undefined;
			const eq = key.indexOf('=');
			if (eq >= 0) {
				inlineValue = key.slice(eq + 1);
				key = key.slice(0, eq);
			}

			if (booleans.has(key)) {
				flags.add(key);
				continue;
			}
			if (inlineValue !== undefined) {
				addValue(key, inlineValue);
				continue;
			}
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith('-')) {
				addValue(key, next);
				i++;
			} else {
				flags.add(key);
			}
			continue;
		}

		if (arg.startsWith('-') && arg.length > 1) {
			const short = arg.slice(1);
			const key = aliases[short] ?? short;
			if (booleans.has(key)) {
				flags.add(key);
				continue;
			}
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith('-')) {
				addValue(key, next);
				i++;
			} else {
				flags.add(key);
			}
			continue;
		}

		positionals.push(arg);
	}

	return { positionals, values, flags };
}

/** Convenience: the first value supplied for `key`, or `undefined`. */
export function firstValue(parsed: ParsedArgs, key: string): string | undefined {
	return parsed.values[key]?.[0];
}
