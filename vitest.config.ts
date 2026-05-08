import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      'react-piano-keyboard': path.resolve(__dirname, 'test/stubs/react-piano-keyboard.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./setupTests.ts'],
  },
});
