import fs from 'fs';
import path from 'path';
import nodemailer from 'nodemailer';
import { getAll } from './db';

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function fallbackLog(to: string, subject: string, body: string) {
  const line = [
    `[${new Date().toISOString()}]`,
    `TO: ${to}`,
    `SUBJECT: ${subject}`,
    '---',
    body.replace(/\n/g, ' | '),
    '',
  ].join('\n');
  try {
    const dir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'emails.log'), line + '\n');
  } catch (e: any) {
    // A serverless host's filesystem is read-only, so this log is best-effort.
    // Never let a failed log write turn into a 500 on the calling request.
    console.error(`[notify] could not write data/emails.log (${e?.code || e?.message || e}). Message follows:\n${line}`);
  }
}

/**
 * SMTP hosts we can infer, so a user only has to supply SMTP_USER + SMTP_PASS.
 * Keyed by the domain of SMTP_USER, or by the well-known API-key usernames that
 * transactional providers require.
 */
const SMTP_HOST_BY_DOMAIN: Record<string, { host: string; port: number; secure: boolean }> = {
  'gmail.com': { host: 'smtp.gmail.com', port: 587, secure: false },
  'googlemail.com': { host: 'smtp.gmail.com', port: 587, secure: false },
  'outlook.com': { host: 'smtp-mail.outlook.com', port: 587, secure: false },
  'hotmail.com': { host: 'smtp-mail.outlook.com', port: 587, secure: false },
  'live.com': { host: 'smtp-mail.outlook.com', port: 587, secure: false },
  'yahoo.com': { host: 'smtp.mail.yahoo.com', port: 587, secure: false },
  'zoho.com': { host: 'smtp.zoho.com', port: 587, secure: false },
  'icloud.com': { host: 'smtp.mail.me.com', port: 587, secure: false },
  'me.com': { host: 'smtp.mail.me.com', port: 587, secure: false },
};

const SMTP_HOST_BY_USER: Record<string, { host: string; port: number; secure: boolean }> = {
  apikey: { host: 'smtp.sendgrid.net', port: 587, secure: false },
  resend: { host: 'smtp.resend.com', port: 587, secure: false },
};

export interface MailStatus {
  /** true when a real SMTP delivery will be attempted. */
  live: boolean;
  /** 'smtp' = delivers to a real inbox, 'log' = appended to data/emails.log only. */
  mode: 'smtp' | 'log';
  host?: string;
  port?: number;
  secure?: boolean;
  /** Login masked — never the raw value. */
  user?: string;
  from?: string;
  /** Where the host came from, so a wrong guess is debuggable. */
  hostSource?: 'SMTP_HOST' | 'inferred';
  /** Env vars that still need to be filled in for live delivery. */
  missing: string[];
  fallbackRecipient: string;
  logFile: string;
  hint: string;
}

const maskUser = (u: string) => {
  const [name, domain] = u.split('@');
  if (!domain) return u.length <= 2 ? '**' : `${u.slice(0, 2)}***`;
  return `${name.slice(0, 2)}***@${domain}`;
};

/**
 * Reads the SMTP env vars and decides whether real delivery is possible.
 * SMTP_HOST is optional: with a recognised SMTP_USER we infer the host, so the
 * common case is just two env vars instead of five.
 */
export function getMailStatus(): MailStatus {
  const user = (process.env.SMTP_USER || '').trim();
  const pass = (process.env.SMTP_PASS || '').trim();
  const explicitHost = (process.env.SMTP_HOST || '').trim();

  const domain = user.includes('@') ? user.split('@')[1]?.toLowerCase() : '';
  const guess = SMTP_HOST_BY_USER[user.toLowerCase()] || (domain ? SMTP_HOST_BY_DOMAIN[domain] : undefined);

  const host = explicitHost || guess?.host || '';
  const hostSource: MailStatus['hostSource'] | undefined = explicitHost ? 'SMTP_HOST' : host ? 'inferred' : undefined;
  const port = Number(process.env.SMTP_PORT || guess?.port || 587);
  const secure = process.env.SMTP_SECURE !== undefined
    ? String(process.env.SMTP_SECURE) === 'true'
    : (guess?.secure ?? port === 465);

  const missing: string[] = [];
  if (!user) missing.push('SMTP_USER');
  if (!pass) missing.push('SMTP_PASS');
  if (user && pass && !host) missing.push('SMTP_HOST');

  const live = missing.length === 0;
  return {
    live,
    mode: live ? 'smtp' : 'log',
    host: host || undefined,
    port: host ? port : undefined,
    secure: host ? secure : undefined,
    user: user ? maskUser(user) : undefined,
    from: process.env.SMTP_FROM || user || undefined,
    hostSource,
    missing,
    fallbackRecipient: fallbackRecipient(),
    logFile: 'data/emails.log',
    hint: live
      ? `Live delivery via ${host}:${port}.`
      : `Notifications are written to data/emails.log only — nobody receives them. Set ${missing.join(' and ')} in .env.local to deliver real email.`,
  };
}

