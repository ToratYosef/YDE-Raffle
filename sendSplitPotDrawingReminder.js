#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

const DRAWING_TIME_ISO = process.env.SPLIT_POT_DRAW_TIME || '2024-10-27T15:00:00-04:00';
const DRAWING_DISPLAY_TEXT = 'today, October 27, at around 3:00 PM Eastern';

function resolveServiceAccount() {
  const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (serviceAccountJson) {
    try {
      return JSON.parse(serviceAccountJson);
    } catch (error) {
      throw new Error(`Unable to parse FIREBASE_SERVICE_ACCOUNT JSON: ${error.message}`);
    }
  }

  const candidates = [];
  if (serviceAccountPath) {
    candidates.push(path.isAbsolute(serviceAccountPath) ? serviceAccountPath : path.resolve(process.cwd(), serviceAccountPath));
  }
  candidates.push(path.join(__dirname, 'serviceAccountKey.json'));
  candidates.push(path.resolve(process.cwd(), 'serviceAccountKey.json'));

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        return JSON.parse(raw);
      }
    } catch (e) {
      throw new Error(`Unable to load service account file at ${p}: ${e.message}`);
    }
  }

  throw new Error('Service account not found. Set FIREBASE_SERVICE_ACCOUNT, GOOGLE_APPLICATION_CREDENTIALS, or place serviceAccountKey.json next to this script.');
}

function initializeFirebase() {
  if (admin.apps.length > 0) return admin.firestore();
  const credentials = resolveServiceAccount();
  admin.initializeApp({ credential: admin.credential.cert(credentials) });
  return admin.firestore();
}

function createTransporter() {
  const { MAIL_EMAIL, MAIL_PASSWORD, MAIL_SERVICE, MAIL_HOST, MAIL_PORT, MAIL_SECURE } = process.env;
  if (!MAIL_EMAIL || !MAIL_PASSWORD) {
    throw new Error('MAIL_EMAIL and MAIL_PASSWORD environment variables are required to send emails.');
  }
  if (MAIL_SERVICE) {
    return nodemailer.createTransport({ service: MAIL_SERVICE, auth: { user: MAIL_EMAIL, pass: MAIL_PASSWORD } });
  }
  const port = MAIL_PORT ? Number(MAIL_PORT) : 465;
  const secure = MAIL_SECURE ? MAIL_SECURE.toLowerCase() === 'true' : port === 465;
  return nodemailer.createTransport({
    host: MAIL_HOST || 'smtp.gmail.com',
    port,
    secure,
    auth: { user: MAIL_EMAIL, pass: MAIL_PASSWORD },
  });
}

