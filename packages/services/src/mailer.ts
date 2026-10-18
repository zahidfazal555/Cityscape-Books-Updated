import nodemailer from 'nodemailer';

/** Transactional email (invites, password reset). Production wires a real provider. */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Keeps messages in memory: tests and local development. Never logs token links. */
export class MemoryMailer implements Mailer {
  readonly outbox: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.outbox.push(message);
  }
}

/** The part of a nodemailer transport the app uses (injectable for tests). */
export interface MailTransport {
  sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

/**
 * Production mail over SMTP (any provider: SES, Postmark, Zoho…). `smtps://` uses implicit TLS;
 * plain `smtp://` must upgrade with STARTTLS, so credentials and token links never travel in the
 * clear.
 */
export class SmtpMailer implements Mailer {
  private readonly transport: MailTransport;

  constructor(
    url: string,
    private readonly from: string,
    transport?: MailTransport,
  ) {
    this.transport = transport ?? createSmtpTransport(url);
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }
}

function createSmtpTransport(url: string): MailTransport {
  const u = new URL(url);
  if (u.protocol !== 'smtps:' && u.protocol !== 'smtp:')
    throw new Error('SMTP_URL must start with smtps:// or smtp://');
  return nodemailer.createTransport({
    host: u.hostname,
    port: Number(u.port) || (u.protocol === 'smtps:' ? 465 : 587),
    secure: u.protocol === 'smtps:',
    requireTLS: u.protocol === 'smtp:',
    auth: u.username
      ? { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) }
      : undefined,
  });
}
