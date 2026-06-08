/**
 * tunnelkit CLI — interactive terminal UI primitives.
 *
 * Everything that talks to the terminal directly lives here: colour helpers,
 * line writers, a spinner, line-based `prompt`/`confirm`, an arrow-key `select`
 * menu, and the live `dashboard` shown while a tunnel runs. Kept apart from
 * `cli.ts` (command/dispatch logic) so the pure bits — keypress decoding and
 * menu navigation — can be unit-tested without driving a real terminal.
 *
 * Zero-dependency and cross-runtime (Node + Bun): raw-mode keypresses are read
 * straight off `stdin` and the escape sequences are decoded by hand, rather than
 * relying on `readline.emitKeypressEvents` (whose behaviour differs across
 * runtimes). In raw mode Ctrl+C no longer arrives as SIGINT, so it is decoded as
 * a key and handled explicitly.
 *
 * Interactive helpers degrade gracefully without a TTY: `prompt`/`confirm` fall
 * back to their defaults, `select` refuses (it must not guess), and `dashboard`
 * prints a static summary and waits on signals.
 */

import { spawn } from 'node:child_process';
import type { TunnelKit } from './tunnelkit.js';
import type { ActiveTunnel, IngressInfo } from './types.js';

// --- Colour (TTY-aware, honours NO_COLOR) ---

export const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

/**
 * Pick the richest ANSI form the terminal advertises and degrade gracefully:
 * `COLORTERM=truecolor`/`24bit` → 24-bit RGB; otherwise a 256-colour `TERM`
 * (e.g. `xterm-256color`) → 256-colour index; otherwise the basic 16 colours.
 * Picking once at module load lets the colour helpers be straight constants.
 */
const colorTerm = (process.env.COLORTERM ?? '').toLowerCase();
const term = (process.env.TERM ?? '').toLowerCase();
const hasTrueColor = useColor && (colorTerm === 'truecolor' || colorTerm === '24bit');
const has256 = useColor && (hasTrueColor || term.includes('256'));

/** SGR for an RGB foreground. */
const rgb = (r: number, g: number, b: number): string => `38;2;${r};${g};${b}`;
/** SGR for a 256-palette foreground. */
const c256 = (n: number): string => `38;5;${n}`;
/** Best-available SGR for an RGB colour with a 256-palette and 16-colour fallback. */
const fg = (r: number, g: number, b: number, palette256: number, basic: string): string =>
	hasTrueColor ? rgb(r, g, b) : has256 ? c256(palette256) : basic;

/**
 * Pick the dark/light palette for this run. `TUNNELKIT_THEME=light|dark|auto`
 * overrides detection (default `auto`). In `auto`, we read the `COLORFGBG`
 * environment variable (set by most modern terminals) and treat a background of
 * 7 (white) or 15 (bright white) as light; anything else defaults to dark.
 * Pure (env-only) so it's unit-testable with a stubbed env.
 */
export function detectTheme(env: NodeJS.ProcessEnv = process.env): 'dark' | 'light' {
	const override = (env.TUNNELKIT_THEME ?? '').toLowerCase();
	if (override === 'light') return 'light';
	if (override === 'dark') return 'dark';
	const cfb = env.COLORFGBG;
	if (cfb) {
		const last = cfb.split(';').pop()?.trim() ?? '';
		const bg = Number(last);
		if (bg === 7 || bg === 15) return 'light';
	}
	return 'dark';
}

const THEME: 'dark' | 'light' = detectTheme();

// Brand-aligned with tunnelkit-web (--accent-1 #f38020, --accent-2 #ffaa66,
// --syn-string #86efac for URLs); the basic-16 fallbacks (yellow/green) keep
// the look coherent on terminals that lack 256-colour support. Light theme
// picks darker variants so the same hues stay readable on a white background
// (WCAG AA for normal text needs ~4.5:1 on white).
const ACCENT = THEME === 'dark' ? fg(243, 128, 32, 208, '33') : fg(154, 77, 4, 130, '33');
const ACCENT_2 = THEME === 'dark' ? fg(255, 170, 102, 215, '93') : fg(184, 61, 4, 166, '31');
const URL_GREEN = THEME === 'dark' ? fg(134, 239, 172, 156, '92') : fg(20, 83, 45, 22, '32');
const TEXT_DIM = THEME === 'dark' ? fg(107, 104, 160, 60, '2') : fg(82, 82, 91, 240, '2');

const paint = (code: string) => (s: string): string => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
	/** Primary brand colour (orange) — used for headers, ❯ pointer, footer keys, status dots. */
	accent: paint(ACCENT),
	/** Lighter brand colour, used for emphasis (e.g. flashes). */
	accent2: paint(ACCENT_2),
	/** Greenish, used for URLs to echo the web's `--syn-string`. */
	url: paint(URL_GREEN),
	/** Brand colour kept as `cyan` for any existing callers; aliased to accent. */
	cyan: paint(ACCENT),
	green: paint('32'),
	red: paint('31'),
	yellow: paint('33'),
	/** Muted text — purple-grey under 256/truecolor, ANSI dim (`2`) otherwise. */
	dim: paint(TEXT_DIM),
	bold: paint('1'),
	magenta: paint('35')
};

