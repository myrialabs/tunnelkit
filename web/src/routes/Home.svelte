<script lang="ts">
	import { navigate } from '../lib/router.svelte.js';
	import { reveal } from '../lib/reveal.js';
	import CodeWindow from '../components/CodeWindow.svelte';

	const heroCode = `import { TunnelKit } from '@myrialabs/tunnelkit';

const tk = new TunnelKit();
await tk.bin.ensure();

const { publicUrl } = await tk.quick.start({ service: 3000 });

// → https://random-words.trycloudflare.com
console.log('Exposed at:', publicUrl);`;

	const modeBadges = ['quick', 'remote', 'local'];

	const timeline = [
		{
			title: 'Three tunnel modes, one typed namespace',
			body: 'Quick (TryCloudflare, no account), Remote (token-based, dashboard-managed), and Local (fully self-managed named tunnels) each live under their own tk.quick / tk.remote / tk.local — same start/stop/isActive shape across all three, so switching modes is a namespace swap, not a rewrite.',
			file: 'tk-modes.ts',
			code: `// Quick — no account, random *.trycloudflare.com
const { publicUrl } = await tk.quick.start({
  service: 3000,
  autoStopMinutes: 30,
});

// Remote — token from Cloudflare dashboard
const { ingress } = await tk.remote.start({
  id: 'my-app',
  token: process.env.CF_TUNNEL_TOKEN!,
});

// Local — named, full ingress control
await tk.local.start({
  id: 'storefront', name: 'acme-prod',
  tunnelId, credentialsFile,
  ingress: [{
    hostname: 'app.example.com',
    service: 'http://localhost:3000',
  }],
});`
		},
		{
			title: 'A live control panel for every tunnel at once',
			body: 'Run tunnelkit with no arguments in a terminal and get a full-screen panel over every running tunnel — start another with a breadcrumbed wizard, stop one, copy its URL, or manage saved tunnels, all without leaving the panel. Most cloudflared wrappers give you one process; this gives you a fleet view.',
			file: 'tunnelkit — control panel',
			code: `  tunnelkit > tunnels

  ❯ ●  quick-3000     →  https://abc.trycloudflare.com
    ○  prod           →  2 routes
        - http://localhost:4001  →  app.example.com
        - http://localhost:4002  →  api.example.com
    ●  storefront     →  1 route
        - http://localhost:3000  →  shop.example.com

  [↑/↓] select   [n] new tunnel   [x] stop   [c] copy URL
  [m] manage saved   [q] quit`
		},
		{
			title: 'Persist once, restore on every restart',
			body: 'Remote and local tunnels you start are saved to ~/.tunnelkit/config.json automatically (0600, owner-only). Quick tunnels stay ephemeral by design. Bring your app back up and tk.restoreAll() starts everything that was running before — no re-deriving tunnel state from your own database.',
			file: 'restore-on-startup.ts',
			code: `// Saves to ~/.tunnelkit/config.json by default.
const tk = new TunnelKit();

// Inspect what's saved
console.log(tk.store.getRemotes());
// → [{ id: 'prod', name: 'prod', token: '***' }]

// Restore everything on startup — one call
const { remotes, locals } = await tk.restoreAll();`
		}
	];

	const features = [
		{
			title: 'Zero runtime dependencies',
			desc: 'Pure Node built-ins. No node_modules to audit, no supply-chain surface — the library’s headline property.'
		},
		{
			title: 'Manages the binary',
			desc: 'tk.bin.ensure() downloads cloudflared on first use, or reuses one already on PATH from brew/apt/winget. Pin a version with tk.bin.install().'
		},
		{
			title: 'Fully typed events',
			desc: 'TunnelKit and CloudflaredTunnel are typed EventEmitters. status-changed, connection, and ingress-update, all with real payload types.'
		},
		{
			title: 'Cross-runtime',
			desc: 'Runs identically on Node 18+ and Bun — the same API, the same behavior, no runtime-specific branches leaking into your code.'
		},
		{
			title: 'Orphan tunnel recovery',
			desc: 'tk.local.create detects a same-named tunnel on Cloudflare that isn’t tracked locally and has no active connections, then cleans it up and retries.'
		},
		{
			title: 'Low-level escape hatch',
			desc: 'Drop down to CloudflaredTunnel for direct process control — raw url, connected, stdout/stderr events — when a mode’s abstraction isn’t enough.'
		}
	];

	function goDocs(): void {
		navigate('/docs/getting-started/quick-start');
	}
