import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// `@labmate/api-types` stays type-only (erased by esbuild) so it needs no Vite
// alias. `@/` resolves the real runtime imports emitted by shadcn (@/lib/utils,
// @/components/ui/*), so it MUST be declared here as well as in tsconfig.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
})
