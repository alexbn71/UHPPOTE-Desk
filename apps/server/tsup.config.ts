import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  // node:sqlite only exists with the node: prefix (tsup removes it by default)
  removeNodeProtocol: false,
  // the monorepo packages (TypeScript sources) are bundled; npm dependencies stay external
  noExternal: [/^@uhppote-desk\//],
})
