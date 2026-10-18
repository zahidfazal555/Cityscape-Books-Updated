import 'server-only';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Font, StyleSheet } from '@react-pdf/renderer';

/** The app's design tokens (globals.css), for print. */
export const C = {
  primary: '#1f5fae',
  heading: '#0f2a4a',
  ink: '#1b2430',
  muted: '#5b6573',
  subtle: '#8a94a6',
  line: '#e3e7ed',
  divider: '#eef1f5',
  thead: '#f8fafc',
  danger: '#b42318',
  dangerBg: '#fef3f2',
  dangerLine: '#f6cfcb',
  warn: '#8a5a00',
  warnBg: '#fff8eb',
  warnLine: '#f3ddaf',
};

/** Files shipped with the app (fonts, logo). `next start` and the tests run from apps/web. */
export function assetPath(...rel: string[]): string {
  for (const base of [process.cwd(), path.join(process.cwd(), 'apps/web')]) {
    const p = path.join(base, ...rel);
    if (existsSync(p)) return p;
  }
  throw new Error(`Missing app asset: ${rel.join('/')}`);
}

let registered = false;

/** IBM Plex (OFL, assets/fonts/OFL.txt): the app's typeface, and it has the ₹ glyph. */
export function registerFonts(): void {
  if (registered) return;
  const font = (file: string) => assetPath('assets', 'fonts', file);
  Font.register({
    family: 'Plex',
    fonts: [
      { src: font('IBMPlexSans-Regular.woff'), fontWeight: 400 },
      { src: font('IBMPlexSans-Medium.woff'), fontWeight: 500 },
      { src: font('IBMPlexSans-SemiBold.woff'), fontWeight: 600 },
    ],
  });
  Font.register({ family: 'PlexMono', src: font('IBMPlexMono-Regular.woff') });
  // Document numbers, GSTINs and amounts must never be split across lines with a hyphen.
  Font.registerHyphenationCallback((word) => [word]);
  registered = true;
}

export const s = StyleSheet.create({
  page: {
    fontFamily: 'Plex',
    fontSize: 9.5,
    color: C.ink,
    paddingTop: 36,
    paddingBottom: 48,
    paddingHorizontal: 40,
  },
  // No lineHeight on the page: react-pdf then drops `render` text (the page numbers).
  row: { flexDirection: 'row' },
  between: { flexDirection: 'row', justifyContent: 'space-between' },
  muted: { color: C.muted },
  label: {
    fontSize: 7.5,
    fontWeight: 600,
    color: C.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 2,
  },
  mono: { fontFamily: 'PlexMono' },
  bold: { fontWeight: 600 },
  medium: { fontWeight: 500 },
  right: { textAlign: 'right' },
  title: { fontSize: 14, fontWeight: 600, color: C.heading, letterSpacing: 0.6 },
  hr: { borderBottomWidth: 1, borderBottomColor: C.line },
  footer: { position: 'absolute', bottom: 22, left: 40, right: 40, fontSize: 7.5, color: C.subtle },
});
