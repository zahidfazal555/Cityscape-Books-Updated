import 'server-only';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {
  ApprovalsService,
  KnowledgeBaseService,
  NotificationsService,
  SupportDashboardService,
  TicketBillingService,
  TicketsService,
  VisitsService,
  WarrantyService,
  InventoryService,
  LabourService,
  PayrollService,
  AttachmentsService,
  AuditService,
  BankingService,
  GstService,
  OutstandingService,
  ReportsService,
  AuthService,
  ContactsService,
  ExpensesService,
  FileBlobStore,
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
  attachments: AttachmentsService;
  expenses: ExpensesService;
  approvals: ApprovalsService;
  banking: BankingService;
  outstanding: OutstandingService;
  gst: GstService;
  reports: ReportsService;
  payroll: PayrollService;
  labour: LabourService;
  inventory: InventoryService;
  tickets: TicketsService;
  visits: VisitsService;
  warranty: WarrantyService;
  kb: KnowledgeBaseService;
  ticketBilling: TicketBillingService;
  supportDashboard: SupportDashboardService;
  notifications: NotificationsService;
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
    // Dev and test fall back to a temp directory; production must set ATTACHMENT_DIR (env.ts).
    attachments: new AttachmentsService(
      pool,
      new FileBlobStore(e.ATTACHMENT_DIR ?? path.join(os.tmpdir(), 'csd-attachments')),
    ),
    expenses: new ExpensesService(pool),
    approvals: new ApprovalsService(pool),
    banking: new BankingService(pool),
    outstanding: new OutstandingService(pool),
    gst: new GstService(pool),
    reports: new ReportsService(pool),
    receipts: new ReceiptsService(pool),
    payroll: new PayrollService(pool),
    labour: new LabourService(pool),
    inventory: new InventoryService(pool),
    tickets: new TicketsService(pool),
    visits: new VisitsService(pool),
    warranty: new WarrantyService(pool),
    kb: new KnowledgeBaseService(pool),
    ticketBilling: new TicketBillingService(pool),
    supportDashboard: new SupportDashboardService(pool),
    notifications: new NotificationsService(pool),
  };
  return g.__csd;
}
