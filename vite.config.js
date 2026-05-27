import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  plugins: [
    nodePolyfills({
      include: ['buffer'],
      globals: { Buffer: true }
    })
  ],
  server: {
    port: 3005,
    host: true,
    proxy: {
      '/api': 'http://localhost:8787'
    }
  },
  build: {
    target: 'esnext'
  },
  optimizeDeps: {
    // We patch adapter code in node_modules during debugging; force re-optimization so
    // Vite refreshes the prebundled deps under node_modules/.vite/deps.
    force: true,
    include: [
      '@circle-fin/app-kit',
      '@circle-fin/adapter-viem-v2',
      '@circle-fin/adapter-solana-kit'
    ]
  }
});
