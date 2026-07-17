import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  esbuild: {
    jsx: 'automatic'
  },
  test: {
    environment: 'jsdom',
    setupFiles: [path.join(directory, 'tests/setup.ts')],
    include: [path.join(directory, 'tests/**/*.test.ts?(x)')],
    css: true
  }
});
