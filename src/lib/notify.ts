import nodemailer from 'nodemailer';
import { getById } from './db';
import { normalizeWallet } from './utils';
import { isNotificationAllowed } from './deals/notification-preferences-db';

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Returns the canonical base URL of the Synq web application.
 * Resolves against APP_BASE_URL, NEXT_PUBLIC_APP_URL, VERCEL_URL, or falls back to production/localhost.
 */
export function getAppBaseUrl(): string {
  const url = process.env.APP_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined);
  if (url) {
    return url.replace(/\/+$/, '');
  }
  return process.env.NODE_ENV === 'production' ? 'https://synq.app' : 'http://localhost:3000';
}

/**
 * Validates and converts relative paths or absolute links into canonical Synq URLs.
 * Rejects or strips arbitrary external hostnames / phishing targets.
 */
export function formatAppUrl(pathOrUrl?: string): string {
  const base = getAppBaseUrl();
  if (!pathOrUrl) return base;
  const trimmed = pathOrUrl.trim();
  if (!trimmed) return base;

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const u = new URL(trimmed);
      const b = new URL(base);
      if (u.origin === b.origin) {
        return trimmed;
      }
      return `${base}${u.pathname}${u.search}${u.hash}`;
    } catch {
      return base;
    }
  }

  const cleanPath = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return `${base}${cleanPath}`;
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
  /** 'smtp' = delivers to a real inbox, 'log' = delivery unavailable. */
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
  fallbackRecipient?: string;
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

  // In staging environment, real SMTP delivery is disabled by default and
  // strictly requires explicit authorization via SYNQ_STAGING_ALLOW_SMTP=true
  if (process.env.SYNQ_ENV === 'staging' && process.env.SYNQ_STAGING_ALLOW_SMTP !== 'true') {
    missing.push('SYNQ_STAGING_ALLOW_SMTP');
  }

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
    fallbackRecipient: process.env.NOTIFY_FALLBACK_EMAIL || undefined,
    hint: live
      ? `Live delivery via ${host}:${port}.`
      : `Email delivery is unavailable. Set ${missing.join(' and ')} in the server environment to deliver email.`,
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
      '  │  Message contents are intentionally not written to logs.       │',
      '  │  Configure SMTP before relying on email delivery.              │',
      '  └───────────────────────────────────────────────────────────────┘',
      '',
    ].join('\n'),
  );
}

export type DeliveryStatus =
  | 'delivered'      // Successfully accepted by configured SMTP transport
  | 'log_only'       // Development log-only operation (not live)
  | 'retryable_fail' // Transient / network delivery failure
  | 'permanent_fail' // Permanent non-delivery condition (e.g. invalid recipient, unrecoverable)
  | 'skipped';       // No verified email or intentionally skipped

export interface MailResult {
  mode: 'smtp' | 'log' | 'skipped';
  deliveryStatus?: DeliveryStatus;
  to?: string;
  subject?: string;
  messageId?: string;
  skipped?: boolean;
  reason?: string;
  /** Set when SMTP delivery failed or log-only was invoked. */
  error?: string;
  event?: string;
  recipientResolved?: boolean;
}

let _testTransporter: nodemailer.Transporter | null = null;

/**
 * Injects a test transporter (e.g. Nodemailer jsonTransport or streamTransport)
 * for offline acceptance testing without real SMTP.
 * Disallowed in production environment.
 */
export function setTestTransporter(transporter: nodemailer.Transporter | null): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Cannot set test transporter in production environment');
  }
  _testTransporter = transporter;
}

export function getTestTransporter(): nodemailer.Transporter | null {
  return _testTransporter;
}

