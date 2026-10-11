import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  // node:sqlite esiste solo con il prefisso node: (tsup per default lo rimuove)
  removeNodeProtocol: false,
  // i pacchetti del monorepo (sorgenti TypeScript) vengono inclusi nel bundle; le dipendenze npm restano esterne
  noExternal: [/^@uhppote-desk\//],
})
