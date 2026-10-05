import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true, // acessível de outros dispositivos da rede (celular, TV...)
    proxy: {
      '/api': 'http://127.0.0.1:3001',
      '/media': 'http://127.0.0.1:3001', // gravações e capturas
      // só os endpoints de vídeo do go2rtc (o resto da API dele expõe as senhas)
      '/go2rtc/api/ws': {
        target: 'http://127.0.0.1:1984',
        ws: true,
        rewrite: (p) => p.replace(/^\/go2rtc/, ''),
      },
      '/go2rtc/api/hls': {
        target: 'http://127.0.0.1:1984',
        rewrite: (p) => p.replace(/^\/go2rtc/, ''),
      },
    },
  },
});