async function sendMail(to: string, subject: string, html: string, text: string): Promise<MailResult> {
  const status = getMailStatus();

  if (!_testTransporter && !status.live) {
    warnLogOnlyOnce(status);
    return {
      mode: 'log',
      deliveryStatus: 'log_only',
      to,
      subject,
      skipped: false,
    };
  }

  try {
    const transporter = _testTransporter || nodemailer.createTransport({
      host: status.host,
      port: status.port,
      secure: status.secure,
      auth: { user: process.env.SMTP_USER as string, pass: process.env.SMTP_PASS as string },
    });
    const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@synq.app';
    const info = await transporter.sendMail({
      from,
      to,
      subject,
      html,
      text,
    });
    return {
      mode: 'smtp',
      deliveryStatus: 'delivered',
      to,
      subject,
      messageId: info.messageId,
      skipped: false,
    };
  } catch (err: any) {
    // Never place the recipient, subject, verification code, or message body in
    // ordinary server logs. Provider details can also contain recipient data.
    console.error('[notify] SMTP delivery failed', { timestamp: new Date().toISOString() });
    const isPermanent =
      err?.permanent === true ||
      (typeof err?.responseCode === 'number' && err.responseCode >= 500 && err.responseCode < 600) ||
      err?.code === 'EENVELOPE';
    return {
      mode: 'smtp',
      deliveryStatus: isPermanent ? 'permanent_fail' : 'retryable_fail',
      to,
      subject,
      error: err?.message || 'SMTP delivery failed',
      skipped: false,
    };
  }
}

export interface NotifyPayload {
  event:
    | 'deal_confirmed'
    | 'work_submitted'
    | 'revision_requested'
    | 'deal_completed'
    | 'deal_completed_seller'
    | 'deal_cancelled'
    | 'payment_released'
    | 'order_inquiry'
    | 'chat_message'
    | 'order_confirmed'
    | 'proposal_received'
    | 'milestone_disputed'
    | 'milestone_refunded'
    | 'mutual_settlement_proposed'
    | 'mutual_settlement_executed'
    | 'mutual_settlement_cancelled'
    | 'resolution_report_filed'
    | 'committee_authorization_requested'
    | 'resolution_finalized';
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
  counterpartyWallet?: string;
  freelancerWallet?: string;
}

/**
 * Resolves the verified email address associated with a connected Web3 wallet.
 * Uses PostgreSQL authoritative user records. Returns empty string if no verified email exists.
 */
export async function resolveEmailFromDb(wallet: string): Promise<string> {
  try {
    if (!wallet) return '';
    const normalized = normalizeWallet(wallet);
    const user = await getById('users', normalized);
    return user?.email || '';
  } catch {
    return '';
  }
}

/**
 * Explicitly converts raw 6-decimal USDC base units into a clean, human-readable
 * display string with comma grouping and the "USDC" token label.
 *
 * Examples:
 * - 10000000n or "10000000" -> "10 USDC"
 * - 500000n or "500000" -> "0.5 USDC"
 * - 1000000000n or "1000000000" -> "1,000 USDC"
 * - 0n or "0" -> "0 USDC"
 *
 * Guarantees zero floating-point precision loss via pure BigInt integer arithmetic.
 */
export function formatUsdcBaseUnits(baseUnits: bigint | string | number): string {
  const b = typeof baseUnits === 'bigint' ? baseUnits : BigInt(String(baseUnits).trim());
  if (b < 0n) {
    throw new Error('USDC amount cannot be negative');
  }
  const whole = b / 1_000_000n;
  const fraction = b % 1_000_000n;
  const wholeFormatted = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (fraction === 0n) {
    return `${wholeFormatted} USDC`;
  }
  const fractionStr = fraction.toString().padStart(6, '0').replace(/0+$/, '');
  return `${wholeFormatted}.${fractionStr} USDC`;
}

/**
 * Formats a deal or milestone amount for clean, unambiguous email notifications.
 *
 * Requirements & Invariants:
 * 1. Raw base units (BigInt or pure numeric string without token label) are converted
 *    exactly once via formatUsdcBaseUnits.
 * 2. Already-formatted display strings (containing "USDC" or non-numeric tokens) are
 *    NEVER interpreted as base units. Misleading currency prefixes ($) are sanitized.
 * 3. Settlement split descriptions (e.g. "3000 USDC / 2000 USDC Split") are preserved.
 * 4. Empty, undefined, or null amounts return an empty string.
 */
