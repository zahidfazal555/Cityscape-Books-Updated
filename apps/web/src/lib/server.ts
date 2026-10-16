import 'server-only';
import pg from 'pg';
import {
  AuditService,
  AuthService,
  ContactsService,
  HibpBreachChecker,
  IdempotencyService,
  InvoicesService,
  BillsService,
  ProformasService,
  PurchaseOrdersService,
  QuotationsService,
  VendorPaymentsService,
  MemoryMailer,
  ProjectsService,
  ReceiptsService,
  SettingsService,
  UsersService,
} from '@csd/services';
import { env } from './env';
import { log } from './log';

export interface Services {
  pool: pg.Pool;
  mailer: MemoryMailer;
  auth: AuthService;
  users: UsersService;
  settings: SettingsService;
  contacts: ContactsService;
  projects: ProjectsService;
  audit: AuditService;
  invoices: InvoicesService;
  quotations: QuotationsService;
  purchaseOrders: PurchaseOrdersService;
  bills: BillsService;
  vendorPayments: VendorPaymentsService;
  proformas: ProformasService;
  idempotency: IdempotencyService;
  receipts: ReceiptsService;
}

const g = globalThis as unknown as { __csd?: Services };

/** One process-wide container (survives dev hot reloads). */
export function services(): Services {
  if (g.__csd) return g.__csd;
  const e = env();
  // Fail fast when the pool is exhausted instead of queueing every request behind it.
  const pool = new pg.Pool({
    connectionString: e.DATABASE_URL,
    max: 20,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
  });
  pool.on('error', (error) => log('error', 'pg pool error', { error }));
  const mailer = new MemoryMailer();
  const auth = new AuthService({
    pool,
    config: { jwtSecret: Buffer.from(e.JWT_SECRET, 'base64'), appUrl: e.APP_URL },
    breach: new HibpBreachChecker(),
    mailer,
    onMailError: (error, subject) => log('error', 'mail failed', { error, subject }),
  });
  g.__csd = {
    pool,
    mailer,
    auth,
    users: new UsersService(pool, auth),
    settings: new SettingsService(pool),
    contacts: new ContactsService(pool),
    projects: new ProjectsService(pool),
    audit: new AuditService(pool),
    invoices: new InvoicesService(pool),
    quotations: new QuotationsService(pool),
    purchaseOrders: new PurchaseOrdersService(pool),
    bills: new BillsService(pool),
    vendorPayments: new VendorPaymentsService(pool),
    proformas: new ProformasService(pool),
    idempotency: new IdempotencyService(pool),
    receipts: new ReceiptsService(pool),
  };
  return g.__csd;
}