/** Warn once per process, loudly, so log-only mode is never a silent surprise. */
let warnedLogOnly = false;
function warnLogOnlyOnce(status: MailStatus) {
  if (warnedLogOnly) return;
  warnedLogOnly = true;
  console.warn(
    [
      '',
      '  ┌───────────────────────────────────────────────────────────────┐',
      '  │  EMAIL IS NOT BEING DELIVERED                                 │',
      '  ├───────────────────────────────────────────────────────────────┤',
      `  │  Missing: ${status.missing.join(', ').padEnd(51)}│`,
      '  │  Every notification is appended to data/emails.log and        │',
      '  │  NO human receives it. Add the vars above to .env.local        │',
      '  │  and restart the dev server to send real email.                │',
      '  └───────────────────────────────────────────────────────────────┘',
      '',
    ].join('\n'),
  );
}

export interface MailResult {
  mode: 'smtp' | 'log';
  to: string;
  subject: string;
  /** Set when SMTP was configured but the send failed and we logged instead. */
  error?: string;
}

async function sendMail(to: string, subject: string, html: string, text: string): Promise<MailResult> {
  const status = getMailStatus();

  if (!status.live) {
    warnLogOnlyOnce(status);
    fallbackLog(to, subject, text);
    return { mode: 'log', to, subject };
  }

  try {
    const transporter = nodemailer.createTransport({
      host: status.host,
      port: status.port,
      secure: status.secure,
      auth: { user: process.env.SMTP_USER as string, pass: process.env.SMTP_PASS as string },
    });
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      html,
      text,
    });
    return { mode: 'smtp', to, subject };
  } catch (e: any) {
    // SMTP was configured but rejected us. Log the message so it isn't lost and
    // report the failure — do NOT pretend it was delivered.
    const reason = String(e?.response || e?.message || e).slice(0, 300);
    console.error(`[notify] SMTP send failed via ${status.host}:${status.port} — ${reason}`);
    fallbackLog(to, `[SMTP FAILED] ${subject}`, `${text}\n\nSMTP error: ${reason}`);
    return { mode: 'log', to, subject, error: reason };
  }
}

export interface NotifyPayload {
  event: 'deal_confirmed' | 'work_submitted' | 'deal_completed' | 'deal_completed_seller' | 'deal_cancelled' | 'payment_released' | 'order_inquiry' | 'chat_message';
  recipientEmail?: string;
  recipientName?: string;
  recipientWallet?: string;
  dealTitle?: string;
  dealAmount?: string;
  dealId?: string;
  note?: string;
  evidence?: string;
  /** Chat sender's display name, for order_inquiry / chat_message. */
  fromName?: string;
  /** First line(s) of the message, shown in the email body. */
  messagePreview?: string;
  /** Deep link back into the app (e.g. /messages). */
  link?: string;
}

export async function resolveEmailFromDb(wallet: string, name: string): Promise<string> {
  try {
    // Was: read data/db.json directly. That file is empty on a Redis-backed
    // deploy (users live in Redis), so buyer/seller lookups silently failed and
    // every notification fell back to NOTIFY_FALLBACK_EMAIL. Go through the db
    // layer so it works with whichever backend is configured.
    const users: any[] = await getAll('users');
    const byWallet = users.find(
      (u: any) => u.walletAddress && String(u.walletAddress).toLowerCase() === String(wallet).toLowerCase()
    );
    if (byWallet?.email) return byWallet.email;
    const byName = users.find(
      (u: any) => u.name && u.name.toLowerCase() === String(name).toLowerCase()
    );
    return byName?.email || '';
  } catch {
    return '';
  }
}

const fallbackRecipient = () => process.env.NOTIFY_FALLBACK_EMAIL || 'alex@nexotiq.io';