export function formatDealAmount(rawAmount: bigint | number | string | undefined | null): string {
  if (rawAmount === undefined || rawAmount === null) return '';
  const s = String(rawAmount).trim();
  if (!s || s === '—' || s === '-') return '';

  // Case 1: BigInt is strictly raw base units
  if (typeof rawAmount === 'bigint') {
    return formatUsdcBaseUnits(rawAmount);
  }

  // Case 2: Pure integer string without token label (e.g. "10000000", "500000", "1000000000", "0")
  // Unambiguously raw base units from DB/contracts: convert exactly once
  if (/^\d+$/.test(s)) {
    return formatUsdcBaseUnits(BigInt(s));
  }

  // Case 3: Number
  if (typeof rawAmount === 'number') {
    if (!Number.isFinite(rawAmount) || rawAmount < 0) return '';
    if (rawAmount === 0) return '0 USDC';
    if (Number.isInteger(rawAmount) && rawAmount >= 100_000) {
      return formatUsdcBaseUnits(BigInt(rawAmount));
    }
    const [w, f] = String(rawAmount).split('.');
    const wholeFormatted = BigInt(w).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return f ? `${wholeFormatted}.${f} USDC` : `${wholeFormatted} USDC`;
  }

  // Case 4: Already-formatted display string containing "USDC"
  // (e.g. "10 USDC", "10000000 USDC", "$10000000 USDC", "$500 USDC", "3000 USDC / 2000 USDC Split")
  // Rule: Display strings are NEVER interpreted as base units!
  if (/USDC/i.test(s)) {
    const withoutDollar = s.replace(/^\$\s*/, '').trim();
    // If it is a simple integer + USDC (e.g. "10000000 USDC" or "10 USDC"), format with commas
    const simpleNumMatch = withoutDollar.match(/^(\d+)(\s*USDC)$/i);
    if (simpleNumMatch) {
      const numFormatted = BigInt(simpleNumMatch[1]).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      return `${numFormatted} USDC`;
    }
    return withoutDollar;
  }

  // Case 5: Plain decimal or currency string without token label (e.g. "$10", "10", "1,000", "$1,000")
  const cleaned = s.replace(/^\$\s*/, '').replace(/,/g, '').trim();
  if (/^\d+(?:\.\d+)?$/.test(cleaned)) {
    const [w, f] = cleaned.split('.');
    const wholeFormatted = BigInt(w).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const trimmedF = f ? f.replace(/0+$/, '') : '';
    return trimmedF ? `${wholeFormatted}.${trimmedF} USDC` : `${wholeFormatted} USDC`;
  }

  // Fallback: strip leading $ and return clean string
  return s.replace(/^\$\s*/, '').trim();
}

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

/**
 * Resolves verified recipient email and validates user notification preferences.
 * If no email is linked, or if the user has opted out of this event's category,
 * returns an appropriate skipped MailResult without sending an email.
 */
export async function resolveRecipientForNotification(
  wallet: string,
  event: string,
): Promise<{ email?: string; skip?: MailResult }> {
  const email = await resolveEmailFromDb(wallet);
  if (!email) {
    return {
      skip: {
        mode: 'skipped',
        deliveryStatus: 'skipped',
        skipped: true,
        reason: 'No verified email linked to recipient wallet',
        event,
        recipientResolved: false,
      },
    };
  }

  const allowed = await isNotificationAllowed(wallet, event);
  if (!allowed) {
    return {
      skip: {
        mode: 'skipped',
        deliveryStatus: 'skipped',
        skipped: true,
        reason: `Recipient opted out of ${event} notifications`,
        event,
        recipientResolved: true,
      },
    };
  }

  return { email };
}

