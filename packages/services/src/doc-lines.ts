import type pg from 'pg';
import type { z } from 'zod';
import { fromDecimalString, toDecimalString } from '@csd/core';
import type { lineSchema } from './invoices.js';

/** A validated document line: description, SAC/HSN, qty (thousandths), unit, rate, GST rate. */
export type DocLine = z.output<typeof lineSchema>;

/** Quotation, proforma and purchase-order lines store only what was entered; amounts are recomputed on read. */
const TABLES = {
  quotation: { table: 'quotation_line', fk: 'quotation_id' },
  proforma: { table: 'proforma_line', fk: 'proforma_id' },
  purchaseOrder: { table: 'purchase_order_line', fk: 'purchase_order_id' },
} as const;
type Kind = keyof typeof TABLES;

/** Replaces a document's lines in one statement. */
export async function writeDocLines(
  c: pg.PoolClient,
  kind: Kind,
  docId: string,
  lines: readonly DocLine[],
): Promise<void> {
  const { table, fk } = TABLES[kind];
  await c.query(`DELETE FROM ${table} WHERE ${fk} = $1`, [docId]);
  await c.query(
    `INSERT INTO ${table} (company_id, ${fk}, sort, description, sac_hsn, qty, unit, rate, gst_rate)
     SELECT app_company_id(), $1, sort, description, sac_hsn, qty_milli::numeric / 1000, unit, rate, gst_rate
       FROM unnest($2::int[], $3::text[], $4::text[], $5::bigint[], $6::text[], $7::numeric[], $8::numeric[])
         AS t(sort, description, sac_hsn, qty_milli, unit, rate, gst_rate)`,
    [
      docId,
      lines.map((_l, i) => i + 1),
      lines.map((l) => l.description),
      lines.map((l) => l.sacHsn),
      lines.map((l) => l.qtyMilli),
      lines.map((l) => l.unit),
      lines.map((l) => toDecimalString(l.rate)),
      lines.map((l) => l.gstRate),
    ],
  );
}

export async function readDocLines(
  c: pg.PoolClient,
  kind: Kind,
  docId: string,
): Promise<DocLine[]> {
  const { table, fk } = TABLES[kind];
  const { rows } = await c.query<{
    description: string;
    sac_hsn: string;
    qty_milli: string;
    unit: string;
    rate: string;
    gst_rate: string;
  }>(
    `SELECT description, sac_hsn, (qty * 1000)::bigint::text AS qty_milli, unit, rate::text,
            gst_rate::text
       FROM ${table} WHERE ${fk} = $1 ORDER BY sort`,
    [docId],
  );
  return rows.map((r) => ({
    description: r.description,
    sacHsn: r.sac_hsn,
    qtyMilli: Number(r.qty_milli),
    unit: r.unit,
    rate: fromDecimalString(r.rate),
    gstRate: Number(r.gst_rate),
  }));
}
