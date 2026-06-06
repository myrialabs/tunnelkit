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
import type { TunnelKit } from './manager.js';
import type { ActiveTunnel, IngressInfo } from './types.js';

// --- Colour (TTY-aware, honours NO_COLOR) ---

export const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string): string => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
	cyan: paint('36'),
	green: paint('32'),
	red: paint('31'),
	yellow: paint('33'),
	dim: paint('2'),
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
		process.stdout.write(`\r${CLEAR_LINE}${c.cyan(frames[i])} ${message}`);
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
			const line1 = `${c.cyan('?')} ${question}${defHint}: ${masked(value)}`;
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
			process.stdout.write(`\r${CLEAR_DOWN}${c.green('✓')} ${question}: ${shown}\n`);
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

	const line1 = `${c.cyan('?')} ${question} ${c.dim(`(${def ? 'Y/n' : 'y/N'})`)} `;

	return new Promise<boolean>((resolve, reject) => {
		const render = (): void => {
			const line2 = c.dim('  y / n · Enter for default · Esc cancel');
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
			process.stdout.write(`\r${CLEAR_DOWN}${c.green('✓')} ${question} ${c.bold(val ? 'yes' : 'no')}\n`);
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
				const pointer = active ? c.cyan('❯') : ' ';
				const label = active ? c.cyan(choice.label) : choice.label;
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
			process.stdout.write(`${CURSOR_SHOW}${c.green('✓')} ${title}: ${c.bold(choices[index].label)}\n`);
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
}

function pluralTunnels(n: number): string {
	return n === 1 ? '1 tunnel active' : `${n} tunnels active`;
}

/** Visible width of a string, ignoring ANSI colour escapes. */
function plainLen(s: string): number {
	// eslint-disable-next-line no-control-regex -- matching the ESC (\x1b) in SGR codes is the point
	return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/**
 * Persistent multi-tunnel control panel. Lists every tunnel `tk` is running with
 * a live status, lets you start more (`n`), stop the highlighted one (`x`), copy
 * its URL (`c`), and quit (`q` / Ctrl+C, stops everything). Without a TTY it
 * prints a static summary and idles until a signal — the old foreground
 * behaviour, so pipes and CI are unaffected.
 */
export function runSession(tk: TunnelKit, hooks: SessionHooks): void {
	// --- Non-TTY: static summary of whatever is running, then idle on signals. ---
	if (!process.stdout.isTTY) {
		for (const t of tk.list()) {
			if (t.publicUrl) out(`\n  ${c.green('●')} ${c.bold(t.publicUrl)}`);
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

	const startedAt = Date.now();
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

		const nameWidth = Math.max(0, ...tunnels.map((t) => plainLen(t.label ?? t.service ?? t.id)));

		const lines: string[] = [];
		lines.push(
			`${c.cyan('tunnelkit')} ${c.dim(`· ${pluralTunnels(tunnels.length)}`)}` +
				c.dim(`   up ${formatUptime(Date.now() - startedAt)}`)
		);
		lines.push('');

		if (tunnels.length === 0) {
			lines.push(c.dim('  nothing running yet — press n to start a tunnel'));
		} else {
			tunnels.forEach((t, i) => {
				const active = i === cursor;
				const conns = t.connections;
				const healthy = conns.length > 0;
				const dot = stopping && active ? c.yellow('●') : healthy ? c.green('●') : c.dim('○');
				const name = (t.label ?? t.service ?? t.id).padEnd(nameWidth);
				const label = active ? c.bold(name) : name;
				// Routes a remote/local tunnel actually serves (skip the catch-all rule).
				const routes = (t.ingress ?? []).filter((r): r is IngressInfo & { hostname: string } => !!r.hostname);
				const locs = conns.map((conn) => conn.location);
				const connStr = conns.length > 0
					? c.dim(`  ${conns.length} conn${conns.length === 1 ? '' : 's'}${locs.length ? ` ${locs.join(',')}` : ''}`)
					: '';
				// Header: a single URL when there's one route; a route count when there
				// are many (each one is then listed below, so don't repeat it here).
				const head = routes.length > 1
					? c.dim(`${routes.length} routes`)
					: t.publicUrl
						? c.cyan(t.publicUrl)
						: c.dim(t.type === 'quick' ? '…' : 'waiting for ingress…');
				lines.push(`${active ? c.cyan('❯') : ' '} ${dot} ${c.dim(t.type.padEnd(6))} ${label}  ${head}${connStr}`);
				// List every hostname → service mapping in an aligned column so all the
				// dashboard- or config-defined services are visible at a glance.
				if (routes.length > 1) {
					const hostWidth = Math.max(...routes.map((r) => r.hostname.length));
					for (const r of routes) lines.push(c.dim(`      ${r.hostname.padEnd(hostWidth)}  →  ${r.service}`));
				}
			});
		}

		if (Date.now() < flashUntil && flashMsg) {
			lines.push('');
			lines.push(`  ${c.green(flashMsg)}`);
		}

		lines.push('');
		lines.push(c.dim(tunnels.length > 0
			? '  ↑/↓ select · n new · x stop · c copy URL · q quit'
			: '  n new tunnel · q quit'));

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
		ticker = setInterval(render, 1000);
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

	const quit = async (): Promise<void> => {
		if (stopping) return;
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
			void quit();
			return;
		}
		if (key.type === 'char' && key.value === 'n') {
			void addAndResume();
			return;
		}
		const tunnels = tk.list();
		if (tunnels.length === 0) return;
		const current = tunnels[cursor];
		if (key.type === 'char' && (key.value === 'x' || key.value === 'd')) {
			if (current) {
				setFlash(`stopped ${current.label ?? current.service ?? current.id}`);
				void tk.stop(current.id).then(render);
			}
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
	// tearing everything down. In the panel itself Ctrl+C arrives as a key.
	process.on('SIGINT', () => {
		if (!suspended) void quit();
	});
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