export async function notifyBuyerDealConfirmed(p: NotifyPayload): Promise<MailResult> {
  const { email, skip } = await resolveRecipientForNotification(String(p.recipientWallet || ''), p.event);
  if (skip || !email) return skip!;
  const title = 'Your deal proposal has been accepted';
  const heading = 'The freelancer has accepted your deal proposal. Funds are locked in escrow and the deal is now active.';
  const displayAmount = formatDealAmount(p.dealAmount);
  const rows: [string, string][] = [
    ['Deal', p.dealTitle || 'Untitled deal'],
    ['Freelancer', p.freelancerWallet || p.counterpartyWallet || '—'],
    ['Amount', displayAmount || '—'],
    ['Reference', p.dealId || '—'],
  ];
  if (p.note) rows.push(['Note', p.note]);
  const dealLink = formatAppUrl(p.link || (p.dealId ? `/deals/${p.dealId}` : '/deals'));
  const { html, text } = layout(title, heading, rows, `Open the deal to view milestones and track progress: ${dealLink}`);
  const res = await sendMail(email, title, html, text);
  return { ...res, event: p.event, recipientResolved: true };
}

/** Backward-compatible export alias for notifyBuyerDealConfirmed */
export const notifyDealConfirmedToSeller = notifyBuyerDealConfirmed;

export async function notifyBuyerWorkSubmitted(p: NotifyPayload): Promise<MailResult> {
  const { email, skip } = await resolveRecipientForNotification(String(p.recipientWallet || ''), p.event);
  if (skip || !email) return skip!;
  const title = 'Work submitted on your deal';
  const heading = 'The seller has submitted work with evidence for your review. Approve to release escrow, or request a revision.';
  const displayAmount = formatDealAmount(p.dealAmount);
  const rows: [string, string][] = [
    ['Deal', p.dealTitle || 'Untitled deal'],
    ['Amount', displayAmount || '-'],
  ];
  if (p.evidence) rows.push(['Evidence', p.evidence]);
  if (p.note) rows.push(['Milestone', p.note]);
  rows.push(['Reference', p.dealId || '-']);
  const dealLink = formatAppUrl(p.dealId ? `/deals/${p.dealId}` : '/deals');
  const { html, text } = layout(title, heading, rows, `Open the deal to review the submitted work and evidence: ${dealLink}`);
  const res = await sendMail(email, title, html, text);
  return { ...res, event: p.event, recipientResolved: true };
}

export async function notifyFreelancerRevisionRequested(p: NotifyPayload): Promise<MailResult> {
  const { email, skip } = await resolveRecipientForNotification(String(p.recipientWallet || ''), p.event);
  if (skip || !email) return skip!;
  const title = 'Revision requested on your deal';
  const heading = 'The buyer has reviewed your work and requested revisions for a milestone.';
  const displayAmount = formatDealAmount(p.dealAmount);
  const rows: [string, string][] = [
    ['Deal', p.dealTitle || 'Untitled deal'],
    ['Amount', displayAmount || '-'],
  ];
  if (p.note) rows.push(['Milestone', p.note]);
  if (p.evidence) rows.push(['Feedback', p.evidence]);
  rows.push(['Reference', p.dealId || '-']);
  const dealLink = formatAppUrl(p.dealId ? `/deals/${p.dealId}` : '/deals');
  const { html, text } = layout(title, heading, rows, `Open the deal to review the buyer feedback and submit updated work: ${dealLink}`);
  const res = await sendMail(email, title, html, text);
  return { ...res, event: p.event, recipientResolved: true };
}

