import type { NextConfig } from 'next';

const config: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@csd/core', '@csd/db', '@csd/services'],
  // Native and Node-only modules stay out of the bundle.
  serverExternalPackages: ['pg', '@node-rs/argon2'],
  poweredByHeader: false,
  // Workspace packages use NodeNext-style `./x.js` imports of `.ts` files.
  webpack(cfg, { isServer }) {
    cfg.resolve ??= {};
    cfg.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    // Imported from transpiled workspace packages, so serverExternalPackages alone does not catch them.
    if (isServer)
      cfg.externals = [
        ...(Array.isArray(cfg.externals) ? cfg.externals : []),
        'pg',
        '@node-rs/argon2',
      ];
    return cfg;
  },
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default config;
