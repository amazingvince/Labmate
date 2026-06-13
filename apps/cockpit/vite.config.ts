import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The generated OpenAPI types (packages/api-types) are imported type-only via the
// `@labmate/api-types` alias resolved by tsconfig `paths`. Those imports are
// erased by esbuild before module resolution, so Vite needs no runtime alias.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
  },
})
