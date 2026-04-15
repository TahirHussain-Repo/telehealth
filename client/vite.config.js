import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
  },
  define: {
    // amazon-chime-sdk-js expects Node's `global`; browsers expose globalThis
    global: 'globalThis',
  },
})
