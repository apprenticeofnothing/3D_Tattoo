import { defineConfig } from 'vitest/config';

// BASE_PATH is set by the GitHub Pages workflow (e.g. /3D_Tattoo/).
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  build: { target: 'es2022', sourcemap: true, rolldownOptions: { input: { main: 'index.html', capture: 'capture.html' } } },
  test: { include: ['tests/**/*.test.ts'] },
});
