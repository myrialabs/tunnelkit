/**
 * Optional logging interface.
 *
 * tunnelkit never writes to the console on its own. Pass a `Logger` to a
 * `TunnelKit` (or the binary helpers) to receive diagnostics; omit it and
 * everything stays silent. The shape is intentionally `console`-compatible so
 * you can pass `console` directly, or adapt your own logger.
 */
export interface Logger {
	log?(...args: unknown[]): void;
	warn?(...args: unknown[]): void;
	error?(...args: unknown[]): void;
}

/** A logger that discards everything. */
export const noopLogger: Required<Logger> = {
	log() {},
	warn() {},
	error() {}
};

/** Normalize a partial logger into one with all methods present. */
export function resolveLogger(logger?: Logger): Required<Logger> {
	if (!logger) return noopLogger;
	return {
		log: logger.log?.bind(logger) ?? noopLogger.log,
		warn: logger.warn?.bind(logger) ?? noopLogger.warn,
		error: logger.error?.bind(logger) ?? noopLogger.error
	};
}
