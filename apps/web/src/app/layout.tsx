import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Cityscape Books',
  description: 'Accounting and project costing for Cityscape Decors',
  robots: { index: false, follow: false },
};

// Every page is rendered per request so the CSP nonce reaches its inline scripts.
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-IN">
      <body>{children}</body>
    </html>
  );
}
