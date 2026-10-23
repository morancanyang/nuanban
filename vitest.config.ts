import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({
  resolve: { alias: Object.fromEntries(['domain','application','contracts','platform-ports','local-data','config','guidance-engine','privacy','pet-engine','media-relay','reminder-engine','provider-sandbox','api-client'].map(name => ['@nuanban/' + name, resolve(import.meta.dirname, 'packages/' + name + '/src/index.ts')])) },
  test: { include: ['tests/**/*.test.ts'], environment: 'node', setupFiles: ['tests/setup.ts'], maxWorkers: 2, fileParallelism: false },
});