// --- Line writers ---

export const out = (line = ''): void => void process.stdout.write(`${line}\n`);
export const errLine = (line = ''): void => void process.stderr.write(`${line}\n`);

// --- Cursor / screen control ---

const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
const CLEAR_DOWN = '\x1b[0J';
const CLEAR_LINE = '\x1b[2K';
const CURSOR_HOME = '\x1b[H';
const ENTER_ALT = '\x1b[?1049h';
const LEAVE_ALT = '\x1b[?1049l';

/**
 * Reset to the top-left and clear downward — used to start a fresh wizard pass.
 * Within a pass, prompts/menus accumulate (each leaves a `✓` summary); this wipes
 * the slate between passes (e.g. an Esc step-back re-shows the mode menu clean).
 * No-op without a TTY.
 */
export function clearScreen(): void {
	if (process.stdout.isTTY) process.stdout.write(CURSOR_HOME + CLEAR_DOWN);
}

/** Raised when the user aborts an interactive prompt (Esc / Ctrl+C / `q`). */
export class CancelError extends Error {
	constructor(message = 'Cancelled') {
		super(message);
		this.name = 'CancelError';
	}
}

// Restore the terminal on exit no matter how we leave (cursor + cooked mode),
// so a crash mid-menu never leaves the user with a hidden cursor or raw stdin.
let restoreRegistered = false;
function registerTerminalRestore(): void {
	if (restoreRegistered) return;
	restoreRegistered = true;
	const restore = (): void => {
		// Leave the alternate screen (if a session entered it) and show the cursor,
		// so a crash never strands the user in a blank alt buffer or hidden cursor.
		if (process.stdout.isTTY) process.stdout.write(LEAVE_ALT + CURSOR_SHOW);
		try {
			if (process.stdin.isTTY) process.stdin.setRawMode(false);
		} catch {
			// stdin may already be torn down — nothing to restore.
		}
	};
	process.on('exit', restore);
}

// --- Keypress decoding (pure — see cli-ui.test.ts) ---

export type Key =
	| { type: 'up' | 'down' | 'left' | 'right' | 'enter' | 'escape' | 'space' | 'backspace' | 'tab' | 'ctrl-c' | 'unknown' }
	| { type: 'char'; value: string };

/** Decode a raw stdin chunk into a single semantic key. */
export function parseKey(seq: string): Key {
	switch (seq) {
		case '\x1b[A':
		case '\x1bOA':
			return { type: 'up' };
		case '\x1b[B':
		case '\x1bOB':
			return { type: 'down' };
		case '\x1b[C':
		case '\x1bOC':
			return { type: 'right' };
		case '\x1b[D':
		case '\x1bOD':
			return { type: 'left' };
		case '\r':
		case '\n':
			return { type: 'enter' };
		case '\x03':
			return { type: 'ctrl-c' };
		case '\x1b':
			return { type: 'escape' };
		case '\x7f':
		case '\b':
			return { type: 'backspace' };
		case '\t':
			return { type: 'tab' };
		case ' ':
			return { type: 'space' };
		default:
			return seq.length === 1 && seq >= ' ' && seq <= '~' ? { type: 'char', value: seq } : { type: 'unknown' };
	}
}

/**
 * Next highlighted index given the current index, item count, and a key.
 * Wraps at both ends; understands arrows and Vim's `j`/`k`. Returns the index
 * unchanged for any other key. Pure, so the menu logic is unit-testable.
 */
export function navigate(index: number, count: number, key: Key): number {
	if (count <= 0) return 0;
	const up = key.type === 'up' || (key.type === 'char' && key.value === 'k');
	const down = key.type === 'down' || (key.type === 'char' && key.value === 'j');
	if (up) return (index - 1 + count) % count;
	if (down) return (index + 1) % count;
	return index;
}

// --- Raw-mode keypress reader ---

/**
 * Put stdin into raw mode and deliver each raw input chunk (as a string) to
 * `onData`. Returns a disposer that restores the previous mode. A no-op is
 * returned when stdin is not a TTY (callers should guard before relying on it).
 * This is the low-level primitive behind {@link readKeys}; the line editor uses
 * it directly so it can keep multi-character chunks (e.g. a pasted token) whole.
 */
function rawInput(onData: (chunk: string) => void): () => void {
	const stdin = process.stdin;
	if (!stdin.isTTY) return () => {};
	registerTerminalRestore();

	const wasRaw = stdin.isRaw === true;
	const handler = (buf: Buffer): void => onData(buf.toString('utf8'));
	stdin.setRawMode(true);
	stdin.resume();
	stdin.on('data', handler);

	return () => {
		stdin.off('data', handler);
		try {
			stdin.setRawMode(wasRaw);
		} catch {
			// ignore — stdin already restored/closed
		}
		stdin.pause();
	};
}

