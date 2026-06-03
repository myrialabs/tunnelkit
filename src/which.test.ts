import { test, expect } from 'bun:test';
import { which } from './which.js';

test('resolves a binary that exists on PATH', () => {
	// `sh` exists on every POSIX system; `cmd` on Windows.
	const target = process.platform === 'win32' ? 'cmd' : 'sh';
	const resolved = which(target);
	expect(resolved).toBeTruthy();
});

test('returns null for a binary that does not exist', () => {
	expect(which('definitely-not-a-real-binary-xyz-123')).toBeNull();
});
