// Только для просмотра интерфейса в браузере при разработке: npm run ui:preview
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [react()],
  server: { port: 5199, host: '127.0.0.1' }
})
