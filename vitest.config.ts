import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Unit and integration tests run outside the VS Code extension host, so the
      // `vscode` module is replaced by a small in-memory mock.
      vscode: fileURLToPath(new URL('./test/mocks/vscode.ts', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The fixture project contains test files of its own; they must never be
    // executed by the BCE suite.
    exclude: ['**/node_modules/**', 'test/fixtures/**'],
    testTimeout: 30000,
    hookTimeout: 30000
  }
});