export async function notifyBuyerDealCompleted(p: NotifyPayload): Promise<MailResult> {
  const { email, skip } = await resolveRecipientForNotification(String(p.recipientWallet || ''), p.event);
  if (skip || !email) return skip!;
  const title = 'Your deal is complete';
  const heading = 'All milestones are approved. The deal is completed and escrow has been distributed.';
  const displayAmount = formatDealAmount(p.dealAmount);
  const rows: [string, string][] = [
    ['Deal', p.dealTitle || 'Untitled deal'],
    ['Amount', displayAmount || '—'],
    ['Reference', p.dealId || '—'],
  ];
  if (p.note) rows.push(['Note', p.note]);
  const dealLink = formatAppUrl(p.dealId ? `/deals/${p.dealId}` : '/deals');
  const { html, text } = layout(title, heading, rows, `Thank you for using Synq. View the completed deal: ${dealLink}`);
  const res = await sendMail(email, title, html, text);
  return { ...res, event: p.event, recipientResolved: true };
}

/**
 * One-time sign-in code. Sent to the address the user explicitly typed.
 * Verification codes are strictly delivered to the user-supplied recipient.
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

export async function notifySellerDealCompleted(p: NotifyPayload): Promise<MailResult> {
  const { email, skip } = await resolveRecipientForNotification(String(p.recipientWallet || ''), p.event);
  if (skip || !email) return skip!;
  const title = 'Deal completed - payment received';
  const heading = 'The buyer approved the final milestone. The escrowed payment has been released to your wallet.';
  const displayAmount = formatDealAmount(p.dealAmount);
  const rows: [string, string][] = [
    ['Deal', p.dealTitle || 'Untitled deal'],
    ['Amount', displayAmount || '-'],
    ['Reference', p.dealId || '-'],
  ];
  if (p.note) rows.push(['Note', p.note]);
  const dealLink = formatAppUrl(p.dealId ? `/deals/${p.dealId}` : '/deals');
  const { html, text } = layout(title, heading, rows, `The full escrow amount for this deal has been settled on-chain: ${dealLink}`);
  const res = await sendMail(email, title, html, text);
  return { ...res, event: p.event, recipientResolved: true };
}

export async function notifyDealCancelled(p: NotifyPayload): Promise<MailResult> {
  const { email, skip } = await resolveRecipientForNotification(String(p.recipientWallet || ''), p.event);
  if (skip || !email) return skip!;
  const title = 'A deal you are part of was cancelled';
  const heading = 'The buyer cancelled this deal. Any escrow balance was refunded to the buyer and the contract accepts no further actions.';
  const displayAmount = formatDealAmount(p.dealAmount);
  const rows: [string, string][] = [
    ['Deal', p.dealTitle || 'Untitled deal'],
    ['Amount', displayAmount || '-'],
    ['Reference', p.dealId || '-'],
  ];
  if (p.note) rows.push(['Note', p.note]);
  const dealLink = formatAppUrl(p.dealId ? `/deals/${p.dealId}` : '/deals');
  const { html, text } = layout(title, heading, rows, `No funds move to the seller on cancellation: ${dealLink}`);
  const res = await sendMail(email, title, html, text);
  return { ...res, event: p.event, recipientResolved: true };
}

export async function notifySellerPaymentReleased(p: NotifyPayload): Promise<MailResult> {
  const { email, skip } = await resolveRecipientForNotification(String(p.recipientWallet || ''), p.event);
  if (skip || !email) return skip!;
  const title = 'Payment received';
  const heading = 'The buyer approved your work and the escrowed amount for this milestone has been released to your wallet.';
  const displayAmount = formatDealAmount(p.dealAmount);
  const rows: [string, string][] = [
    ['Deal', p.dealTitle || 'Untitled deal'],
    ['Amount', displayAmount || '-'],
  ];
  if (p.note) rows.push(['Milestone', p.note]);
  rows.push(['Reference', p.dealId || '-']);
  const dealLink = formatAppUrl(p.dealId ? `/deals/${p.dealId}` : '/deals');
  const { html, text } = layout(title, heading, rows, `Funds were transferred on-chain from the deal contract straight to your wallet: ${dealLink}`);
  const res = await sendMail(email, title, html, text);
  return { ...res, event: p.event, recipientResolved: true };
}

/**
 * A buyer opened a chat and sent their first order/brief to a seller. Fired
 * server-side on every new order message so the seller hears about it even when
 * they are not on the site.
 */
