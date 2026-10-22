import { defineConfig } from 'vitest/config'
import preact from '@preact/preset-vite'

// Tauri の devUrl / frontendDist（tauri.conf.json）と合わせる。
export default defineConfig({
  plugins: [preact()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: 'chrome105',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
  },
})