function getCountdown(targetDate, referenceDate = new Date()) {
  const diffMs = Math.max(0, targetDate.getTime() - referenceDate.getTime());
  const totalSeconds = Math.floor(diffMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return { hours, minutes, seconds };
}

function formatCountdown({ hours, minutes, seconds }) {
  const pad = (v) => String(v).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function buildEmailContent({ name, ticketCount, countdown, drawDate }) {
  const friendlyName = name || 'there';
  const ticketsLabel = ticketCount > 1 ? `${ticketCount} tickets` : 'a ticket';
  const countdownFormatted = formatCountdown(countdown);
  const countdownVerbose = `${countdown.hours} hours, ${countdown.minutes} minutes, and ${countdown.seconds} seconds`;

  const plainText = `Hi ${friendlyName},\n\nThis is a quick reminder that the Split the Pot drawing is happening ${DRAWING_DISPLAY_TEXT}.\n\nYou have ${ticketsLabel} in the drawing. The countdown is currently ${countdown.hours} hours, ${countdown.minutes} minutes, and ${countdown.seconds} seconds remaining.\n\nGood luck and thank you for supporting the fundraiser!\n`;

  const html = `
    <div style="font-family: Arial, sans-serif; color: #1f2937;">
      <p>Hi ${friendlyName},</p>
      <p>This is a quick reminder that the <strong>Split the Pot drawing is happening ${DRAWING_DISPLAY_TEXT}</strong>.</p>
      <p>You have <strong>${ticketsLabel}</strong> in the drawing.</p>
      <p style="margin-top: 24px; font-size: 14px; color: #374151;">Countdown to the drawing:</p>
      <div style="display: inline-block; padding: 16px 24px; background-color: #111827; color: #f9fafb; font-size: 24px; letter-spacing: 0.08em; border-radius: 8px;">
        ${countdownFormatted}
      </div>
      <p style="margin-top: 12px; font-size: 14px; color: #374151;">That is <strong>${countdownVerbose}</strong> remaining.</p>
      <p style="margin-top: 8px; font-size: 12px; color: #6b7280;">(HH:MM:SS remaining until ${drawDate.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', month: 'long', day: 'numeric' })})</p>
      <p style="margin-top: 24px;">Good luck and thank you for supporting the fundraiser!</p>
    </div>
  `;
  return { plainText, html };
}

async function fetchSplitPotRecipients(db) {
  const snapshot = await db.collection('splitThePotTickets').get();
  const recipients = [];
  snapshot.forEach((doc) => {
    const data = doc.data() || {};
    const email = (data.email || '').trim();
    if (!email || !email.includes('@')) return;
    recipients.push({
      email,
      name: data.firstName || data.fullName || '',
      ticketCount: Number(data.ticketCount || data.ticketsBought || 1),
      id: doc.id,
    });
  });
  return recipients;
}

function ensureTestRecipient(recipients) {
  const testEmail = 'saulsetton16@gmail.com';
  const hasTestRecipient = recipients.some((r) => r.email.toLowerCase() === testEmail.toLowerCase());
  if (!hasTestRecipient) {
    recipients.push({ email: testEmail, name: 'Split the Pot Tester', ticketCount: 1, id: 'test-saulsetton16' });
  }
  return recipients;
}

async function main() {
  const drawDate = new Date(DRAWING_TIME_ISO);
  if (Number.isNaN(drawDate.getTime())) {
    throw new Error(`The configured drawing time "${DRAWING_TIME_ISO}" is not a valid date.`);
  }

  const db = initializeFirebase();
  const transporter = createTransporter();
  const recipients = ensureTestRecipient(await fetchSplitPotRecipients(db));

  if (recipients.length === 0) {
    console.log('No Split the Pot tickets with valid email addresses were found.');
    return;
  }

  console.log(`Preparing to email ${recipients.length} Split the Pot ticket${recipients.length === 1 ? '' : 's'}.`);

  let successCount = 0;
  let failureCount = 0;

  for (const recipient of recipients) {
    const countdown = getCountdown(drawDate, new Date());
    const { plainText, html } = buildEmailContent({
      name: recipient.name,
      ticketCount: recipient.ticketCount,
      countdown,
      drawDate,
    });

    const mailOptions = {
      from: process.env.MAIL_FROM || process.env.MAIL_EMAIL,
      to: recipient.email,
      subject: 'Split the Pot drawing is today at 3:00 PM!',
      text: plainText,
      html,
    };

    try {
      await transporter.sendMail(mailOptions);
      successCount += 1;
      console.log(`✔ Email sent to ${recipient.email} (ticket ID: ${recipient.id}).`);
    } catch (error) {
      failureCount += 1;
      console.error(`✖ Failed to send email to ${recipient.email} (ticket ID: ${recipient.id}):`, error.message);
    }
  }

  console.log(`Finished sending reminders. Success: ${successCount}, Failed: ${failureCount}.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error while sending Split the Pot reminders:', error);
    process.exitCode = 1;
  });
}

module.exports = {
  DRAWING_TIME_ISO,
  getCountdown,
  formatCountdown,
  buildEmailContent,
  fetchSplitPotRecipients,
  ensureTestRecipient,
};
