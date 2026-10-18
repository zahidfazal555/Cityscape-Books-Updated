import {
  DomainError,
  authorize,
  can,
  fromDecimalString,
  type Actor,
  type IsoDate,
  type Paise,
} from '@csd/core';
import { withTenant, writeAudit } from '@csd/db';
import type pg from 'pg';
import { z } from 'zod';
import { loadTicket, systemEvent } from './tickets.js';
import { parse, tenantOf as ctx } from './validation.js';

const linkSchema = z.object({
  kind: z.enum(['quotation', 'invoice']),
  id: z.string().uuid('Choose the document.'),
});

export interface TicketBilling {
  documents: {
    kind: 'quotation' | 'invoice';
    id: string;
    number: string;
    date: IsoDate;
    status: string;
    total: Paise;
  }[];
  /** Service costs charged to the project through this ticket's visits. */
  costs: { id: string; date: IsoDate; particulars: string; amount: Paise; status: string }[];
}

/** Billing card (FR-19.10): quotations and invoices linked to a ticket, and costs charged. */
export class TicketBillingService {
  constructor(private readonly pool: pg.Pool) {}

  async get(actor: Actor, ticketId: string): Promise<TicketBilling> {
    authorize(actor, 'tickets', 'view');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const t = await loadTicket(c, actor, ticketId);
      const docs = await c.query<{
        kind: 'quotation' | 'invoice';
        id: string;
        number: string;
        date: string;
        status: string;
        total: string;
      }>(
        `SELECT 'quotation' AS kind, id, number, to_char(quote_date, 'YYYY-MM-DD') AS date, status, total::text
           FROM quotation WHERE ticket_id = $1
         UNION ALL
         SELECT 'invoice', id, number, to_char(invoice_date, 'YYYY-MM-DD'), status, total::text
           FROM invoice WHERE ticket_id = $1
         ORDER BY date, number`,
        [t.id],
      );
      const costs = await c.query<{
        id: string;
        date: string;
        particulars: string;
        amount: string;
        status: string;
      }>(
        `SELECT id, to_char(txn_date, 'YYYY-MM-DD') AS date, particulars, amount::text, status
           FROM expense WHERE ticket_id = $1 AND deleted_at IS NULL ORDER BY txn_date, created_at`,
        [t.id],
      );
      const docRights = { quotation: 'quotes', invoice: 'invoices' } as const;
      return {
        documents: docs.rows
          .filter((d) => can(actor, docRights[d.kind], 'view', t.projectId))
          .map((d) => ({ ...d, total: fromDecimalString(d.total) })),
        costs: can(actor, 'expenses', 'view', t.projectId)
          ? costs.rows.map((x) => ({ ...x, amount: fromDecimalString(x.amount) }))
          : [],
      };
    });
  }

  /**
   * Links a quotation (same client) or tax invoice (same project) to the ticket. "Create
   * quotation" and "Raise tax invoice" open the usual forms; the new document is linked here.
   */
  async link(actor: Actor, ticketId: string, input: z.input<typeof linkSchema>): Promise<void> {
    const data = parse(linkSchema, input);
    authorize(actor, 'tickets', 'edit');
    authorize(actor, data.kind === 'quotation' ? 'quotes' : 'invoices', 'edit');
    await withTenant(this.pool, ctx(actor), async (c) => {
      const t = await loadTicket(c, actor, ticketId, true);
      authorize(actor, 'tickets', 'edit', t.projectId);
      const sql =
        data.kind === 'quotation'
          ? `UPDATE quotation q SET ticket_id = $2 FROM project p
              WHERE q.id = $1 AND p.id = $3 AND q.client_id = p.client_id
                AND (q.project_id IS NULL OR q.project_id = p.id) AND q.ticket_id IS NULL
            RETURNING q.number`
          : `UPDATE invoice SET ticket_id = $2 WHERE id = $1 AND project_id = $3 AND ticket_id IS NULL
            RETURNING number`;
      const { rows } = await c.query<{ number: string }>(sql, [data.id, ticketId, t.projectId]);
      const number = rows[0]?.number;
      if (!number)
        throw new DomainError(
          'VALIDATION',
          data.kind === 'quotation'
            ? 'Pick an unlinked quotation for this client.'
            : 'Pick an unlinked invoice on this project.',
          'id',
        );
      await systemEvent(
        c,
        ticketId,
        `${data.kind === 'quotation' ? 'Quotation' : 'Tax invoice'} ${number} linked`,
      );
      await writeAudit(c, { action: 'link', entity: 'ticket', entityId: ticketId, after: data });
    });
  }
}