function layout(title: string, heading: string, rows: [string, string][], footer: string): { html: string; text: string } {
  const rowHtml = rows.map(([k, v]) => `<tr><td style="padding:6px 0;color:#9ca3af;width:130px;font-size:13px">${esc(k)}</td><td style="padding:6px 0;color:#e5e7eb;font-size:13px;">${esc(v)}</td></tr>`).join('');
  const text = [heading, '', ...rows.map(([k, v]) => `${k}: ${v}`), '', footer].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#0a0a0a;font-family:Segoe UI,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:24px">
    <tr><td align="center">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#131313;border:1px solid #2a2a2a;border-radius:14px;overflow:hidden">
        <tr><td style="padding:20px 24px;background:#0f172a;border-bottom:1px solid #1e293b">
          <span style="color:#60a5fa;font-size:17px;font-weight:700">Synq</span>
          <span style="color:#6b7280;font-size:13px"> · escrow-protected deals</span>
        </td></tr>
        <tr><td style="padding:24px">
          <h1 style="margin:0 0 6px;color:#f9fafb;font-size:20px">${esc(title)}</h1>
          <p style="margin:0 0 16px;color:#9ca3af;font-size:14px">${esc(heading)}</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowHtml}</table>
          <p style="margin:20px 0 0;color:#6b7280;font-size:12px;line-height:1.5">${esc(footer)}</p>
        </td></tr>
        <tr><td style="padding:14px 24px;border-top:1px solid #2a2a2a;color:#4b5563;font-size:11px">You are receiving this because of activity on Synq. Money is locked in smart-contract escrow until work is approved.</td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
  return { html, text };
}

export async function notifyDealConfirmedToSeller(p: NotifyPayload) {
  const email = p.recipientEmail || await resolveEmailFromDb(String(p.recipientWallet || ''), String(p.recipientName || ''));
  const to = email || fallbackRecipient();
  const title = 'You have a new deal to work on';
  const heading = 'A buyer just confirmed a deal with you. Funds are locked in escrow until you deliver.';
  const rows: [string, string][] = [
    ['Deal', p.dealTitle || 'Untitled deal'],
    ['Amount', p.dealAmount || '—'],
    ['Reference', p.dealId || '—'],
  ];
  if (p.note) rows.push(['Note', p.note]);
  const { html, text } = layout(title, heading, rows, 'Sign in to view the full deal, start the first milestone, and submit work when it is done. The buyer is notified by email automatically.');
  const res = await sendMail(to, title, html, text);
  return { ...res, event: p.event, recipientResolved: !!email };
}

export async function notifyBuyerWorkSubmitted(p: NotifyPayload) {
  const email = p.recipientEmail || await resolveEmailFromDb(String(p.recipientWallet || ''), String(p.recipientName || ''));
  const to = email || fallbackRecipient();
  const title = 'Work submitted on your deal';
  const heading = 'The seller has submitted work with evidence for your review. Approve to release escrow, or request a revision.';
  const rows: [string, string][] = [
    ['Deal', p.dealTitle || 'Untitled deal'],
    ['Amount', p.dealAmount || '-'],
  ];
  if (p.evidence) rows.push(['Evidence', p.evidence]);
  if (p.note) rows.push(['Milestone', p.note]);
  rows.push(['Reference', p.dealId || '-']);
  const { html, text } = layout(title, heading, rows, 'Open the evidence link to review the submitted work. Funds stay locked until you approve the milestone.');
  const res = await sendMail(to, title, html, text);
  return { ...res, event: p.event, recipientResolved: !!email };
}

export async function notifyBuyerDealCompleted(p: NotifyPayload) {
  const email = p.recipientEmail || await resolveEmailFromDb(String(p.recipientWallet || ''), String(p.recipientName || ''));
  const to = email || fallbackRecipient();
  const title = 'Your deal is complete';
  const heading = 'All milestones are approved. The deal is completed and escrow has been distributed.';
  const rows: [string, string][] = [
    ['Deal', p.dealTitle || 'Untitled deal'],
    ['Amount', p.dealAmount || '—'],
    ['Reference', p.dealId || '—'],
  ];
  if (p.note) rows.push(['Note', p.note]);
  const { html, text } = layout(title, heading, rows, 'Thank you for using Synq. Leave a review for the seller to help build trust on the Deal Port.');
  const res = await sendMail(to, title, html, text);
  return { ...res, event: p.event, recipientResolved: !!email };
}

/**
 * One-time sign-in code. Sent to the address the user typed — never to
 * NOTIFY_FALLBACK_EMAIL, because delivering a login code to the wrong inbox
 * would hand over the account.
 */
