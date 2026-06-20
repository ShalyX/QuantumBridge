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
      '/api': globalThis.process?.env?.VITE_API_PROXY_TARGET || 'http://localhost:8787'
    }
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        // Keep viem's CCIP helper in the main bundle so bridge flows do not
        // depend on fetching a late dynamic chunk from protected preview URLs.
        inlineDynamicImports: true
      }
    }
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
