import js from '@eslint/js';
import ts from 'typescript-eslint';
import globals from 'globals';

/** @type {import('eslint').Linter.Config[]} */
export default [
	js.configs.recommended,
	...ts.configs.recommended,

	{
		languageOptions: {
			globals: {
				...globals.node,
				NodeJS: 'readonly'
			}
		},
		rules: {
			// `any` is used deliberately for cloudflared's dynamic config payloads.
			'@typescript-eslint/no-explicit-any': 'off',
			// Intentional: class+interface merging is the sanctioned way to type a
			// generic EventEmitter (TunnelKit, CloudflaredTunnel).
			'@typescript-eslint/no-unsafe-declaration-merging': 'off',
			'no-empty': ['error', { allowEmptyCatch: true }],
			'prefer-const': 'error'
		}
	},

	{
		ignores: ['dist/']
	}
];
