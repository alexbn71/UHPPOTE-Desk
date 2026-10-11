import { defineConfig } from 'tsup'

// Standalone bundle of the hardware test suite (used in the Docker image: node hwtest/cli.js ...)
export default defineConfig({
  entry: { cli: 'src/cli.ts', devsim: 'src/devsim.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  removeNodeProtocol: false,
  noExternal: [/^@uhppote-desk\//],
  banner: { js: '' },
})
