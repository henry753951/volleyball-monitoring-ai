export default defineNuxtConfig({
  compatibilityDate: '2026-08-01',
  devtools: { enabled: true },
  modules: ['@nuxtjs/tailwindcss', '@pinia/nuxt', '@vite-pwa/nuxt'],
  css: ['~/assets/css/main.css', 'vant/lib/index.css'],
  app: {
    head: {
      title: 'Volleyball Monitoring',
      htmlAttrs: { lang: 'zh-Hant' },
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no' },
        { name: 'theme-color', content: '#fafaf9' },
        { name: 'apple-mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-status-bar-style', content: 'default' },
        { name: 'apple-mobile-web-app-title', content: 'Volley Monitor' },
        { name: 'format-detection', content: 'telephone=no' },
      ],
      link: [
        { rel: 'apple-touch-icon', sizes: '180x180', href: '/icons/apple-touch-icon.png' },
      ],
    },
  },
  runtimeConfig: {
    public: {
      // Browser-facing APIs are same-origin behind Traefik. Do not hard-code localhost,
      // because an iPad reaches the host by LAN IP or DNS name.
      graphqlPath: process.env.NUXT_PUBLIC_GRAPHQL_PATH ?? '/graphql',
      annotationWsPath: process.env.NUXT_PUBLIC_ANNOTATION_WS_PATH ?? '/ws/annotations',
      restBasePath: process.env.NUXT_PUBLIC_REST_BASE_PATH ?? '/api/v1',
      liveHlsBasePath: process.env.NUXT_PUBLIC_LIVE_HLS_BASE_PATH ?? '/hls',
    },
  },
  routeRules: {
    '/annotate/**': { ssr: false },
    '/matches/**': { ssr: false },
  },
  pwa: {
    registerType: 'autoUpdate',
    strategies: 'generateSW',
    manifest: {
      id: '/',
      name: 'Volleyball Monitoring',
      short_name: 'Volley Monitor',
      description: '排球賽事即時標註、完整 DVR 回放與教練分析',
      lang: 'zh-Hant',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      orientation: 'landscape',
      background_color: '#fafaf9',
      theme_color: '#fafaf9',
      icons: [
        { src: '/icons/pwa-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/pwa-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icons/pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    workbox: {
      navigateFallback: '/',
      globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
      runtimeCaching: [
        {
          urlPattern: ({ url }: { url: URL }) => url.pathname.startsWith('/graphql'),
          handler: 'NetworkOnly',
        },
        {
          urlPattern: ({ url }: { url: URL }) => url.pathname.startsWith('/api/v1/media') || url.pathname.startsWith('/hls/'),
          handler: 'NetworkOnly',
        },
        {
          urlPattern: ({ url }: { url: URL }) => url.pathname.startsWith('/api/v1/analysis'),
          handler: 'NetworkFirst',
          options: { cacheName: 'analysis-read-cache', expiration: { maxEntries: 64, maxAgeSeconds: 86400 } },
        },
      ],
    },
    client: { installPrompt: true },
    devOptions: { enabled: false },
  },
  typescript: { strict: true, typeCheck: true },
})