/**
 * Put stdin into raw mode and deliver decoded keys to `onKey`. Returns a
 * disposer that restores the previous mode. A no-op resolver is returned when
 * stdin is not a TTY (callers should guard before relying on keys).
 */
function readKeys(onKey: (key: Key) => void): () => void {
	return rawInput((chunk) => onKey(parseKey(chunk)));
}

// --- Spinner (no-op off-TTY) ---

export function spinner(message: string): { stop: (final?: string) => void } {
	if (!process.stdout.isTTY) {
		out(message);
		return { stop: (final) => final && out(final) };
	}
	const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
	let i = 0;
	process.stdout.write(CURSOR_HIDE);
	const timer = setInterval(() => {
		process.stdout.write(`\r${CLEAR_LINE}${c.accent(frames[i])} ${message}`);
		i = (i + 1) % frames.length;
	}, 80);
	return {
		stop: (final) => {
			clearInterval(timer);
			process.stdout.write(`\r${CLEAR_LINE}${CURSOR_SHOW}`);
			if (final) out(final);
		}
	};
}

// --- Line-based prompts ---

export interface PromptOptions {
	/** Pre-filled value, also returned verbatim when there is no TTY. */
	default?: string;
	/** Re-ask until a non-empty value is given (ignored without a default off-TTY). */
	required?: boolean;
	/** Validate the trimmed input; return an error string to re-ask. */
	validate?: (value: string) => string | undefined;
	/** Mask the value (live echo + summary) — for secrets like tunnel tokens. */
	secret?: boolean;
}

/**
 * Ask for a line of text. A dim footer shows that Enter submits and Esc / Ctrl+C
 * cancels (rejecting with a {@link CancelError}); a failed `validate` keeps you
 * editing with the error shown. Multi-character chunks (e.g. a pasted token) are
 * kept whole. Falls back to the default (or throws) without a TTY.
 */
export function prompt(question: string, opts: PromptOptions = {}): Promise<string> {
	if (!process.stdin.isTTY) {
		if (opts.default !== undefined) return Promise.resolve(opts.default);
		return Promise.reject(new Error(`Missing required input in non-interactive mode: ${question}`));
	}

	const defHint = opts.default ? c.dim(` (${opts.default})`) : '';

	return new Promise<string>((resolve, reject) => {
		let value = '';
		let error = '';

		const masked = (s: string): string => (opts.secret ? '•'.repeat(s.length) : s);

		const render = (): void => {
			const line1 = `${c.accent('?')} ${question}${defHint}: ${masked(value)}`;
			const line2 = error ? c.yellow(`  ${error}`) : c.dim('  Enter submit · Esc cancel');
			const col = plainLen(line1) + 1;
			// The cursor lives at the end of `value`; repaint from there clearing
			// downward, then put it back after the text being edited.
			process.stdout.write(`\r${CLEAR_DOWN}${line1}\n${line2}\x1b[1A\x1b[${col}G`);
		};

		const cleanup = (): void => {
			dispose();
			process.stdout.write(`\r${CLEAR_DOWN}`);
		};

		// Submitting leaves a compact `✓ question: value` line behind instead of
		// erasing, so multi-step wizards accumulate their answers on screen rather
		// than wiping each step. Cancelling still erases (it's a step-back).
		const finish = (v: string): void => {
			dispose();
			const shown = v ? c.bold(masked(v)) : c.dim('—');
			process.stdout.write(`\r${CLEAR_DOWN}${c.accent('✓')} ${question}: ${shown}\n`);
		};

		const submit = (): void => {
			const v = value.trim() || opts.default || '';
			if (!v && opts.required) {
				error = 'required';
				render();
				return;
			}
			const validationError = v ? opts.validate?.(v) : undefined;
			if (validationError) {
				error = validationError;
				render();
				return;
			}
			finish(v);
			resolve(v);
		};

		const dispose = rawInput((chunk) => {
			if (chunk === '\r' || chunk === '\n') return submit();
			if (chunk === '\x03' || chunk === '\x1b') {
				cleanup();
				reject(new CancelError());
				return;
			}
			if (chunk === '\x7f' || chunk === '\b') {
				value = value.slice(0, -1);
				error = '';
				render();
				return;
			}
			if (chunk.startsWith('\x1b')) return; // arrow / function keys — ignore
			const printable = [...chunk].filter((ch) => ch >= ' ' && ch !== '\x7f').join('');
			if (printable) {
				value += printable;
				error = '';
				render();
			}
		});

		render();
	});
}

/**
 * Yes/no confirmation. `y`/`n` answer immediately, Enter takes the default, and
 * Esc / Ctrl+C cancels (rejecting with a {@link CancelError}). Returns the
 * default without a TTY.
 */