export async function notifySellerOrderInquiry(p: NotifyPayload): Promise<MailResult> {
  const { email, skip } = await resolveRecipientForNotification(String(p.recipientWallet || ''), p.event);
  if (skip || !email) return skip!;
  const title = 'New order — a buyer wants to work with you';
  const heading = `${p.fromName || 'A buyer'} sent you an order on Synq. Open the chat to discuss the details and agree on terms.`;
  const rows: [string, string][] = [
    ['From', p.fromName || 'A buyer'],
  ];
  if (p.dealTitle) rows.push(['Service', p.dealTitle]);
  if (p.messagePreview) rows.push(['Message', p.messagePreview]);
  const link = formatAppUrl(p.link || '/messages');
  const { html, text } = layout(title, heading, rows, `Reply from the Messages page: ${link}`);
  const res = await sendMail(email, title, html, text);
  return { ...res, event: p.event, recipientResolved: true };
}

/**
 * Seller confirmed the order → email the buyer.
 */
export async function notifyBuyerOrderConfirmed(p: NotifyPayload): Promise<MailResult> {
  const { email, skip } = await resolveRecipientForNotification(String(p.recipientWallet || ''), p.event);
  if (skip || !email) return skip!;
  const title = 'Your order was confirmed';
  const heading = `${p.fromName || 'The seller'} has confirmed your order.`;
  const displayAmount = formatDealAmount(p.dealAmount);
  const rows: [string, string][] = [
    ['Service', p.dealTitle || '—'],
    ['Budget', displayAmount || '—'],
  ];
  if (p.note) rows.push(['Payment split', p.note]);
  rows.push(['Reference', p.dealId || '—']);
  const link = formatAppUrl(p.link || '/messages');
  const { html, text } = layout(title, heading, rows, `Open the conversation to discuss next steps and create an escrow deal: ${link}`);
  const res = await sendMail(email, title, html, text);
  return { ...res, event: p.event, recipientResolved: true };
}

export async function notifyNewChatMessage(p: NotifyPayload): Promise<MailResult> {
  const { email, skip } = await resolveRecipientForNotification(String(p.recipientWallet || ''), p.event);
  if (skip || !email) return skip!;
  const title = `New message from ${p.fromName || 'someone'} on Synq`;
  const heading = `${p.fromName || 'Someone'} sent you a message on Synq.`;
  const rows: [string, string][] = [
    ['From', p.fromName || 'A user'],
  ];
  if (p.messagePreview) rows.push(['Message', p.messagePreview]);
  const link = formatAppUrl(p.link || '/messages');
  const { html, text } = layout(title, heading, rows, `Open the conversation on the Messages page: ${link}`);
  const res = await sendMail(email, title, html, text);
  return { ...res, event: p.event, recipientResolved: true };
}

export async function notifyProposalReceived(p: NotifyPayload): Promise<MailResult> {
  const { email, skip } = await resolveRecipientForNotification(String(p.recipientWallet || ''), p.event);
  if (skip || !email) return skip!;
  const title = 'New deal proposal received';
  const heading = 'You received a new deal proposal on Synq. Review the terms and milestones to accept.';
  const displayAmount = formatDealAmount(p.dealAmount);
  const rows: [string, string][] = [
    ['Deal', p.dealTitle || 'Untitled deal'],
    ['Amount', displayAmount || '—'],
    ['Reference', p.dealId || '—'],
  ];
  if (p.note) rows.push(['Note', p.note]);
  const dealLink = formatAppUrl(p.dealId ? `/deals/proposals/${p.dealId}` : '/deals');
  const { html, text } = layout(title, heading, rows, `Sign in to view and accept or decline the proposal: ${dealLink}`);
  const res = await sendMail(email, title, html, text);
  return { ...res, event: p.event, recipientResolved: true };
}

