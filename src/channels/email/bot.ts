import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  getSnapshot,
  handleCommand,
  loadProfileWithExclusions,
  markDailySent,
  shouldSendDaily,
} from "../../agent/agent.js";
import { logger } from "../../lib/log.js";
import { renderDigestHtml, renderDigestText } from "../../report/digest.js";
import { loadEmailConfig, type EmailConfig } from "./config.js";
import { dailyDigestExists, fetchNewMail, sendMail } from "./mailer.js";

const ROOT = resolve(import.meta.dirname, "../../..");
const PAGE_SIZE = 10;

function loadEnv(): void {
  const path = resolve(ROOT, ".env");
  try {
    if (existsSync(path) && typeof process.loadEnvFile === "function") {
      process.loadEnvFile(path);
    }
  } catch (err) {
    logger.warn(`could not load .env — ${(err as Error).message}`);
  }
}

async function sendDailyDigest(config: EmailConfig): Promise<void> {
  const snapshot = await getSnapshot(ROOT, false);
  const page = snapshot.matches.slice(0, PAGE_SIZE);
  const profile = loadProfileWithExclusions(ROOT);

  await sendMail(config, {
    subject: `[jobfinder] ${page.length} match${page.length === 1 ? "" : "es"} for ${new Date().toISOString().slice(0, 10)}`,
    text: renderDigestText(profile, page),
    html: renderDigestHtml(profile, page),
  });
  markDailySent(ROOT);
}

async function processInbox(config: EmailConfig): Promise<void> {
  const messages = await fetchNewMail(config);
  if (messages.length === 0) return;

  logger.info(`inbox: ${messages.length} new command(s)`);
  for (const msg of messages) {
    const result = await handleCommand(ROOT, msg.text);
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
      const today = new Date().toISOString().slice(0, 10);
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
  loadEnv();
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