export function confirm(question: string, opts: { default?: boolean } = {}): Promise<boolean> {
	const def = opts.default ?? false;
	if (!process.stdin.isTTY) return Promise.resolve(def);

	const line1 = `${c.accent('?')} ${question} ${c.dim(`(${def ? 'Y/n' : 'y/N'})`)} `;

	return new Promise<boolean>((resolve, reject) => {
		const render = (): void => {
			// Show the default explicitly in the footer so the user never has to
			// cross-reference the (Y/n) hint on the previous line.
			const line2 = c.dim(`  y / n · Enter = ${def ? 'yes' : 'no'} (default) · Esc cancel`);
			const col = plainLen(line1) + 1;
			process.stdout.write(`\r${CLEAR_DOWN}${line1}\n${line2}\x1b[1A\x1b[${col}G`);
		};

		const cleanup = (): void => {
			dispose();
			process.stdout.write(`\r${CLEAR_DOWN}`);
		};

		// Leave a `✓ question yes/no` line behind on answer so the wizard keeps its
		// history; cancelling (Esc) still erases.
		const finish = (val: boolean): void => {
			dispose();
			process.stdout.write(`\r${CLEAR_DOWN}${c.accent('✓')} ${question} ${c.bold(val ? 'yes' : 'no')}\n`);
		};

		const dispose = rawInput((chunk) => {
			if (chunk === '\x03' || chunk === '\x1b') {
				cleanup();
				reject(new CancelError());
				return;
			}
			if (chunk === '\r' || chunk === '\n') {
				finish(def);
				resolve(def);
				return;
			}
			const ch = chunk.toLowerCase();
			if (ch === 'y') {
				finish(true);
				resolve(true);
			} else if (ch === 'n') {
				finish(false);
				resolve(false);
			}
		});

		render();
	});
}

// --- Arrow-key select menu ---

export interface Choice<T> {
	label: string;
	value: T;
	hint?: string;
}

/**
 * Arrow-key single-select menu. Resolves with the chosen value, or rejects with
 * a {@link CancelError} on Esc / `q` / Ctrl+C. Requires a TTY.
 */
export function select<T>(title: string, choices: Choice<T>[], opts: { initialIndex?: number } = {}): Promise<T> {
	if (!process.stdin.isTTY) return Promise.reject(new Error('Interactive selection requires a TTY.'));
	if (choices.length === 0) return Promise.reject(new Error('No choices to select from.'));

	return new Promise<T>((resolve, reject) => {
		let index = Math.min(Math.max(opts.initialIndex ?? 0, 0), choices.length - 1);
		let rendered = 0;

		const footer = c.dim('  ↑/↓ navigate · Enter select · Esc cancel');
		const lineCount = choices.length + 2; // title + choices + footer

		const render = (): void => {
			const lines = [c.bold(title)];
			choices.forEach((choice, i) => {
				const active = i === index;
				const pointer = active ? c.accent('❯') : ' ';
				const label = active ? c.accent(choice.label) : choice.label;
				const hint = choice.hint ? c.dim(`  ${choice.hint}`) : '';
				lines.push(`${pointer} ${label}${hint}`);
			});
			lines.push(footer);

			let frame = rendered > 0 ? `\x1b[${rendered}A` : CURSOR_HIDE;
			frame += lines.map((line) => `${CLEAR_LINE}${line}`).join('\n') + '\n';
			process.stdout.write(frame);
			rendered = lineCount;
		};

		const close = (): void => {
			dispose();
			// Erase the menu so it doesn't pile up behind the next prompt/panel.
			if (rendered > 0) process.stdout.write(`\x1b[${rendered}A${CLEAR_DOWN}`);
			rendered = 0;
			process.stdout.write(CURSOR_SHOW);
		};

		// Selecting collapses the menu to a single `✓ title choice` line instead of
		// erasing it, so multi-step wizards keep their earlier answers on screen.
		const finish = (): void => {
			dispose();
			if (rendered > 0) process.stdout.write(`\x1b[${rendered}A${CLEAR_DOWN}`);
			rendered = 0;
			process.stdout.write(`${CURSOR_SHOW}${c.accent('✓')} ${title}: ${c.bold(choices[index].label)}\n`);
		};

		const dispose = readKeys((key) => {
			if (key.type === 'enter') {
				finish();
				resolve(choices[index].value);
				return;
			}
			if (key.type === 'escape' || key.type === 'ctrl-c' || (key.type === 'char' && key.value === 'q')) {
				close();
				out();
				reject(new CancelError());
				return;
			}
			const next = navigate(index, choices.length, key);
			if (next !== index) {
				index = next;
				render();
			}
		});

		render();
	});
}

// --- Cancelable long task ---

/**
 * Run an async task behind a spinner that the user can abort with Esc / `q` /
 * Ctrl+C. The task receives an `AbortSignal`; on abort it should reject, and
 * this rejects with a {@link CancelError}. Without a TTY there is nothing to
 * listen to, so it just runs the task behind a plain spinner.
 */
