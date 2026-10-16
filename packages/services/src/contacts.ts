import {
  DomainError,
  STATE_CODES,
  assertId,
  authorize,
  validateGstin,
  type Actor,
} from '@csd/core';
import { withTenant, writeAudit } from '@csd/db';
import type pg from 'pg';
import { z } from 'zod';
import { onDuplicate, parse } from './validation.js';

export type ContactType = 'client' | 'vendor';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

const contactSchema = z.object({
  type: z.enum(['client', 'vendor']),
  name: z.string().trim().min(1, 'Enter a name.').max(160),
  contactPerson: optionalText(120),
  gstin: optionalText(15),
  pan: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'PAN format is not valid.')
    .nullable()
    .optional(),
  stateCode: z.string().refine((c) => c in STATE_CODES, 'Choose a state.'),
  address: optionalText(500),
  phone: z
    .string()
    .trim()
    .regex(/^[6-9]\d{9}$/, 'Enter a 10-digit mobile number.')
    .nullable()
    .optional(),
  email: z.string().trim().toLowerCase().email('Enter a valid email.').nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
});
const updateSchema = contactSchema.omit({ type: true }).partial();

export type ContactInput = z.input<typeof contactSchema>;
export type ContactUpdate = z.input<typeof updateSchema>;

export interface Contact {
  id: string;
  type: ContactType;
  name: string;
  contactPerson: string | null;
  gstin: string | null;
  pan: string | null;
  stateCode: string;
  state: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  paymentTermsDays: number | null;
  projectCount: number;
}

const COLUMNS = `c.id, c.type, c.name, c.contact_person, c.gstin, c.pan, c.state_code, c.address, c.phone,
  c.email, c.payment_terms_days,
  (SELECT count(*)::int FROM project p WHERE p.client_id = c.id) AS project_count`;

interface Row {
  id: string;
  type: ContactType;
  name: string;
  contact_person: string | null;
  gstin: string | null;
  pan: string | null;
  state_code: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  payment_terms_days: number | null;
  project_count: number;
}

const toContact = (r: Row): Contact => ({
  id: r.id,
  type: r.type,
  name: r.name,
  contactPerson: r.contact_person,
  gstin: r.gstin,
  pan: r.pan,
  stateCode: r.state_code,
  state: STATE_CODES[r.state_code] ?? r.state_code,
  address: r.address,
  phone: r.phone,
  email: r.email,
  paymentTermsDays: r.payment_terms_days,
  projectCount: r.project_count,
});

const DUPLICATE = 'A contact with this name already exists.';

/** Clients & vendors master (Req §4a; SPEC-FIXES B5: one table, typed). */
export class ContactsService {
  constructor(private readonly pool: pg.Pool) {}

  async list(actor: Actor, type: ContactType, search = ''): Promise<Contact[]> {
    authorize(actor, 'contacts', 'view');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<Row>(
        `SELECT ${COLUMNS} FROM contact c
          WHERE c.type = $1 AND c.deleted_at IS NULL
            AND ($2 = '' OR c.name ILIKE '%' || $2 || '%' OR c.gstin ILIKE $2 || '%')
          ORDER BY lower(c.name) LIMIT 500`,
        [type, search.trim()],
      );
      return rows.map(toContact);
    });
  }

  async get(actor: Actor, id: string): Promise<Contact> {
    authorize(actor, 'contacts', 'view');
    assertId(id, 'Contact');
    return withTenant(this.pool, ctx(actor), async (c) => toContact(await getRow(c, id)));
  }

  /** FR-3.2.4: the GSTIN's first two digits must match the chosen state. */
  async create(actor: Actor, input: ContactInput): Promise<string> {
    authorize(actor, 'contacts', 'edit');
    const data = parse(contactSchema, input);
    const gstin = data.gstin ? validateGstin(data.gstin, data.stateCode) : null;
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c
        .query<{ id: string }>(
          `INSERT INTO contact (company_id, type, name, contact_person, gstin, pan, state_code, address, phone,
                                email, payment_terms_days, created_by)
           VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, app_user_id()) RETURNING id`,
          [
            data.type,
            data.name,
            data.contactPerson ?? null,
            gstin,
            data.pan ?? null,
            data.stateCode,
            data.address ?? null,
            data.phone ?? null,
            data.email ?? null,
            data.paymentTermsDays ?? null,
          ],
        )
        .catch(onDuplicate('name', DUPLICATE));
      const id = rows[0]?.id;
      if (!id) throw new Error('contact insert returned no id');
      await writeAudit(c, {
        action: 'create',
        entity: 'contact',
        entityId: id,
        after: { ...data, gstin },
      });
      return id;
    });
  }

  async update(actor: Actor, id: string, input: ContactUpdate): Promise<void> {
    authorize(actor, 'contacts', 'edit');
    assertId(id, 'Contact');
    const data = parse(updateSchema, input);
    await withTenant(this.pool, ctx(actor), async (c) => {
      const before = toContact(await getRow(c, id));
      const stateCode = data.stateCode ?? before.stateCode;
      const rawGstin = data.gstin === undefined ? before.gstin : data.gstin;
      const gstin = rawGstin ? validateGstin(rawGstin, stateCode) : null;
      const pick = <T>(v: T | undefined, old: T): T => (v === undefined ? old : v);
      await c
        .query(
          `UPDATE contact SET name = $2, contact_person = $3, gstin = $4, pan = $5, state_code = $6, address = $7,
                  phone = $8, email = $9, payment_terms_days = $10 WHERE id = $1`,
          [
            id,
            pick(data.name, before.name),
            pick(data.contactPerson, before.contactPerson),
            gstin,
            pick(data.pan, before.pan),
            stateCode,
            pick(data.address, before.address),
            pick(data.phone, before.phone),
            pick(data.email, before.email),
            pick(data.paymentTermsDays, before.paymentTermsDays),
          ],
        )
        .catch(onDuplicate('name', DUPLICATE));
      const after = toContact(await getRow(c, id));
      await writeAudit(c, { action: 'update', entity: 'contact', entityId: id, before, after });
    });
  }

  /** Archive (soft delete). A client with active projects stays. */
  async archive(actor: Actor, id: string): Promise<void> {
    authorize(actor, 'contacts', 'full');
    assertId(id, 'Contact');
    await withTenant(this.pool, ctx(actor), async (c) => {
      await getRow(c, id);
      const active = await c.query(
        `SELECT 1 FROM project WHERE client_id = $1 AND status IN ('active', 'on_hold') LIMIT 1`,
        [id],
      );
      if (active.rowCount) {
        throw new DomainError(
          'CONFLICT',
          'This client has active projects. Complete or cancel them first.',
        );
      }
      await c.query('UPDATE contact SET deleted_at = now() WHERE id = $1', [id]);
      await writeAudit(c, { action: 'archive', entity: 'contact', entityId: id });
    });
  }
}

const ctx = (actor: Actor): { companyId: string; userId: string } => ({
  companyId: actor.companyId,
  userId: actor.userId,
});

async function getRow(c: pg.PoolClient, id: string): Promise<Row> {
  const { rows } = await c.query<Row>(
    `SELECT ${COLUMNS} FROM contact c WHERE c.id = $1 AND c.deleted_at IS NULL`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new DomainError('NOT_FOUND', 'Contact not found.');
  return row;
}