export async function sendEmailVerificationCode(to: string, code: string, minutes: number): Promise<MailResult> {
  const title = 'Your Synq sign-in code';
  const heading = `Enter this code to finish signing in. It expires in ${minutes} minutes.`;
  const rows: [string, string][] = [
    ['Code', code],
    ['Expires in', `${minutes} minutes`],
  ];
  const { html, text } = layout(title, heading, rows, 'If you did not try to sign in to Synq, ignore this email — the code is useless without it.');
  return sendMail(to, title, html, text);
}
export async function notifySellerDealCompleted(p: NotifyPayload) {
  const email = p.recipientEmail || await resolveEmailFromDb(String(p.recipientWallet || ''), String(p.recipientName || ''));
  const to = email || fallbackRecipient();
  const title = 'Deal completed - payment received';
  const heading = 'The buyer approved the final milestone. The escrowed payment has been released to your wallet.';
  const rows: [string, string][] = [
    ['Deal', p.dealTitle || 'Untitled deal'],
    ['Amount', p.dealAmount || '-'],
    ['Reference', p.dealId || '-'],
  ];
  if (p.note) rows.push(['Note', p.note]);
  const { html, text } = layout(title, heading, rows, 'The full escrow amount for this deal has been settled on-chain. Thank you for delivering on Synq.');
  const res = await sendMail(to, title, html, text);
  return { ...res, event: p.event, recipientResolved: !!email };
}

export async function notifyDealCancelled(p: NotifyPayload) {
  const email = p.recipientEmail || await resolveEmailFromDb(String(p.recipientWallet || ''), String(p.recipientName || ''));
  const to = email || fallbackRecipient();
  const title = 'A deal you are part of was cancelled';
  const heading = 'The buyer cancelled this deal. Any escrow balance was refunded to the buyer and the contract accepts no further actions.';
  const rows: [string, string][] = [
    ['Deal', p.dealTitle || 'Untitled deal'],
    ['Amount', p.dealAmount || '-'],
    ['Reference', p.dealId || '-'],
  ];
  if (p.note) rows.push(['Note', p.note]);
  const { html, text } = layout(title, heading, rows, 'No funds move to the seller on cancellation. Open a new deal anytime to work together again.');
  const res = await sendMail(to, title, html, text);
  return { ...res, event: p.event, recipientResolved: !!email };
}

export async function notifySellerPaymentReleased(p: NotifyPayload) {
  const email = p.recipientEmail || await resolveEmailFromDb(String(p.recipientWallet || ''), String(p.recipientName || ''));
  const to = email || fallbackRecipient();
  const title = 'Payment received';
  const heading = 'The buyer approved your work and the escrowed amount for this milestone has been released to your wallet.';
  const rows: [string, string][] = [
    ['Deal', p.dealTitle || 'Untitled deal'],
    ['Amount', p.dealAmount || '-'],
  ];
  if (p.note) rows.push(['Milestone', p.note]);
  rows.push(['Reference', p.dealId || '-']);
  const { html, text } = layout(title, heading, rows, 'Funds were transferred on-chain from the deal contract straight to your wallet. Keep delivering to unlock the next milestone.');
  const res = await sendMail(to, title, html, text);
  return { ...res, event: p.event, recipientResolved: !!email };
}

/**
 * A buyer opened a chat and sent their first order/brief to a seller. Fired
 * server-side on every new order message so the seller hears about it even when
 * they are not on the site.
 */
export async function notifySellerOrderInquiry(p: NotifyPayload) {
  const email = p.recipientEmail || await resolveEmailFromDb(String(p.recipientWallet || ''), String(p.recipientName || ''));
  const to = email || fallbackRecipient();
  const title = 'New order — a buyer wants to work with you';
  const heading = `${p.fromName || 'A buyer'} sent you an order on Synq. Open the chat to discuss the details and agree on terms.`;
  const rows: [string, string][] = [
    ['From', p.fromName || 'A buyer'],
  ];
  if (p.dealTitle) rows.push(['Service', p.dealTitle]);
  if (p.messagePreview) rows.push(['Message', p.messagePreview]);
  const link = p.link || '/messages';
  const { html, text } = layout(title, heading, rows, `Reply from the Messages page: ${link}`);
  const res = await sendMail(to, title, html, text);
  return { ...res, event: p.event, recipientResolved: !!email };
}

/**
 * A new chat reply. Fired server-side for every message that is not the initial
 * order (e.g. the buyer gets emailed when the seller replies).
 */
export async function notifyNewChatMessage(p: NotifyPayload) {
  const email = p.recipientEmail || await resolveEmailFromDb(String(p.recipientWallet || ''), String(p.recipientName || ''));
  const to = email || fallbackRecipient();
  const title = `New message from ${p.fromName || 'someone'} on Synq`;
  const heading = `${p.fromName || 'Someone'} sent you a message on Synq.`;
  const rows: [string, string][] = [
    ['From', p.fromName || 'A user'],
  ];
  if (p.messagePreview) rows.push(['Message', p.messagePreview]);
  const link = p.link || '/messages';
  const { html, text } = layout(title, heading, rows, `Open the conversation on the Messages page: ${link}`);
  const res = await sendMail(to, title, html, text);
  return { ...res, event: p.event, recipientResolved: !!email };
}