export async function runCancelable<T>(message: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();

	if (!process.stdin.isTTY) {
		const spin = spinner(message);
		try {
			return await run(controller.signal);
		} finally {
			spin.stop();
		}
	}

	const spin = spinner(`${message} ${c.dim('(Esc to cancel)')}`);
	const dispose = readKeys((key) => {
		if (key.type === 'escape' || key.type === 'ctrl-c' || (key.type === 'char' && key.value === 'q')) {
			controller.abort();
		}
	});
	try {
		const result = await run(controller.signal);
		spin.stop();
		return result;
	} catch (error) {
		spin.stop();
		if (controller.signal.aborted) throw new CancelError();
		throw error;
	} finally {
		dispose();
	}
}

// --- Clipboard (best-effort) ---

/** Copy text to the OS clipboard if a helper is available; silent on failure. */
export function copyToClipboard(text: string): boolean {
	const { platform } = process;
	const tool = platform === 'darwin' ? 'pbcopy' : platform === 'win32' ? 'clip' : 'xclip';
	const args = platform === 'linux' ? ['-selection', 'clipboard'] : [];
	try {
		const proc = spawn(tool, args, { stdio: ['pipe', 'ignore', 'ignore'] });
		proc.on('error', () => {});
		proc.stdin?.end(text);
		return true;
	} catch {
		return false;
	}
}

// --- Live dashboard ---

/** Format a millisecond span as `HH:MM:SS` (or `MM:SS` under an hour). */
export function formatUptime(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number) => String(n).padStart(2, '0');
	return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** What `runSession` needs from the CLI layer to start an additional tunnel. */
export interface SessionHooks {
	/**
	 * Run the interactive "add a tunnel" flow (mode select + prompts + start)
	 * against the session's `TunnelKit`. The panel is suspended (cooked mode)
	 * while this runs, then resumes. Resolve when done; throw to surface an error.
	 */
	addTunnel: () => Promise<void>;
	/**
	 * Run the interactive "manage saved tunnels" flow (pick from saved
	 * remotes/locals, then edit token/routes or forget). The panel is suspended
	 * while this runs, then resumes. Resolve when done; throw to surface an error.
	 */
	manageSaved: () => Promise<void>;
}

