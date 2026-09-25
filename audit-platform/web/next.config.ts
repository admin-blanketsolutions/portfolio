import type { NextConfig } from 'next';

/*
 * The Content-Security-Policy is set per request with a nonce in proxy.ts.
 * The headers below apply to every response, including static assets.
 */
const config: NextConfig = {
  reactStrictMode: true,
  agentRules: false,                 // do not generate AGENTS.md / CLAUDE.md into the repository
  poweredByHeader: false,
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        { key: 'Cache-Control', value: 'private, no-store' },
      ],
    }];
  },
  // Development: proxy /api to the backend. Production: the ingress routes
  // /api to the API service on the same tenant host (no CORS needed).
  async rewrites() {
    const api = process.env.API_ORIGIN;
    return api ? [{ source: '/api/:path*', destination: `${api}/:path*` }] : [];
  },
};

export default config;
