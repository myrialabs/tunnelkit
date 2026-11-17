/**
 * Raw-imports examples/README.md and every top-level runnable example, so the
 * showcase page always matches what's actually in examples/ — never a copy.
 */

const readmeGlob = import.meta.glob('../../../examples/README.md', {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

const sourceGlob = import.meta.glob('../../../examples/*.ts', {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

const GITHUB_EXAMPLES_BASE = 'https://github.com/myrialabs/tunnelkit/blob/main/examples';

/**
 * examples/README.md links are relative to `examples/` on GitHub, but this
 * content renders at the `/docs/examples` route — a different path, so plain
 * browser relative-URL resolution doesn't apply here (unlike doc pages, whose
 * URLs mirror their source folder 1:1). Rewrite `./foo.ts` to an in-page
 * anchor (each file gets its own code panel below), and anything without a
 * matching panel to the real GitHub path.
 */
function linkifyReadme(raw: string): string {
	return raw.replace(/\]\(\.\/([\w-]+)(\.ts)?\)/g, (match, name: string, ext: string | undefined) =>
		ext ? `](#example-${name})` : `](${GITHUB_EXAMPLES_BASE}/${name})`
	);
}

export const examplesReadme: string = linkifyReadme(Object.values(readmeGlob)[0] ?? '');

export interface ExampleFile {
	name: string;
	code: string;
}

export const exampleFiles: ExampleFile[] = Object.entries(sourceGlob)
	.map(([path, code]) => ({ name: path.split('/').pop()!.replace(/\.ts$/, ''), code }))
	.sort((a, b) => a.name.localeCompare(b.name));

export function findExample(name: string): ExampleFile | undefined {
	return exampleFiles.find((e) => e.name === name);
}
