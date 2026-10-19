export interface EmailConfig {
  smtp: { host: string; port: number; secure: boolean; user: string; pass: string };
  imap: { host: string; port: number; secure: boolean; user: string; pass: string };
  from: string;
  to: string;
  dailyHour: number;
  pollMinutes: number;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}. See .env.example.`);
  return v;
}

/**
 * Reads mail settings from the environment. Defaults target Gmail (app
 * password), but any provider works: set MAIL_PROVIDER=gmail for the Gmail
 * host defaults, or set SMTP_HOST / IMAP_HOST explicitly for anything else.
 */
export function loadEmailConfig(): EmailConfig {
  const provider = (process.env.MAIL_PROVIDER ?? "gmail").toLowerCase();
  const gmail = provider === "gmail";

  const smtpHost = process.env.SMTP_HOST ?? (gmail ? "smtp.gmail.com" : undefined);
  const imapHost = process.env.IMAP_HOST ?? (gmail ? "imap.gmail.com" : undefined);
  if (!smtpHost) throw new Error("Set SMTP_HOST (or MAIL_PROVIDER=gmail).");
  if (!imapHost) throw new Error("Set IMAP_HOST (or MAIL_PROVIDER=gmail).");

  const user = req("SMTP_USER");
  const pass = req("SMTP_PASS");
  const to = process.env.MAIL_TO ?? user;
  const from = process.env.MAIL_FROM ?? user;

  const PLACEHOLDER = /you@gmail\.com|example\.(com|org)|your-16-char-app-password/i;
  if (PLACEHOLDER.test(to) || PLACEHOLDER.test(from) || PLACEHOLDER.test(user)) {
    throw new Error(
      "MAIL_FROM / MAIL_TO (or SMTP_USER) still contain the example placeholder from .env.example. " +
        "Set them to your real address, or delete those lines so they default to SMTP_USER.",
    );
  }
  const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  if (!EMAIL.test(to)) throw new Error(`MAIL_TO "${to}" is not a valid email address.`);
  if (!EMAIL.test(from)) throw new Error(`MAIL_FROM "${from}" is not a valid email address.`);

  return {
    smtp: {
      host: smtpHost,
      port: Number.parseInt(process.env.SMTP_PORT ?? "465", 10),
      secure: (process.env.SMTP_SECURE ?? "true") !== "false",
      user,
      pass,
    },
    imap: {
      host: imapHost,
      port: Number.parseInt(process.env.IMAP_PORT ?? "993", 10),
      secure: (process.env.IMAP_SECURE ?? "true") !== "false",
      user: process.env.IMAP_USER ?? user,
      pass: process.env.IMAP_PASS ?? pass,
    },
    from,
    to,
    dailyHour: Number.parseInt(process.env.MAIL_DAILY_HOUR ?? "8", 10),
    pollMinutes: Number.parseInt(process.env.MAIL_POLL_MINUTES ?? "2", 10),
  };
}
