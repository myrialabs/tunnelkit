# Quick start

tunnelkit wraps the `cloudflared` binary in a typed API and a `tunnelkit` CLI.
This page gets you from nothing installed to a public URL, both ways.

## Requirements

- Node.js 18+ or Bun.
- The `cloudflared` binary — tunnelkit downloads it for you on first use (into
  `~/.tunnelkit/bin`), or reuses one already on `PATH` (e.g. from `brew` or
  `apt`). You never need to install it manually.

## As a library

```sh
npm install @myrialabs/tunnelkit
# or: bun add @myrialabs/tunnelkit
```

```ts
import { TunnelKit } from '@myrialabs/tunnelkit';

const tk = new TunnelKit();
await tk.bin.ensure(); // downloads cloudflared on first run, otherwise a no-op

const { publicUrl } = await tk.quick.start({ service: 3000 });
console.log('Exposed at:', publicUrl); // → https://random-words.trycloudflare.com

process.on('SIGINT', async () => {
	await tk.stopAll();
	process.exit(0);
});
```

`service` accepts a bare port (shorthand for `http://localhost:<port>`) or a
full URL. This is a **Quick** tunnel — no Cloudflare account needed. See
[Tunnel modes](../essential/tunnel-modes.md) for Remote and Local.

## As a CLI

```sh
npm install -g @myrialabs/tunnelkit
# or: bun add -g @myrialabs/tunnelkit

tunnelkit quick 3000
```

`cloudflared` is downloaded automatically the first time it's needed. In a
terminal, `tunnelkit quick 3000` prints the public URL and then opens the
[interactive control panel](../operations/cli.md#interactive-mode); outside a
TTY it runs in the foreground until stopped.

Run `tunnelkit` with no arguments at any time for the live control panel —
view every running tunnel, start another, stop one, or copy a URL, all from
one screen.

## Where to next

- [Tunnel modes](../essential/tunnel-modes.md) — Quick vs. Remote vs. Local,
  and which one fits your use case.
- [CLI reference](../operations/cli.md) — every command and flag.
- [API reference](../reference/api.md) — every export, option, and event.
- [Examples](../../examples/README.md) — runnable scenarios for each mode.
