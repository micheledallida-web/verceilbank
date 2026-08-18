// One SMTP sender, shared by every function that emails.
//
// The mail goes out through the mailbox itself — Namecheap Private Email —
// rather than through a send API. There is no HTTP endpoint to post to and no
// API key: a mailbox provider wants an SMTP conversation, authenticated as the
// mailbox, and it will only send as the address that just logged in.
//
// This still runs server-side for the reason it always did. The mailbox
// password is the mailbox — anything holding it can read and send as support@
// — so it must never reach the browser, and everything under js/ does.

import nodemailer from 'npm:nodemailer@^9';

// Port 465 and nothing else, by default. Supabase's edge runtime does not
// allow outbound connections on port 25, and 587 is unreliable there too, so
// the implicit-TLS port is the one that actually connects. It is settable
// because a different provider may need a different port, not because 587 is
// expected to work here.
const DEFAULT_PORT = 465;
const DEFAULT_HOST = 'mail.privateemail.com';

export type SmtpSettings = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
};

// Reports the names of settings that are absent, never their values. A missing
// setting is the usual reason no mail arrives, and the name of one is not a
// secret — the password it refers to is.
export function readSmtpSettings(): { settings: SmtpSettings | null; missing: string[] } {
  const host = Deno.env.get('SMTP_HOST') || DEFAULT_HOST;
  const port = Number(Deno.env.get('SMTP_PORT') || DEFAULT_PORT);
  const user = Deno.env.get('SMTP_USER') || '';
  const password = Deno.env.get('SMTP_PASSWORD') || '';
  // A mailbox can only send as itself, so the sender is the mailbox with the
  // bank's name in front of it — which is what a recipient sees, and the one
  // part of the address that is free to choose. Setting SUPPORT_FROM replaces
  // the whole thing, but it cannot change who the mail is really from: the
  // provider refuses a From that is not the account that authenticated.
  const from = Deno.env.get('SUPPORT_FROM') || (user ? `Verceil Bank <${user}>` : '');

  const missing = [
    ['SMTP_USER', user],
    ['SMTP_PASSWORD', password],
  ].filter(([, value]) => !value).map(([name]) => name as string);

  if (!Number.isFinite(port) || port <= 0) missing.push('SMTP_PORT (not a number)');
  if (missing.length > 0) return { settings: null, missing };

  return {
    settings: { host, port, secure: port === 465, user, password, from },
    missing: [],
  };
}

function transportFor(settings: SmtpSettings) {
  return nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: { user: settings.user, pass: settings.password },
  });
}

// What the server said when it refused. An SMTP rejection is a numbered code
// and a sentence — "535 Incorrect authentication data" — and that sentence is
// the whole answer to why no mail arrived, so it is kept rather than flattened
// into a generic failure.
export type SendFailure = { ok: false; code: number | null; message: string };
export type SendResult = { ok: true } | SendFailure;

export type Mail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
};

export async function sendMail(settings: SmtpSettings, mail: Mail): Promise<SendResult> {
  try {
    await transportFor(settings).sendMail({
      from: settings.from,
      to: mail.to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
    });
    return { ok: true };
  } catch (err) {
    const e = err as { responseCode?: number; response?: string; message?: string };
    return {
      ok: false,
      code: typeof e.responseCode === 'number' ? e.responseCode : null,
      message: String(e.response || e.message || err),
    };
  }
}

// Opens the connection and logs in without sending anything, so bad
// credentials or an unreachable port can be told apart from a message the
// server accepted and then did not deliver.
export async function verifySmtp(settings: SmtpSettings): Promise<SendResult> {
  try {
    await transportFor(settings).verify();
    return { ok: true };
  } catch (err) {
    const e = err as { responseCode?: number; response?: string; message?: string };
    return {
      ok: false,
      code: typeof e.responseCode === 'number' ? e.responseCode : null,
      message: String(e.response || e.message || err),
    };
  }
}
