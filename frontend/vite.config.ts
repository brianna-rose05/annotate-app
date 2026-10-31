import react from '@vitejs/plugin-react'
import { defineConfig, searchForWorkspaceRoot } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    fs: {
      // The reader shares a small helper with the backend (backend/documents/articleUrls.mjs)
      allow: [searchForWorkspaceRoot(process.cwd()), '../backend/documents'],
    },
  },
})
