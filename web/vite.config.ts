import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'

/** The commit this build is from, so a problem report says which version someone was using. */
function appVersion(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return 'dev'
  }
}
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'icon.svg'],
      manifest: {
        name: 'Grub Grab',
        short_name: 'Grub Grab',
        description: 'Recipes in, shopping list out.',
        theme_color: '#2f6f4f',
        background_color: '#faf8f4',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // config.json must always come from the network so redeploys pick up new settings, and real pages
        // like the privacy policy must not be swapped for the app.
        navigateFallbackDenylist: [/^\/config\.json$/, /^\/privacy\.html$/],
        globIgnores: ['config.json'],
      },
    }),
  ],
})