export async function notifyMilestoneDisputed(p: NotifyPayload): Promise<MailResult> {
  const { email, skip } = await resolveRecipientForNotification(String(p.recipientWallet || ''), p.event);
  if (skip || !email) return skip!;
  const title = 'Milestone dispute opened';
  const heading = 'A milestone dispute was submitted. An assigned resolver will examine the contract terms and deliverables.';
  const rows: [string, string][] = [
    ['Deal', p.dealTitle || 'Untitled deal'],
    ['Reference', p.dealId || '—'],
  ];
  if (p.note) rows.push(['Milestone', p.note]);
  const dealLink = formatAppUrl(p.dealId ? `/deals/${p.dealId}` : '/deals');
  const { html, text } = layout(title, heading, rows, `Review the dispute details: ${dealLink}`);
  const res = await sendMail(email, title, html, text);
  return { ...res, event: p.event, recipientResolved: true };
}

export async function notifyBuyerMilestoneRefunded(p: NotifyPayload): Promise<MailResult> {
  const { email, skip } = await resolveRecipientForNotification(String(p.recipientWallet || ''), p.event);
  if (skip || !email) return skip!;
  const title = 'Milestone refund received';
  const heading = 'A milestone settlement on your deal resulted in a refund. The escrowed funds have been returned to your wallet.';
  const displayAmount = formatDealAmount(p.dealAmount);
  const rows: [string, string][] = [
    ['Deal', p.dealTitle || 'Untitled deal'],
    ['Amount', displayAmount || '—'],
    ['Reference', p.dealId || '—'],
  ];
  if (p.note) rows.push(['Milestone', p.note]);
  const dealLink = formatAppUrl(p.dealId ? `/deals/${p.dealId}` : '/deals');
  const { html, text } = layout(title, heading, rows, `View the updated deal and settlement details: ${dealLink}`);
  const res = await sendMail(email, title, html, text);
  return { ...res, event: p.event, recipientResolved: true };
}

export async function notifyMutualSettlementProposed(p: NotifyPayload): Promise<MailResult> {
  const { email, skip } = await resolveRecipientForNotification(String(p.recipientWallet || ''), p.event);
  if (skip || !email) return skip!;
  const title = 'Mutual settlement proposed';
  const heading = 'A mutual settlement proposal was submitted for this milestone. Review the proposed fund split and respond in Synq.';
  const rows: [string, string][] = [
    ['Deal', p.dealTitle || 'Untitled deal'],
    ['Reference', p.dealId || '—'],
  ];
  if (p.note) rows.push(['Milestone', p.note]);
  const displayAmount = formatDealAmount(p.dealAmount);
  if (displayAmount) rows.push(['Proposed Split', displayAmount]);
  const dealLink = formatAppUrl(p.dealId ? `/deals/${p.dealId}` : '/deals');
  const { html, text } = layout(title, heading, rows, `Review the settlement proposal and sign or decline: ${dealLink}`);
  const res = await sendMail(email, title, html, text);
  return { ...res, event: p.event, recipientResolved: true };
}

export async function notifyMutualSettlementExecuted(p: NotifyPayload): Promise<MailResult> {
  const { email, skip } = await resolveRecipientForNotification(String(p.recipientWallet || ''), p.event);
  if (skip || !email) return skip!;
  const title = 'Mutual settlement finalized';
  const heading = 'The agreed mutual settlement has been executed on-chain. Escrowed funds have been distributed according to the mutual agreement.';
  const rows: [string, string][] = [
    ['Deal', p.dealTitle || 'Untitled deal'],
    ['Reference', p.dealId || '—'],
  ];
  if (p.note) rows.push(['Milestone', p.note]);
  const displayAmount = formatDealAmount(p.dealAmount);
  if (displayAmount) rows.push(['Settlement Amount', displayAmount]);
  const dealLink = formatAppUrl(p.dealId ? `/deals/${p.dealId}` : '/deals');
  const { html, text } = layout(title, heading, rows, `View your updated balances and deal history: ${dealLink}`);
  const res = await sendMail(email, title, html, text);
  return { ...res, event: p.event, recipientResolved: true };
}

