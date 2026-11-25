import express from 'express';
import crypto from 'crypto';
import { waitUntil } from '@vercel/functions';
import pool from '../config/db.js';
import { generateReply } from '../services/channelService.js';

const router = express.Router();

export const sendWhatsAppMessage = async (to, text) => {
  const res = await fetch(
    `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        text: { body: text },
      }),
    }
  );

  if (!res.ok) {
    console.error('WhatsApp send failed:', res.status, await res.text());
  }
};

const isValidSignature = (rawBody, signature) => {
  if (!signature || !process.env.WHATSAPP_APP_SECRET) return false;
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', process.env.WHATSAPP_APP_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const processMessage = async (phoneNumberId, message) => {
  const [claimed] = await pool.query(
    'INSERT IGNORE INTO processed_wa_messages (wamid) VALUES (?)',
    [message.id]
  );
  if (claimed.affectedRows === 0) return;

  const [clients] = await pool.query(
    'SELECT * FROM clients WHERE whatsapp_phone_number_id = ? AND is_active = 1',
    [phoneNumberId]
  );
  if (clients.length === 0) return;

  if (message.type !== 'text') {
    await sendWhatsAppMessage(message.from, 'Please send your message as text.');
    return;
  }

  const reply = await generateReply({
    client: clients[0],
    sessionId: `wa_${message.from}`,
    message: message.text.body,
  });

  await sendWhatsAppMessage(message.from, reply.slice(0, 4000));
};

router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

router.post('/webhook', express.raw({ type: '*/*' }), (req, res) => {
  if (!isValidSignature(req.body, req.headers['x-hub-signature-256'])) {
    return res.sendStatus(401);
  }

  let body;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.sendStatus(400);
  }

  res.sendStatus(200);

  const value = body.entry?.[0]?.changes?.[0]?.value;
  const messages = value?.messages;
  if (!messages) return;

  const phoneNumberId = value.metadata?.phone_number_id;

  const job = Promise.all(
    messages.map((m) =>
      processMessage(phoneNumberId, m).catch((err) =>
        console.error('WhatsApp process error:', err.message)
      )
    )
  );

  waitUntil(job);
});

export default router;