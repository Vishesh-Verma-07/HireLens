import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer, { type Transporter } from "nodemailer";
import { localDate } from "../../lib/date.js";
import { logger } from "../../lib/log.js";
import type { EmailConfig } from "./config.js";

/** Every message this bot sends carries this header, so we never treat our own
 *  mail as a command. */
export const AGENT_HEADER = "X-Jobfinder";

let transport: Transporter | undefined;

function getTransport(config: EmailConfig): Transporter {
  transport ??= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
  return transport;
}

export interface OutgoingMail {
  subject: string;
  text: string;
  html: string;
  inReplyTo?: string;
}

export async function sendMail(config: EmailConfig, mail: OutgoingMail): Promise<void> {
  const headers: Record<string, string> = { [AGENT_HEADER]: "agent" };
  if (mail.inReplyTo) {
    headers["In-Reply-To"] = mail.inReplyTo;
    headers["References"] = mail.inReplyTo;
  }

  const info = await getTransport(config).sendMail({
    from: config.from,
    to: config.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    headers,
  });
  logger.debug(`envelope: from=${info.envelope?.from} to=${JSON.stringify(info.envelope?.to)} messageId=${info.messageId}`);
  logger.info(`sent: ${mail.subject} -> ${config.to}`);
}

// ---------------------------------------------------------------------------
// Daily-digest idempotency
// ---------------------------------------------------------------------------

/**
 * True if a daily digest for `date` (YYYY-MM-DD) is already in the mailbox.
 *
 * Why the mailbox and not a local file: on an ephemeral host (GitHub Actions,
 * a container) the local filesystem is wiped between runs, so `lastSentDate`
 * can't be trusted. The sent digest itself is the durable record — we send it
 * to ourselves, so it lands in the inbox.
 *
 * INBOX is checked first (that's where a self-send lands); All Mail is a
 * fallback in case a filter ever moves it.
 */
export async function dailyDigestExists(config: EmailConfig, date: string): Promise<boolean> {
  const client = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: { user: config.imap.user, pass: config.imap.pass },
    logger: false,
  });

  await client.connect();
  try {
    for (const mailbox of ["INBOX", "[Gmail]/All Mail"]) {
      try {
        const lock = await client.getMailboxLock(mailbox);
        try {
          const found = await client.search({ subject: `matches for ${date}` }, { uid: true });
          if ((Array.isArray(found) ? found : []).length > 0) return true;
        } finally {
          lock.release();
        }
      } catch {
        // Mailbox not present on this provider (e.g. not Gmail) — try the next.
      }
    }
    return false;
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/**
 * URLs of the jobs that were already emailed in a digest *before* `beforeDate`.
 *
 * Why the mailbox again: GitHub Actions wipes the filesystem between runs, so
 * a local seen-list can't survive. The digests are durable (we mail them to
 * ourselves), so the last few days of subjects plus their plain-text bodies are
 * enough to reconstruct what has already been shown without persisting state.
 */
export async function previouslySentUrls(
  config: EmailConfig,
  beforeDate: string,
  lookbackDays = 10,
): Promise<Set<string>> {
  const urls = new Set<string>();
  const client = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: { user: config.imap.user, pass: config.imap.pass },
    logger: false,
  });

  await client.connect();
  try {
    const since = new Date(Date.now() - lookbackDays * 86_400_000);
    let searched = false;
    for (const mailbox of ["INBOX", "[Gmail]/All Mail"]) {
      try {
        const lock = await client.getMailboxLock(mailbox);
        try {
          const found = await client.search({ since, subject: "matches for" }, { uid: true });
          searched = true;
          const uids = (Array.isArray(found) ? found : []).slice(-60);
          if (uids.length === 0) continue;

          // Collect everything before parsing: issuing another command while a
          // fetch stream is open deadlocks ImapFlow (see fetchNewMail).
          const messages = await client.fetchAll(uids, { uid: true, source: true }, { uid: true });
          for (const message of messages) {
            if (!message.source) continue;
            const parsed = await simpleParser(message.source);
            // Only past digests: today's own digest must not hide its jobs
            // from the "matches" command or from a re-run.
            if (!parsed.date || localDate(parsed.date) >= beforeDate) continue;

            for (const line of (parsed.text ?? "").split(/\r?\n/)) {
              const trimmed = line.trim();
              if (/^https?:\/\//i.test(trimmed)) urls.add(trimmed);
            }
          }
        } finally {
          lock.release();
        }
      } catch {
        // Mailbox not present on this provider — try the next one.
      }
    }
    if (!searched) logger.warn("could not search past digests — dedupe disabled for this run");
    return urls;
  } finally {
    await client.logout().catch(() => undefined);
  }
}

export interface IncomingMail {
  uid: number;
  from: string;
  subject: string;
  text: string;
  messageId?: string;
  /** true if this message was sent by the bot itself. */
  fromAgent: boolean;
}

/**
 * Fetches unseen messages and returns the ones that are genuine commands:
 * sent by the owner, and not sent by the bot. Marks everything it reads as
 * seen so it is never processed twice.
 */
export async function fetchNewMail(config: EmailConfig): Promise<IncomingMail[]> {
  const client = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: { user: config.imap.user, pass: config.imap.pass },
    logger: false,
  });

  const results: IncomingMail[] = [];
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    // Narrow to unseen mail from the owner, then work on the most recent few.
    const found = await client.search({ seen: false, from: config.to }, { uid: true });
    const uids = (Array.isArray(found) ? found : []).slice(-20);
    if (uids.length === 0) return results;

    // IMPORTANT: fully collect before sending any other command. Issuing STORE
    // (messageFlagsAdd) while a fetch stream is still open deadlocks ImapFlow.
    const messages = await client.fetchAll(uids, { uid: true, source: true }, { uid: true });

    for (const message of messages) {
      if (!message.source) continue;

      const parsed = await simpleParser(message.source);
      const from = parsed.from?.value?.[0]?.address ?? "";
      const fromAgent = Boolean(parsed.headers.get(AGENT_HEADER.toLowerCase()));

      // Only act on mail from the owner that the bot didn't send.
      if (from.toLowerCase() === config.to.toLowerCase() && !fromAgent) {
        results.push({
          uid: message.uid,
          from,
          subject: parsed.subject ?? "",
          text: parsed.text ?? "",
          messageId: parsed.messageId,
          fromAgent,
        });
      }
    }

    // Mark everything we read as seen (including our own digests/replies).
    await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
  } finally {
    lock.release();
    await client.logout().catch(() => undefined);
  }

  return results;
}