export async function notifyMutualSettlementCancelled(p: NotifyPayload): Promise<MailResult> {
  const { email, skip } = await resolveRecipientForNotification(String(p.recipientWallet || ''), p.event);
  if (skip || !email) return skip!;
  const title = 'Mutual settlement proposal cancelled';
  const heading = 'A mutual settlement proposal on your deal has been cancelled on-chain.';
  const rows: [string, string][] = [
    ['Deal', p.dealTitle || 'Untitled deal'],
    ['Reference', p.dealId || '—'],
  ];
  if (p.note) rows.push(['Milestone', p.note]);
  const dealLink = formatAppUrl(p.dealId ? `/deals/${p.dealId}` : '/deals');
  const { html, text } = layout(title, heading, rows, `View current milestone status in Synq: ${dealLink}`);
  const res = await sendMail(email, title, html, text);
  return { ...res, event: p.event, recipientResolved: true };
}

export async function notifyResolutionReportFiled(p: NotifyPayload): Promise<MailResult> {
  const { email, skip } = await resolveRecipientForNotification(String(p.recipientWallet || ''), p.event);
  if (skip || !email) return skip!;
  const title = 'Committee resolution report filed';
  const heading = 'An authorized member of the resolution committee has filed a formal report for the disputed milestone. Review the findings and determination in Synq.';
  const rows: [string, string][] = [
    ['Deal', p.dealTitle || 'Untitled deal'],
    ['Reference', p.dealId || '—'],
  ];
  if (p.note) rows.push(['Milestone', p.note]);
  const dealLink = formatAppUrl(p.dealId ? `/deals/${p.dealId}` : '/deals');
  const { html, text } = layout(title, heading, rows, `Authenticate in Synq to review the verified committee report: ${dealLink}`);
  const res = await sendMail(email, title, html, text);
  return { ...res, event: p.event, recipientResolved: true };
}

export async function notifyCommitteeAuthorizationRequested(p: NotifyPayload): Promise<MailResult> {
  const { email, skip } = await resolveRecipientForNotification(String(p.recipientWallet || ''), p.event);
  if (skip || !email) return skip!;
  const title = 'Committee authorization signature requested';
  const heading = 'Your cryptographic signature is requested as an authorized committee member to approve or reject a milestone resolution action.';
  const rows: [string, string][] = [
    ['Deal', p.dealTitle || 'Untitled deal'],
    ['Reference', p.dealId || '—'],
  ];
  if (p.note) rows.push(['Action Details', p.note]);
  const dealLink = formatAppUrl(p.dealId ? `/deals/${p.dealId}` : '/deals');
  const { html, text } = layout(title, heading, rows, `Review the authorization payload and submit your signature: ${dealLink}`);
  const res = await sendMail(email, title, html, text);
  return { ...res, event: p.event, recipientResolved: true };
}

export async function notifyResolutionFinalized(p: NotifyPayload): Promise<MailResult> {
  const { email, skip } = await resolveRecipientForNotification(String(p.recipientWallet || ''), p.event);
  if (skip || !email) return skip!;
  const title = 'Milestone dispute resolved';
  const heading = 'The resolution committee has executed the final determination on-chain. Escrowed funds have been settled.';
  const rows: [string, string][] = [
    ['Deal', p.dealTitle || 'Untitled deal'],
    ['Reference', p.dealId || '—'],
  ];
  if (p.note) rows.push(['Milestone', p.note]);
  const dealLink = formatAppUrl(p.dealId ? `/deals/${p.dealId}` : '/deals');
  const { html, text } = layout(title, heading, rows, `View final resolution and settlement details: ${dealLink}`);
  const res = await sendMail(email, title, html, text);
  return { ...res, event: p.event, recipientResolved: true };
}
