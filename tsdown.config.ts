import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  root: 'src',
  format: ['esm'],
  dts: true,
  platform: 'neutral',
  clean: true,
});
