import { resolve } from "node:path";
import {
  getSnapshot,
  handleCommand,
  loadProfileWithExclusions,
  markDailySent,
  shouldSendDaily,
} from "../../agent/agent.js";
import { logger } from "../../lib/log.js";
import { localDate } from "../../lib/date.js";
import { loadEnv } from "../../lib/env.js";
import { selectForDigest } from "../../match/select.js";
import { renderDigestHtml, renderDigestText } from "../../report/digest.js";
import { loadEmailConfig, type EmailConfig } from "./config.js";
import {
  dailyDigestExists,
  fetchNewMail,
  previouslySentUrls,
  sendMail,
} from "./mailer.js";

const ROOT = resolve(import.meta.dirname, "../../..");
const PAGE_SIZE = 10;
/** No employer may take more than this many slots in one digest. */
const PER_COMPANY = 2;

/**
 * URLs already emailed in an earlier digest. Falls back to "nothing seen" if
 * IMAP is unavailable, so a mailbox hiccup can never stop the daily email.
 */
async function sentBeforeToday(config: EmailConfig): Promise<Set<string>> {
  try {
    return await previouslySentUrls(config, localDate());
  } catch (err) {
    logger.warn(`could not read past digests — sending without dedupe (${(err as Error).message})`);
    return new Set();
  }
}

async function sendDailyDigest(config: EmailConfig): Promise<void> {
  const snapshot = await getSnapshot(ROOT, false);
  const alreadySent = await sentBeforeToday(config);
  const profile = loadProfileWithExclusions(ROOT);
  const page = selectForDigest(snapshot.matches, {
    excludeUrls: alreadySent,
    limit: PAGE_SIZE,
    perCompany: PER_COMPANY,
  });

  if (page.length === 0) {
    await sendMail(config, {
      subject: `[jobfinder] no new matches for ${localDate()}`,
      text:
        `Nothing new today for ${profile.name}.\n\n` +
        `Every current match was already emailed in the last few days, so it isn't repeated here.\n` +
        `Reply "refresh" to re-run the search, or "more" to page through everything.`,
      html: `<p style="font-family:sans-serif">Nothing new today. Every current match was already emailed in the last few days, so it isn't repeated here.</p>
<p style="font-family:sans-serif">Reply <strong>refresh</strong> to re-run the search, or <strong>more</strong> to page through everything.</p>`,
    });
    markDailySent(ROOT);
    logger.info(`no new matches today (${snapshot.matches.length} in snapshot, all seen or capped)`);
    return;
  }

  logger.info(
    `digest: ${page.length} new of ${snapshot.matches.length} matches ` +
      `(${snapshot.matches.length - page.length} suppressed as already sent or over the per-company cap)`,
  );
  await sendMail(config, {
    subject: `[jobfinder] ${page.length} new match${page.length === 1 ? "" : "es"} for ${localDate()}`,
    text: renderDigestText(profile, page),
    html: renderDigestHtml(profile, page),
  });
  markDailySent(ROOT);
}

async function processInbox(config: EmailConfig): Promise<void> {
  const messages = await fetchNewMail(config);
  if (messages.length === 0) return;

  logger.info(`inbox: ${messages.length} new command(s)`);
  const alreadySent = await sentBeforeToday(config);
  for (const msg of messages) {
    const result = await handleCommand(ROOT, msg.text, { excludeUrls: alreadySent });
    await sendMail(config, {
      subject: result.subject,
      text: result.text,
      html: result.html,
      inReplyTo: msg.messageId,
    });
  }
}

async function tick(config: EmailConfig): Promise<void> {
  try {
    await processInbox(config);
  } catch (err) {
    logger.error(`inbox poll failed — ${(err as Error).message}`);
  }
  try {
    if (shouldSendDaily(ROOT, config.dailyHour)) {
      const today = localDate();
      // On a host with an ephemeral filesystem the local "already sent" marker
      // is unreliable, so double-check the mailbox before sending.
      if (await dailyDigestExists(config, today)) {
        logger.info("daily digest already in the mailbox for today; skipping");
        markDailySent(ROOT);
      } else {
        logger.info("sending daily digest");
        await sendDailyDigest(config);
      }
    }
  } catch (err) {
    logger.error(`daily send failed — ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  loadEnv(ROOT);
  const args = new Set(process.argv.slice(2));
  const config = loadEmailConfig();

  if (args.has("--test")) {
    const profile = loadProfileWithExclusions(ROOT);
    const snapshot = await getSnapshot(ROOT, false);
    const page = snapshot.matches.slice(0, PAGE_SIZE);
    await sendMail(config, {
      subject: "[jobfinder] test",
      text: renderDigestText(profile, page),
      html: renderDigestHtml(profile, page),
    });
    logger.info("test email sent");
    return;
  }

  if (args.has("--send-now")) {
    await sendDailyDigest(config);
    logger.info("daily digest sent");
    return;
  }

  if (args.has("--once")) {
    await tick(config);
    logger.info("one pass complete");
    return;
  }

  logger.info(`bot started (from ${config.from} to ${config.to}); polling every ${config.pollMinutes}m, daily at ${config.dailyHour}:00`);
  await tick(config);
  setInterval(() => void tick(config), config.pollMinutes * 60_000);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error(message);
  if (/535|BadCredentials|EAUTH|Username and Password not accepted/i.test(message)) {
    logger.error(
      "Gmail rejected the login. This almost always means SMTP_PASS is not a 16-character App Password. " +
        "Turn on 2-Step Verification, create an App Password at https://myaccount.google.com/apppasswords, " +
        "and put that value in .env as SMTP_PASS (spaces in it are fine, or remove them).",
    );
  }
  process.exitCode = 1;
});
