import { defineConfig } from 'tsup'

// Bundle autonomo della suite di test hardware (usato nell'immagine Docker: node hwtest/cli.js ...)
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
