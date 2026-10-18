import 'server-only';
import type { ReactNode } from 'react';
import { Document, Image, Page, Text, View } from '@react-pdf/renderer';
import type { Letterhead } from '@csd/services';
import { placeOfSupply } from '@/lib/documents';
import { C, assetPath, registerFonts, s } from './theme';

export const companyName = (l: Letterhead) => l.legalName ?? l.name;

/** Logo, company, address and GSTIN on the left; the document's title and number on the right. */
export function LetterheadBlock({
  letterhead,
  title,
  number,
}: {
  letterhead: Letterhead;
  title: string;
  number?: string | undefined;
}) {
  return (
    <View style={[s.between, s.hr, { paddingBottom: 10, gap: 16 }]}>
      <View style={{ flexShrink: 1 }}>
        <Image
          src={assetPath('public', 'brand', 'cityscape-logo.png')}
          style={{
            height: 22,
            width: 104,
            marginBottom: 6,
            objectFit: 'contain',
            objectPosition: 'left',
          }}
        />
        <Text style={s.bold}>{companyName(letterhead)}</Text>
        {letterhead.address ? <Text style={s.muted}>{letterhead.address}</Text> : null}
        <Text style={s.muted}>
          {letterhead.gstin ? `GSTIN ${letterhead.gstin}` : 'GSTIN not set'} ·{' '}
          {placeOfSupply(letterhead.stateCode)}
        </Text>
        {letterhead.phone || letterhead.email ? (
          <Text style={s.muted}>
            {[letterhead.phone, letterhead.email].filter(Boolean).join(' · ')}
          </Text>
        ) : null}
      </View>
      <View style={{ alignItems: 'flex-end', flexShrink: 0 }}>
        <Text style={s.title}>{title}</Text>
        {number ? <Text style={[s.mono, { fontSize: 9.5 }]}>{number}</Text> : null}
      </View>
    </View>
  );
}

/** Repeated on every page, so no page of a draft or cancelled document can pass for final. */
export function Watermark({ text }: { text: string }) {
  return (
    <>
      <View
        fixed
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text
          style={{
            width: 640,
            textAlign: 'center',
            // Long texts ("DRAFT · not approved · not a payslip") must stay on one line.
            fontSize: text.length > 26 ? 28 : 40,
            fontWeight: 600,
            color: C.danger,
            opacity: 0.12,
            transform: 'rotate(-24deg)',
          }}
        >
          {text}
        </Text>
      </View>
      <Text
        style={{
          marginBottom: 8,
          paddingVertical: 4,
          borderWidth: 1,
          borderColor: C.dangerLine,
          backgroundColor: C.dangerBg,
          color: C.danger,
          textAlign: 'center',
          fontWeight: 600,
          fontSize: 8.5,
        }}
      >
        {text}
      </Text>
    </>
  );
}

/**
 * The company mark, very light, behind every page of a final document. Drafts and cancelled
 * documents get the red text watermark instead, never this one.
 */
export function LogoWatermark() {
  return (
    <View
      fixed
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Image
        src={assetPath('public', 'brand', 'cityscape-watermark.png')}
        style={{ width: 300, height: 300, opacity: 0.06 }}
      />
    </View>
  );
}

export function Signature({ letterhead }: { letterhead: Letterhead }) {
  return (
    <View wrap={false} style={{ marginTop: 32, alignItems: 'flex-end' }}>
      <View style={{ alignItems: 'center', minWidth: 160 }}>
        <Text style={[s.muted, { marginBottom: 26 }]}>For {companyName(letterhead)}</Text>
        <Text style={[s.muted, { borderTopWidth: 1, borderTopColor: C.line, paddingTop: 2 }]}>
          Authorised signatory
        </Text>
      </View>
    </View>
  );
}

/** A4 page with the running footer: what this is, and page x of y. */
export function PdfPage({
  children,
  footer,
  landscape = false,
}: {
  children: ReactNode;
  footer: string;
  landscape?: boolean;
}) {
  return (
    <Page size="A4" orientation={landscape ? 'landscape' : 'portrait'} style={s.page}>
      {children}
      <Text
        fixed
        style={s.footer}
        render={({ pageNumber, totalPages }) => `${footer}  ·  Page ${pageNumber} of ${totalPages}`}
      />
    </Page>
  );
}

export function PdfDocument({ title, children }: { title: string; children: ReactNode }) {
  registerFonts();
  return (
    <Document
      title={title}
      author="Cityscape Books"
      creator="Cityscape Books"
      producer="Cityscape Books"
    >
      {children}
    </Document>
  );
}

/** Key–value rows, right-aligned values (dates, references). */
export function MetaList({ items }: { items: readonly (readonly [string, string])[] }) {
  return (
    <View style={{ gap: 1 }}>
      {items.map(([k, v]) => (
        <View key={k} style={[s.row, { justifyContent: 'flex-end', gap: 10 }]}>
          <Text style={s.muted}>{k}</Text>
          <Text style={[s.right, { maxWidth: 200 }]}>{v}</Text>
        </View>
      ))}
    </View>
  );
}

export function Party({
  label,
  name,
  gstin,
  address,
}: {
  label: string;
  name: string;
  gstin?: string | null | undefined;
  address?: string | null | undefined;
}) {
  return (
    <View style={{ flexShrink: 1 }}>
      <Text style={s.label}>{label}</Text>
      <Text style={s.medium}>{name}</Text>
      {address ? <Text style={s.muted}>{address}</Text> : null}
      {gstin ? <Text style={s.muted}>GSTIN {gstin}</Text> : null}
    </View>
  );
}