</script>

<div class="glow-orb glow-orb-1"></div>
<div class="glow-orb glow-orb-2"></div>
<div class="glow-orb glow-orb-3"></div>

<!-- HERO -->
<section class="hero">
	<div class="container">
		<div class="hero-badge">Open Source &middot; Zero Dependencies &middot; TypeScript</div>
		<h1>Expose localhost.<br /><span class="grad-text">Effortlessly.</span></h1>
		<p class="hero-desc">
			A typed, event-driven API and CLI over <strong>all three Cloudflare tunnel modes</strong> —
			Quick, Remote, and Local. Manages the binary, persists your tunnels, fires typed events.
			Zero dependencies. Runs on Node 18+ and Bun.
		</p>
		<div class="mode-badges">
			{#each modeBadges as m (m)}<span class="mode-badge">tk.{m}</span>{/each}
		</div>
		<div class="hero-cta">
			<button class="btn-primary" onclick={goDocs}>
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v8M5 7l3 3 3-3M2 12h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
				Get Started
			</button>
			<a href="https://github.com/myrialabs/tunnelkit" class="btn-secondary">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>
				View on GitHub
			</a>
		</div>
		<div class="hero-mockup-wrap">
			<CodeWindow title="quick-start.ts" code={heroCode} lang="typescript" />
		</div>
	</div>
</section>

<!-- TIMELINE -->
<section id="showcase" class="timeline-section">
	<div class="container">
		<div class="section-header">
			<div class="section-tag">See It In Action</div>
			<h2 class="section-title">Three things a plain<br /><span class="grad-text">cloudflared wrapper doesn't do</span></h2>
		</div>

		<div class="timeline">
			{#each timeline as row, i (row.title)}
				<div class="timeline-row" use:reveal={{ delay: (i % 3) * 100 }}>
					<div class="timeline-marker">
						<div class="dot"></div>
						{#if i < timeline.length - 1}<div class="line"></div>{/if}
					</div>
					<div class="timeline-content">
						<div class="timeline-text">
							<h3>{row.title}</h3>
							<p>{row.body}</p>
						</div>
						<div class="timeline-code">
							<CodeWindow title={row.file} code={row.code} lang="typescript" />
						</div>
					</div>
				</div>
			{/each}
		</div>
	</div>
</section>

<!-- FEATURES -->
<section id="features" class="features-section">
	<div class="container">
		<div class="section-header">
			<div class="section-tag">Everything Else</div>
			<h2 class="section-title">The rest of the<br /><span class="grad-text">tiny typed surface</span></h2>
		</div>
		<div class="features-grid">
			{#each features as f, i (f.title)}
				<div class="feature-card" use:reveal={{ delay: (i % 3) * 60 }}>
					<div class="feature-title">{f.title}</div>
					<div class="feature-desc">{f.desc}</div>
				</div>
			{/each}
		</div>
	</div>
</section>

<!-- INSTALL + CTA -->
<section id="install" class="install-section">
	<div class="container">
		<div class="section-header">
			<div class="section-tag">Installation</div>
			<h2 class="section-title">Install &amp; <span class="grad-text">start tunneling</span></h2>
			<p class="section-desc">Requires Node.js 18+ or Bun. The CLI auto-downloads cloudflared on first use, or call tk.bin.ensure() programmatically.</p>
		</div>
		<CodeWindow title="terminal" lang="bash" code={`$ npm install -g @myrialabs/tunnelkit

$ tunnelkit quick 3000`} />
		<p class="install-footnote">
			Prefer a library? <code>npm install @myrialabs/tunnelkit</code> &middot; or
			<code>bun add @myrialabs/tunnelkit</code>
		</p>
		<div class="install-cta">
			<button class="btn-primary" onclick={goDocs}>Read the docs</button>
			<a href="https://github.com/myrialabs/tunnelkit" class="btn-secondary">Star on GitHub</a>
		</div>
	</div>
</section>

<style>
	.hero {
		min-height: 100vh;
		display: flex; flex-direction: column;
		align-items: center; justify-content: center;
		text-align: center;
		padding: 120px 24px 80px;
		position: relative;
	}
	.hero-badge {
		display: inline-flex; align-items: center; gap: 8px;
		background: rgba(243, 128, 32, 0.1);
		border: 1px solid rgba(243, 128, 32, 0.3);
		border-radius: 100px;
		padding: 6px 16px;
		font-size: 12px; font-weight: 500;
		color: var(--accent-2);
		margin-bottom: 32px;
		letter-spacing: 0.5px;
		text-transform: uppercase;
	}
	.hero h1 { font-size: clamp(42px, 7vw, 80px); font-weight: 700; line-height: 1.08; letter-spacing: -2px; margin-bottom: 24px; max-width: 900px; margin-left: auto; margin-right: auto; }
	.hero-desc { font-size: clamp(16px, 2vw, 20px); color: var(--text-1); max-width: 640px; margin: 0 auto 28px; line-height: 1.7; text-align: center; }
	.hero-desc strong { color: var(--text-0); font-weight: 600; }

	.mode-badges { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; max-width: 620px; margin: 0 auto 40px; }
	.mode-badge {
		font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--text-1);
		background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px;
	}

	.hero-cta { display: flex; gap: 14px; flex-wrap: wrap; justify-content: center; margin-bottom: 64px; }
	.hero-mockup-wrap { width: 100%; max-width: 880px; position: relative; min-width: 0; margin: 0 auto; }

	/* ---- TIMELINE ---- */
	.timeline-section { padding: 100px 0 100px; }
	.timeline { display: flex; flex-direction: column; }
	.timeline-row { display: flex; gap: 24px; }
	.timeline-marker { width: 20px; flex-shrink: 0; display: flex; flex-direction: column; align-items: center; }
	.dot { width: 14px; height: 14px; border-radius: 50%; background: var(--accent-1); box-shadow: 0 0 0 4px rgba(243, 128, 32, 0.15); flex-shrink: 0; margin-top: 6px; }
	.line { width: 2px; flex: 1; background: var(--border-bright); margin: 4px 0; min-height: 40px; }
	.timeline-content { flex: 1; min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 40px; align-items: start; padding-bottom: 56px; }
	.timeline-text { min-width: 0; }
	.timeline-text h3 { font-size: 24px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 14px; }
	.timeline-text p { font-size: 15px; color: var(--text-1); line-height: 1.7; }
	.timeline-code { min-width: 0; }

	/* ---- FEATURES ---- */
	.features-section { padding: 0 0 100px; }
	.features-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
	.feature-card {
		background: var(--bg-1); border: 1px solid var(--border); border-radius: 16px;
		padding: 24px; transition: border-color 0.25s, background 0.25s; min-width: 0;
	}
	.feature-card:hover { border-color: rgba(243, 128, 32, 0.38); background: var(--bg-2); }
	.feature-title { font-size: 15px; font-weight: 600; margin-bottom: 8px; }
	.feature-desc { font-size: 13px; color: var(--text-1); line-height: 1.65; }

	/* ---- INSTALL + CTA ---- */
	.install-section { padding: 0 0 120px; }
	.install-section .container { max-width: 780px; }
	.install-footnote { text-align: center; margin-top: 24px; font-size: 14px; color: var(--text-2); }
	.install-footnote code { color: var(--accent-2); font-family: 'JetBrains Mono', monospace; font-size: 13px; }
	.install-cta { display: flex; gap: 14px; justify-content: center; flex-wrap: wrap; margin-top: 40px; }

	@media (max-width: 900px) {
		.features-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
		.timeline-content { grid-template-columns: minmax(0, 1fr); gap: 20px; }
	}
	@media (max-width: 640px) {
		.hero { padding: 110px 16px 60px; }
		.hero h1 { font-size: 36px; letter-spacing: -1px; }
		.features-grid { grid-template-columns: minmax(0, 1fr); }
		.timeline-row { gap: 14px; }
	}
</style>
