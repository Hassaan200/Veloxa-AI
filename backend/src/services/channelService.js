import pool from '../config/db.js';
import { getAIReply } from './aiService.js';
import {
  getSessionState,
  setSessionState,
  clearSession,
  saveBooking,
  updateBooking,
  cancelBooking,
  getLastBooking,
  isBookingComplete,
  getMissingFields,
} from './bookingService.js';

const parseSystemBlock = (aiResponse) => {
  const systemMatch = aiResponse.match(/---SYSTEM---\n([\s\S]*?)\n---END---/);
  const reply = aiResponse.replace(/---SYSTEM---[\s\S]*?---END---/g, '').trim();
  let intent = 'NONE';
  const data = {};

  if (systemMatch) {
    const intentMatch = systemMatch[1].match(/INTENT:\s*(\w+)/);
    if (intentMatch) intent = intentMatch[1].trim();

    const dataMatch = systemMatch[1].match(/DATA:\s*(\{[\s\S]*?\})/);
    if (dataMatch) {
      try {
        const parsed = JSON.parse(dataMatch[1]);
        Object.keys(parsed).forEach((k) => {
          if (parsed[k] !== null && parsed[k] !== undefined && parsed[k].toString().trim()) {
            data[k] = parsed[k];
          }
        });
      } catch (e) {
        console.error('System block parse error:', e.message);
      }
    }
  }

  return { reply, intent, data };
};

export const generateReply = async ({ client, sessionId, message }) => {
  if (client.messages_used >= client.messages_limit) {
    return 'Service is temporarily unavailable.';
  }

  const businessType = client.business_type || 'general';

  const [conversations] = await pool.query(
    'SELECT id FROM conversations WHERE session_id = ? AND client_id = ?',
    [sessionId, client.id]
  );

  let conversationId;
  if (conversations.length === 0) {
    const [result] = await pool.query(
      'INSERT INTO conversations (client_id, session_id) VALUES (?, ?)',
      [client.id, sessionId]
    );
    conversationId = result.insertId;
  } else {
    conversationId = conversations[0].id;
  }

  const [history] = await pool.query(
    `SELECT role, content FROM messages
     WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 20`,
    [conversationId]
  );

  let sessionState = await getSessionState(sessionId, client.id);
  let lastBooking = null;
  if (sessionState.mode === 'rescheduling') {
    lastBooking = await getLastBooking(conversationId);
  }

  const missingFields =
    sessionState.mode === 'booking'
      ? getMissingFields(sessionState.collectedData || {}, businessType)
      : [];

  const aiResponse = await getAIReply({
    userMessage: message,
    systemPrompt: client.system_prompt,
    chatHistory: history,
    sessionMode: sessionState.mode,
    collectedData: sessionState.collectedData || {},
    lastBooking,
    businessName: client.business_name,
    businessType,
    clientPlan: client.plan,
    missingFields,
  });

  const parsed = parseSystemBlock(aiResponse);
  let finalReply = parsed.reply;

  if (sessionState.mode === 'normal') {
    if (parsed.intent === 'BOOKING') {
      sessionState = { mode: 'booking', bookingId: null, collectedData: parsed.data };
      await setSessionState(sessionId, client.id, sessionState);
    } else if (parsed.intent === 'RESCHEDULE') {
      const lb = await getLastBooking(conversationId);
      if (lb) {
        sessionState = { mode: 'rescheduling', bookingId: lb.id, collectedData: {} };
        await setSessionState(sessionId, client.id, sessionState);
        lastBooking = lb;
      }
    } else if (parsed.intent === 'CANCEL') {
      const lb = await getLastBooking(conversationId);
      if (lb) {
        sessionState = { mode: 'booking', bookingId: lb.id, collectedData: {} };
        await setSessionState(sessionId, client.id, sessionState);
      }
    }
  }

  if (sessionState.mode === 'booking') {
    if (aiResponse.includes('BOOKING_CANCELLED')) {
      const cancelled = await cancelBooking(conversationId);
      await clearSession(sessionId, client.id);
      finalReply = cancelled
        ? finalReply.replace('BOOKING_CANCELLED', '').trim()
        : 'No active booking found to cancel.';
    } else {
      const updatedData = { ...sessionState.collectedData, ...parsed.data };

      if (isBookingComplete(updatedData, businessType)) {
        await saveBooking(client.id, conversationId, updatedData);
        await clearSession(sessionId, client.id);
      } else {
        await setSessionState(sessionId, client.id, {
          ...sessionState,
          collectedData: updatedData,
        });
      }
    }
  }

  if (sessionState.mode === 'rescheduling' && aiResponse.includes('RESCHEDULE_COMPLETE')) {
    await updateBooking(sessionState.bookingId, {
      ...parsed.data,
      name: lastBooking?.customer_name,
    });
    await clearSession(sessionId, client.id);
    finalReply = finalReply.replace('RESCHEDULE_COMPLETE', '').trim();
  }

  await pool.query(
    'INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)',
    [conversationId, 'user', message]
  );
  await pool.query(
    'INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)',
    [conversationId, 'assistant', finalReply]
  );
  await pool.query(
    'UPDATE clients SET messages_used = messages_used + 1 WHERE id = ?',
    [client.id]
  );

  return finalReply;
};