/** Visible width of a string, ignoring ANSI colour escapes. */
export function plainLen(s: string): number {
	// eslint-disable-next-line no-control-regex -- matching the ESC (\x1b) in SGR codes is the point
	return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/** Right-pad `s` to `width` visible characters (ANSI-aware). */
export function padEndPlain(s: string, width: number): string {
	const pad = width - plainLen(s);
	return pad > 0 ? s + ' '.repeat(pad) : s;
}

/** Left-pad `s` to `width` visible characters (ANSI-aware). */
export function padStartPlain(s: string, width: number): string {
	const pad = width - plainLen(s);
	return pad > 0 ? ' '.repeat(pad) + s : s;
}

/**
 * Truncate `s` to `width` characters, appending `…` when it overflows. Assumes
 * `s` carries no ANSI codes (callers should colour after truncating).
 */
export function truncatePlain(s: string, width: number, ellipsis = '…'): string {
	if (width <= 0) return '';
	if (s.length <= width) return s;
	if (width <= ellipsis.length) return ellipsis.slice(0, width);
	return s.slice(0, width - ellipsis.length) + ellipsis;
}

/**
 * Compute the box width and per-column widths used by {@link renderDashboard}.
 * Pure so the layout can be unit-tested without driving a terminal.
 *
 * The row layout, inside the box, is:
 *
 *   `❯` (1) · space · `●` (1) · 2 spaces · name · 2 spaces · url
 *
 * The name column is sized to its widest entry; the URL column absorbs the
 * remaining width (and is truncated with `…` if a single URL is longer than the
 * terminal allows). Connection counts live in the status dot, not as a column.
 */
export function computeBoxLayout(
	items: { name: string; url: string }[],
	termCols: number
): { boxWidth: number; nameWidth: number; urlWidth: number } {
	const MIN_BOX = 50;
	const MAX_BOX = 110;
	const SIDE_MARGIN = 4; // 2-space indent left + 2-space safety right
	const usableTerm = Math.max(MIN_BOX, termCols - SIDE_MARGIN);
	const targetBox = Math.min(MAX_BOX, usableTerm);

	const nameWidth = Math.max(1, ...items.map((i) => i.name.length));
	const naturalUrl = Math.max(1, ...items.map((i) => i.url.length));

	// Fixed (non-URL) inner content width:
	//   ❯(1) + space(1) + ●(1) + 2 spaces + name + 2 spaces + →(1) + 2 spaces
	// Plus the box's own 1-space padding on each side = +2 for the box.
	const fixedNonUrl = 1 + 1 + 1 + 2 + nameWidth + 2 + 1 + 2;
	const desiredBox = fixedNonUrl + 2 /* box padding */ + 2 /* border */ + naturalUrl;
	const boxWidth = Math.max(MIN_BOX, Math.min(targetBox, desiredBox));

	// What remains inside the box (between │ … │) minus the 2-space inner padding
	// minus the fixed non-URL columns is the URL's room.
	const innerWidth = boxWidth - 2 /* borders */ - 2 /* padding */;
	const urlWidth = Math.max(8, innerWidth - fixedNonUrl);

	return { boxWidth, nameWidth, urlWidth };
}


/**
 * Format a tunnel's "main row": `❯ ● name  →  url`. The status dot signals
 * health (connected / connecting / disconnected) and blinks at 1 Hz while the
 * tunnel is in its "no connections yet" startup window.
 */
function formatTunnelRow(opts: {
	selected: boolean;
	healthy: boolean;
	isConnecting: boolean;
	blinkOn: boolean;
	stoppingHighlight: boolean;
	name: string;
	url: string;
	nameWidth: number;
	urlWidth: number;
}): string {
	const caret = opts.selected ? c.accent('❯') : ' ';
	const dot = opts.stoppingHighlight
		? c.yellow('●')
		: opts.healthy
			? c.accent('●')
			: opts.isConnecting
				? (opts.blinkOn ? c.accent('●') : c.dim('○'))
				: c.dim('○');
	const namePadded = padEndPlain(opts.name, opts.nameWidth);
	const nameColored = opts.selected ? c.bold(namePadded) : namePadded;
	const urlTrunc = truncatePlain(opts.url, opts.urlWidth);
	const urlColored = c.dim(urlTrunc);
	return `${caret} ${dot}  ${nameColored}  ${c.dim('→')}  ${urlColored}`;
}

/**
 * Render the whole dashboard frame (box + footer + optional flash). Pure so
 * layout/colour decisions can be exercised by tests. The caller is responsible
 * for taking a snapshot of `tk.list()` and supplying connection counts.
 */
export function renderDashboard(opts: {
	tunnels: {
		name: string;
		type: string;
		publicUrl: string;
		connections: number;
		routes: { hostname: string; service: string }[];
		startedAt?: string;
	}[];
	cursor: number;
	stopping: boolean;
	flash: string;
	termCols: number;
	now?: number;
}): string[] {
	const lines: string[] = [];

	if (opts.tunnels.length === 0) {
		lines.push('');
		lines.push(c.dim('   nothing running yet'));
	}

	const items = opts.tunnels.map((t) => ({
		name: t.name,
		url: t.routes.length >= 1 ? `${t.routes.length} route${t.routes.length === 1 ? '' : 's'}` : t.publicUrl || '—'
	}));
	const nameWidth = Math.max(1, ...items.map((i) => i.name.length));
	// urlWidth: terminal width minus indent(2) + caret+space(2) + dot+2sp(3) + name + arrow area(7)
	const urlWidth = Math.max(8, opts.termCols - nameWidth - 14);

	const now = opts.now ?? Date.now();
	// Blink at 1 Hz (500ms on, 500ms off) while a freshly-started tunnel has
	// no connections yet. After CONNECTING_WINDOW_MS the dot falls back to a
	// steady `○` so a tunnel that's actually broken doesn't look "loading".
	const blinkOn = Math.floor(now / 500) % 2 === 0;
	const CONNECTING_WINDOW_MS = 30_000;

	lines.push('');

	opts.tunnels.forEach((t, i) => {
		const item = items[i];
		const selected = i === opts.cursor;
		const healthy = t.connections > 0;
		const stoppingHighlight = opts.stopping && selected;
		const isConnecting =
			!healthy && t.startedAt !== undefined && now - new Date(t.startedAt).getTime() < CONNECTING_WINDOW_MS;

		lines.push(
			'  ' +
				formatTunnelRow({
					selected,
					healthy,
					isConnecting,
					blinkOn,
					stoppingHighlight,
					name: item.name,
					url: item.url,
					nameWidth,
					urlWidth
				})
		);

		// Subroutes: `- service → hostname` (local service first, then public
		// hostname) so the direction reads the same as the tunnel flow.
		// Shown for any tunnel with at least one named route (remote/local);
		// quick tunnels have no routes so they always show the URL inline.
		if (t.routes.length >= 1) {
			for (const r of t.routes) {
				const sub = truncatePlain(`${r.service}  →  ${r.hostname}`, urlWidth + nameWidth);
				lines.push('  ' + c.dim(`       - ${sub}`));
			}
		}
	});

	if (opts.flash) {
		lines.push('');
		lines.push('   ' + c.accent2(opts.flash));
	}

	lines.push('');
	lines.push(
		'   ' +
			c.accent('↑/↓') +
			c.dim(' select   ') +
			c.accent('n') +
			c.dim(' new   ') +
			c.accent('x') +
			c.dim(' stop   ') +
			c.accent('c') +
			c.dim(' copy   ') +
			c.accent('m') +
			c.dim(' manage   ') +
			c.accent('q') +
			c.dim(' quit')
	);

	return lines;
}

/**
 * Persistent multi-tunnel control panel. Lists every tunnel `tk` is running with
 * a live status, lets you start more (`n`), stop the highlighted one (`x`), copy
 * its URL (`c`), forget a saved one (`f`), and quit (`q` / Ctrl+C, stops
 * everything). Without a TTY it prints a static summary and idles until a
 * signal — the old foreground behaviour, so pipes and CI are unaffected.
 */
export function runSession(tk: TunnelKit, hooks: SessionHooks): void {
	// --- Non-TTY: static summary of whatever is running, then idle on signals. ---
	if (!process.stdout.isTTY) {
		for (const t of tk.list()) {
			if (t.publicUrl) out(`\n  ${c.accent('●')} ${c.bold(t.publicUrl)}`);
			for (const rule of t.ingress ?? []) {
				if (rule.hostname) out(c.dim(`    ${rule.hostname} → ${rule.service}`));
			}
		}
		out(c.dim('\nPress Ctrl+C to stop.'));
		installSignalStop(() => tk.stopAll());
		return;
	}

	// Run the whole panel on the alternate screen buffer so it never leaves a
	// trail in the user's scrollback — on exit the normal screen is restored
	// exactly as it was. Renders are painted from the home position each time.
	process.stdout.write(ENTER_ALT + CURSOR_HIDE);

	let cursor = 0;
	// Starts suspended: nothing is drawn until begin() decides (panel or add flow).
	let suspended = true;
	let stopping = false;
	let flashMsg = '';
	let flashUntil = 0;
	let dispose: () => void = () => {};
	let ticker: ReturnType<typeof setInterval> | undefined;

	const setFlash = (msg: string): void => {
		flashMsg = msg;
		flashUntil = Date.now() + 2500;
	};

	const render = (): void => {
		if (suspended) return;
		const tunnels = tk.list();
		cursor = tunnels.length === 0 ? 0 : Math.min(Math.max(cursor, 0), tunnels.length - 1);

		const flash = Date.now() < flashUntil ? flashMsg : '';
		const termCols = process.stdout.columns ?? 80;

		const lines = renderDashboard({
			tunnels: tunnels.map((t) => ({
				name: t.name ?? t.service ?? t.id,
				type: t.type,
				publicUrl: t.publicUrl,
				connections: t.connections.length,
				routes: (t.ingress ?? [])
					.filter((r): r is IngressInfo & { hostname: string } => !!r.hostname)
					.map((r) => ({ hostname: r.hostname, service: r.service })),
				startedAt: t.startedAt
			})),
			cursor,
			stopping,
			flash,
			termCols
		});

		// Repaint from the top of the (alternate) screen, clearing whatever was
		// below — so the panel never stacks and old frames never linger.
		process.stdout.write(CURSOR_HIDE + CURSOR_HOME + CLEAR_DOWN + lines.join('\n') + '\n');
	};

	// `status-changed` fires on connection up/down too (each ActiveTunnel carries
	// its live `connections`), so a single render handler keeps the panel current.
	const onStatus = (): void => render();
	const onIngress = (): void => render();

	tk.on('status-changed', onStatus);
	tk.on('ingress-update', onIngress);

	const suspend = (): void => {
		suspended = true;
		if (ticker) {
			clearInterval(ticker);
			ticker = undefined;
		}
		dispose();
		dispose = () => {};
		// Clear the screen so the wizard's prompts start clean, and show the cursor.
		process.stdout.write(CURSOR_HOME + CLEAR_DOWN + CURSOR_SHOW);
	};

	const resume = (): void => {
		suspended = false;
		dispose = readKeys(onKey);
		// 2 Hz (500ms) ticker matches the blink phase length (500ms on/off) so
		// each tick flips the blink state exactly once. Status-changed events
		// trigger immediate repaints so the ticker is only for the animation.
		ticker = setInterval(render, 500);
		render();
	};

	const addAndResume = async (): Promise<void> => {
		suspend();
		try {
			await hooks.addTunnel();
		} catch (error) {
			if (!(error instanceof CancelError)) {
				errLine(c.red(`  ${error instanceof Error ? error.message : String(error)}`));
			}
		} finally {
			resume();
		}
	};

	const manageAndResume = async (): Promise<void> => {
		suspend();
		try {
			await hooks.manageSaved();
		} catch (error) {
			if (!(error instanceof CancelError)) {
				errLine(c.red(`  ${error instanceof Error ? error.message : String(error)}`));
			}
		} finally {
			resume();
		}
	};

	// Copy a tunnel's URL to the clipboard. A tunnel can serve many hostnames, so
	// when there's more than one route, suspend the panel and let the user pick
	// which URL to copy; a single-route (or quick) tunnel copies straight away.
	const copyUrl = async (t: ActiveTunnel): Promise<void> => {
		const routes = (t.ingress ?? []).filter((r): r is IngressInfo & { hostname: string } => !!r.hostname);
		if (routes.length <= 1) {
			if (t.publicUrl && copyToClipboard(t.publicUrl)) setFlash('copied URL to clipboard');
			render();
			return;
		}

		suspend();
		let picked: string | undefined;
		try {
			picked = await select(
				'Copy which URL?',
				routes.map((r) => ({ label: `https://${r.hostname}`, value: `https://${r.hostname}`, hint: r.service }))
			);
		} catch {
			// Esc / q / Ctrl+C — cancel the copy and just return to the panel.
		}
		if (picked && copyToClipboard(picked)) setFlash(`copied ${picked}`);
		resume();
	};

	const leave = (): void => {
		if (ticker) clearInterval(ticker);
		dispose();
		tk.off('status-changed', onStatus);
		tk.off('ingress-update', onIngress);
		// Back to the normal screen — scrollback is exactly as the user left it.
		process.stdout.write(LEAVE_ALT + CURSOR_SHOW);
	};

	/**
	 * Stop a single tunnel after confirming when it has live connections. With
	 * zero connections a stop just yanks a quiet tunnel — no prompt needed. With
	 * ≥1 connection, "stop" also kills in-flight traffic, so we ask first.
	 */
	const stopWithConfirm = async (t: ActiveTunnel): Promise<void> => {
		if (t.connections.length === 0) {
			setFlash(`stopped ${t.name ?? t.service ?? t.id}`);
			void tk.stop(t.id).then(render);
			return;
		}
		suspend();
		let ok = false;
		try {
			ok = await confirm(
				`Stop "${t.name ?? t.service ?? t.id}"? It has ${t.connections.length} active connection${t.connections.length === 1 ? '' : 's'}.`,
				{ default: false }
			);
		} catch {
			// Esc/Ctrl+C from the confirm prompt — just resume the panel.
		}
		if (ok) {
			setFlash(`stopped ${t.name ?? t.service ?? t.id}`);
			void tk.stop(t.id).then(render);
		}
		resume();
	};

	/**
	 * Quit the panel. With `confirmIfActive: true` and any live connections, ask
	 * before tearing everything down — used by the panel's `q` / Ctrl+C. SIGTERM
	 * is an external kill and skips the prompt.
	 */
	const quit = async (opts: { confirmIfActive?: boolean } = {}): Promise<void> => {
		if (stopping) return;
		if (opts.confirmIfActive) {
			const tunnels = tk.list();
			const totalCount = tunnels.length;
			const activeCount = tunnels.filter((t) => t.connections.length > 0).length;
			if (activeCount > 0) {
				suspend();
				let ok = false;
				try {
					ok = await confirm(
						`Stop all ${totalCount} tunnel${totalCount === 1 ? '' : 's'} (${activeCount} with active connections) and quit?`,
						{ default: false }
					);
				} catch {
					// cancelled
				}
				if (!ok) {
					resume();
					return;
				}
			}
		}
		stopping = true;
		suspended = true;
		leave();
		out(c.dim('Stopping…'));
		await tk.stopAll();
		process.exit(0);
	};

	function onKey(key: Key): void {
		if (suspended) return;
		if (key.type === 'ctrl-c' || (key.type === 'char' && key.value === 'q')) {
			void quit({ confirmIfActive: true });
			return;
		}
		if (key.type === 'char' && key.value === 'n') {
			void addAndResume();
			return;
		}
		if (key.type === 'char' && key.value === 'm') {
			void manageAndResume();
			return;
		}
		const tunnels = tk.list();
		if (tunnels.length === 0) return;
		const current = tunnels[cursor];
		if (key.type === 'char' && (key.value === 'x' || key.value === 'd')) {
			if (current) void stopWithConfirm(current);
			return;
		}
		if (key.type === 'char' && key.value === 'c') {
			if (current) void copyUrl(current);
			return;
		}
		const next = navigate(cursor, tunnels.length, key);
		if (next !== cursor) {
			cursor = next;
			render();
		}
	}

	// One process-level SIGINT listener for the whole session. It prevents Node's
	// default hard-kill, but no-ops while suspended so Ctrl+C during a wizard
	// prompt cancels only that prompt (handled by prompt/select) instead of
	// tearing everything down. In the panel itself Ctrl+C arrives as a key, so
	// this is a safety net for stray external SIGINTs.
	process.on('SIGINT', () => {
		if (!suspended) void quit({ confirmIfActive: true });
	});
	// SIGTERM is an external kill (e.g. `kill <pid>`) — don't gate it on a
	// confirm prompt the user can't see.
	process.on('SIGTERM', () => void quit());

	// With nothing running yet, skip the empty panel and go straight to the
	// add-a-tunnel flow. Whether the user starts a tunnel or backs out, we then
	// land on the panel — Esc only ever steps back, quitting is an explicit `q`.
	const begin = async (): Promise<void> => {
		if (tk.list().length === 0) {
			process.stdout.write(CURSOR_HOME + CLEAR_DOWN + CURSOR_SHOW);
			try {
				await hooks.addTunnel();
			} catch (error) {
				if (!(error instanceof CancelError)) {
					errLine(c.red(`  ${error instanceof Error ? error.message : String(error)}`));
				}
			}
		}
		resume();
	};

	void begin();
}

/** Stop on the next SIGINT/SIGTERM (used by the non-TTY dashboard fallback). */
function installSignalStop(onStop: () => Promise<void>): void {
	let stopping = false;
	const shutdown = async (): Promise<void> => {
		if (stopping) return;
		stopping = true;
		out(c.dim('\nStopping…'));
		await onStop();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}
