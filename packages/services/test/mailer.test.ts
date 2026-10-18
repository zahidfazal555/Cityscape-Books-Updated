import { describe, expect, it } from 'vitest';
import { SmtpMailer, type MailTransport } from '../src/index.js';

describe('SMTP mailer (go-live)', () => {
  it('sends through the transport with the configured sender', async () => {
    const sent: unknown[] = [];
    const transport: MailTransport = { sendMail: async (m) => void sent.push(m) };
    await new SmtpMailer(
      'smtps://u:p@mail.example.test',
      'Books <books@example.test>',
      transport,
    ).send({
      to: 'owner@example.test',
      subject: 'Invite',
      text: 'Hello',
    });
    expect(sent).toEqual([
      {
        from: 'Books <books@example.test>',
        to: 'owner@example.test',
        subject: 'Invite',
        text: 'Hello',
      },
    ]);
  });

  it('refuses a URL that is not SMTP', () => {
    expect(() => new SmtpMailer('http://mail.example.test', 'x@example.test')).toThrow('SMTP_URL');
  });
});
