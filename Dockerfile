# Runs the email bot as a long-lived process. Works on any container host that
# allows outbound SMTP/IMAP (Fly.io, Koyeb, a VPS, Oracle Cloud Always Free…).
#
# NOTE: Render's free tier blocks outbound SMTP (ports 465/587), so it won't
# work there. Pass mail settings as runtime env vars, never bake in a .env.
FROM node:22-slim

WORKDIR /app

# Install deps first so this layer caches.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENV NODE_ENV=production
# The bot loop: polls the inbox every MAIL_POLL_MINUTES and sends the digest
# at/after MAIL_DAILY_HOUR.
CMD ["npx", "tsx", "src/channels/email/bot.ts"]
