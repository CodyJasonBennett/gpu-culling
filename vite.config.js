import * as module from 'node:module'
import * as path from 'node:path'
import { defineConfig } from 'vite'

const require = module.createRequire(import.meta.url)

export default defineConfig({
  resolve: {
    alias: {
      'three/addons': require.resolve('three/addons'),
      three: path.resolve(__dirname, './src/three.module.js'),
    },
  },
})
