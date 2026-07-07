import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// En dev, les appels vers /admin sont relayés vers le backend rs-connector, ce qui permet au
// cookie de session httpOnly de fonctionner en same-origin. Le port cible est configurable
// via RS_CONNECTOR_BACKEND_PORT (défaut 3007, le port par défaut du service).
const backendPort = process.env.RS_CONNECTOR_BACKEND_PORT || '3007';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/admin': { target: `http://localhost:${backendPort}`, changeOrigin: true },
    },
  },
});
