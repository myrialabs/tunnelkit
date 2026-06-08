#!/usr/bin/env node

/**
 * tunnelkit CLI
 *
 * A thin, batteries-included command line over {@link TunnelKit}, so the library
 * can also be used directly from a terminal (`npm i -g tunnelkit` / `bun add -g
 * tunnelkit`). Commands are grouped by the mode they belong to, so it's always
 * clear which mode an operation is for:
 *
 *   tunnelkit                            Interactive menu (when run in a terminal)
 *
 *   tunnelkit quick <port|url>           Quick TryCloudflare tunnel (no account)
 *
 *   tunnelkit remote run [name]          Token-based (dashboard-managed) tunnel
 *
 *   tunnelkit local login | logout       Cloudflare authentication
 *   tunnelkit local run <name> --route … Named tunnel (create → route → run)
 *   tunnelkit local list                 List named tunnels on the account
 *   tunnelkit local delete <name|id>     Delete a named tunnel
 *
 *   tunnelkit saved | forget <name>      Inspect / remove locally-saved tunnels
 *   tunnelkit install [version]          Download the cloudflared binary
 *   tunnelkit status                     Show binary status
 *   tunnelkit version | help
 *
 * Terminal I/O lives in `cli-ui.ts`; shared infrastructure (kit/store factories,
 * start helpers, validators) in `cli-helpers.ts`; command handlers in
 * `cli-commands.ts`; interactive panel flows in `cli-flows.ts`. This file is
 * the dispatch layer and `main` entry point.
 */

import { CloudflaredMissingError } from './cloudflared-tunnel.js';
import { parseCliArgs, type ParsedArgs } from './cli-args.js';
import { c, out, errLine, CancelError } from './cli-ui.js';
import { readVersion, isInteractive, makeKit } from './cli-helpers.js';
import { enterSession } from './cli-flows.js';
import { COMMANDS, NAMESPACES } from './cli-commands.js';

function parseRest(argv: string[]): ParsedArgs {
	return parseCliArgs(argv, {
		booleans: ['verbose', 'help', 'force', 'no-save', 'yes'],
		aliases: { h: 'help', v: 'version', y: 'yes' }
	});
}

function unknown(message: string): never {
	errLine(c.red(message));
	errLine(c.dim('Run `tunnelkit help` for usage.'));
	process.exit(1);
}

function showHelp(version: string): void {
	out(`
${c.accent('tunnelkit')} ${c.dim(`v${version}`)} — Cloudflare Tunnels from your terminal

${c.bold('USAGE')}
  tunnelkit                    Open the interactive menu (in a terminal)
  tunnelkit <command> [options]

${c.bold('QUICK')} ${c.dim('— instant tunnel, no account')}
  quick <port|url>             Start a quick TryCloudflare tunnel (port → localhost:<port>)

${c.bold('REMOTE')} ${c.dim('— token / dashboard-managed')}
  remote run [name]            Run a token-based tunnel (--token, CF_TUNNEL_TOKEN, or a saved name)

${c.bold('LOCAL')} ${c.dim('— named tunnel (needs a Cloudflare account)')}
  local login                  Authenticate with Cloudflare
  local logout                 Remove the stored origin certificate
  local run <name>             Create + route + run a named tunnel
  local list                   List named tunnels on the account
  local delete <name|id>       Delete a named tunnel (from Cloudflare)

${c.bold('GENERAL')}
  saved                        List tunnels saved locally for reuse (remote + local)
  forget <name>                Remove a saved tunnel (local tunnels also delete from Cloudflare)
  dashboard                    Print a shortcut link to the Cloudflare Tunnels dashboard
  install [version]            Download the cloudflared binary (default: latest)
  status                       Show the cloudflared binary status
  version                      Print the tunnelkit version
  help                         Show this help

${c.bold('OPTIONS')}
  --auto-stop <minutes>        quick: minutes until auto-stop (default 0 — never)
  --token <token>              remote run: tunnel token (or set CF_TUNNEL_TOKEN)
  --name <name>                remote run: name used to save & reuse the token
  --id <id>                    remote run: stable id for the tunnel (default cli-remote)
  --route <hostname=service>   local run: ingress rule (repeatable)
  --hostname <host>            local run: single ingress hostname (pair with --service)
  --service <url>              local run: single ingress service URL
  --yes, -y                    skip confirmation prompts (e.g. local delete)
  --no-save                    don't read or write the saved-config store for this run
  --data-dir <dir>             override the data dir (default ~/.tunnelkit)
  --install-dir <dir>          override the binary dir (default ~/.tunnelkit/bin)
  --verbose                    print library diagnostics to stderr
  -h, --help                   show help
  -v, --version                show version

${c.bold('INTERACTIVE')}
  Run ${c.accent('tunnelkit')} with no command in a terminal for a live control panel.
  Run many tunnels at once and manage them together:
    ${c.bold('[↑/↓]')} select · ${c.bold('[n]')} new tunnel · ${c.bold('[x]')} stop · ${c.bold('[c]')} copy URL · ${c.bold('[m]')} manage saved · ${c.bold('[q]')} quit
  Starting a tunnel by command (e.g. ${c.accent('tunnelkit quick 3000')}) drops into the
  same panel, so you can add more from there.

${c.bold('EXAMPLES')}
  tunnelkit                                  # interactive control panel
  tunnelkit quick 3000
  tunnelkit quick http://localhost:8080 --auto-stop 30
  tunnelkit remote run --token "$CF_TUNNEL_TOKEN" --name prod
  tunnelkit remote run prod                  # reuse the saved "prod" token
  tunnelkit local login
  tunnelkit local run my-app --route app.example.com=http://localhost:3000
  tunnelkit local run my-app                 # rerun the saved "my-app" tunnel
  tunnelkit install 2024.12.2

Docs: https://github.com/myrialabs/tunnelkit
`);
}

/** Bare `tunnelkit` in a terminal: open the session panel with nothing running yet. */
function interactiveHome(base: ParsedArgs): void {
	enterSession(makeKit(base));
}

async function main(): Promise<void> {
	const version = readVersion();
	const argv = process.argv.slice(2);
	const command = argv[0];

	if (command === 'help' || command === '-h' || command === '--help') {
		showHelp(version);
		return;
	}
	if (command === 'version' || command === '-v' || command === '--version') {
		out(`v${version}`);
		return;
	}

	if (!command || command.startsWith('-')) {
		if (isInteractive()) {
			interactiveHome(parseRest(argv));
			return;
		}
		showHelp(version);
		return;
	}

	const namespace = NAMESPACES[command];
	if (namespace) {
		const verb = argv[1];
		const verbs = Object.keys(namespace).join(', ');
		if (!verb) unknown(`\`tunnelkit ${command}\` needs a subcommand: ${verbs}. e.g. \`tunnelkit ${command} run\`.`);
		const nested = namespace[verb];
		if (!nested) unknown(`Unknown ${command} subcommand: ${verb}. Expected one of: ${verbs}.`);
		await nested(parseRest(argv.slice(2)));
		return;
	}

	const handler = COMMANDS[command];
	if (!handler) unknown(`Unknown command: ${command}`);
	await handler(parseRest(argv.slice(1)));
}

main().catch((error) => {
	if (error instanceof CancelError) {
		process.exit(130);
	}
	if (error instanceof CloudflaredMissingError) {
		errLine(c.red('cloudflared is not available.'));
		errLine(c.dim('Run `tunnelkit install` to download it, or install it system-wide.'));
	} else {
		errLine(c.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
	}
	process.exit(1);
});
