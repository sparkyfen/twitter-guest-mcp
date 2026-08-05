import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // .claude holds agent worktrees — copies of this repo that would otherwise
    // be globbed as a second, duplicate suite.
    exclude: ['node_modules/**', 'dist/**', '.claude/**']
  }
});
