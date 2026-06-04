/**
 * Case: plug in your own logger.
 *
 * tunnelkit is silent unless you pass a logger. Any object with `log`/`warn`/
 * `error` works — wire it to pino, winston, your own debug module, etc. Here we
 * just prefix and tag levels.
 *
 * Run with:  bun run examples/custom-logger.ts 3000
 */

import { TunnelKit, type Logger } from '../src/index.js';

const logger: Logger = {
	log: (...args) => console.log('[tunnelkit]', ...args),
	warn: (...args) => console.warn('[tunnelkit:warn]', ...args),
	error: (...args) => console.error('[tunnelkit:error]', ...args)
};

const tk = new TunnelKit({ logger });
if (!tk.isBinaryInstalled()) await tk.installBinary();

const service = process.argv[2] ?? '3000';
const { publicUrl } = await tk.quick.start({ service });
console.log('URL:', publicUrl);

process.on('SIGINT', async () => {
	await tk.stopAll();
	process.exit(0);
});
