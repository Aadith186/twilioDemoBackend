const express = require('express');
const router = express.Router();
const { Lead, Conversation } = require('../models');
const claudeService = require('../services/claude');
const voiceClaude = require('../services/voice-claude');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
// Twilio voice options — change these to your preference
// Polly.Matthew = US Male Neural (clear, professional)
// Polly.Kajal = Indian English Female Neural
// Google.en-IN-Neural2-B = Indian English Male
// Google.en-IN-Neural2-A = Indian English Female
const VOICE = process.env.TWILIO_VOICE || 'Polly.Matthew';
const SPEECH_LANGUAGE = process.env.TWILIO_SPEECH_LANG || 'en-IN';
// NOTE: experimental_conversations model requires an integer — 'auto' is NOT supported with it.
// Set TWILIO_SPEECH_TIMEOUT in your .env to override (e.g. 1 or 2). Default is 1 second.
const SPEECH_TIMEOUT = process.env.TWILIO_SPEECH_TIMEOUT || '1';

// Helper: build the base URL from the request
function getBaseUrl(req) {
  // Use env var if set (for ngrok etc.), otherwise build from request
  if (process.env.SERVER_PUBLIC_URL) {
    return process.env.SERVER_PUBLIC_URL.replace(/\/$/, ''); // strip trailing slash
  }
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

// Helper: wrap text in TwiML Say + Gather loop
// bargeIn="true" = stops TTS immediately when caller starts speaking
// speechModel="experimental_conversations" = best for conversational AI
// speechTimeout must be an integer — "auto" is NOT supported with experimental_conversations
function buildTwiML(res, sayText, req, isSSML = true) {
  const baseUrl = getBaseUrl(req);
  const voiceAttr = `voice="${VOICE}"`;

  let sayContent;
  if (isSSML) {
    sayContent = voiceClaude.textToSSML(sayText, VOICE);
  } else {
    sayContent = escapeXml(sayText);
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${baseUrl}/api/voice/respond" method="POST" speechTimeout="${SPEECH_TIMEOUT}" speechModel="experimental_conversations" language="${SPEECH_LANGUAGE}" bargeIn="true">
    <Say ${voiceAttr}>${sayContent}</Say>
  </Gather>
  <Gather input="speech" action="${baseUrl}/api/voice/respond" method="POST" speechTimeout="4" speechModel="experimental_conversations" language="${SPEECH_LANGUAGE}">
    <Say ${voiceAttr}>I'm still here. Go ahead whenever you're ready.</Say>
  </Gather>
  <Say ${voiceAttr}>It seems like we lost each other. Feel free to call back anytime!</Say>
  <Hangup/>
</Response>`;

  res.type('text/xml');
  res.send(twiml);
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function mapSessionMessagesToSchema(session) {
  return session.messages.map((m) => ({
    role: m.role,
    content: m.content,
    timestamp: m.timestamp || new Date(),
  }));
}

/**
 * After each voice turn: sync transcript to Mongo, refresh lead score & summary (requirements).
 * Does not block the Twilio HTTP response — call with void persistVoiceTurn(...).catch(...).
 */
async function persistVoiceTurn(req, callSid) {
  const session = voiceClaude.getCallSession(callSid);
  if (!session || session.messages.length === 0) return;

  try {
    const conversation = await Conversation.findOne({ sessionId: callSid });
    if (!conversation) {
      console.warn(`[Voice] persistVoiceTurn: no Conversation for ${callSid}`);
      return;
    }

    conversation.messages = mapSessionMessagesToSchema(session);
    if (session.quote) conversation.quote = session.quote;
    await conversation.save();

    let lead =
      (session.leadId && (await Lead.findById(session.leadId))) ||
      (session.callerPhone && session.callerPhone !== 'unknown'
        ? await Lead.findOne({ phone: session.callerPhone })
        : null);
    if (!lead) return;

    lead.lastSeen = new Date();
    if (session.callerPhone && session.callerPhone !== 'unknown') {
      lead.phone = session.callerPhone;
    }
    await lead.save();

    const userMessages = session.messages.filter((m) => m.role === 'user');
    if (userMessages.length < 1) return;

    const previousConversations = await Conversation.find({
      _id: {
        $in: lead.conversations.filter((id) => id.toString() !== conversation._id.toString()),
      },
      status: 'ended',
    }).sort({ startedAt: 1 });

    const scoreData = await claudeService.scoreLead(
      session.messages,
      lead.name,
      previousConversations
    );

    claudeService.applyScoreDataToLead(lead, scoreData);
    await lead.save();

    const io = req.app.get('io');
    if (io) {
      io.to('admin').emit('lead_score_updated', {
        leadId: lead._id.toString(),
        name: lead.name,
        score: lead.score,
        tier: lead.tier,
        scoreBreakdown: lead.scoreBreakdown,
        requirements: lead.requirements,
        projectLifecycleStage: lead.projectLifecycleStage,
        projectLifecycleReason: lead.projectLifecycleReason,
        quote: session.quote,
        channel: 'voice',
      });
      io.to('admin').emit('voice_transcript_updated', {
        leadId: lead._id.toString(),
        conversationId: conversation._id.toString(),
        sessionId: callSid,
        messages: conversation.messages,
        channel: 'voice',
      });
    }
  } catch (err) {
    console.error('[Voice] persistVoiceTurn error:', err.message || err);
  }
}

// ─── INCOMING CALL ────────────────────────────────────────────────────────────
// Twilio hits this when someone calls your number
router.post('/incoming', async (req, res) => {
  const callSid = req.body.CallSid;
  const callerPhone = req.body.From || 'unknown';

  console.log(`[Voice] Incoming call: ${callSid} from ${callerPhone}`);

  try {
    // Initialize call session
    const session = voiceClaude.getCallSession(callSid);
    session.callerPhone = callerPhone;

    // Check if this phone number belongs to a returning lead
    let lead = await Lead.findOne({ phone: callerPhone });
    let isReturning = false;
    let greeting = '';

    if (lead) {
      isReturning = true;
      lead.lastSeen = new Date();
      lead.isReturning = true;
      await lead.save();

      session.leadId = lead._id.toString();

      // Full saved history (chat + voice), same breadth as web chat — feeds model message thread each turn
      const previousConversations = await Conversation.find({
        leadId: lead._id,
        status: 'ended',
      }).sort({ startedAt: 1 });
      session.previousConversations = previousConversations;

      // Returning caller greeting with previous-conversation summary (same style as chat).
      try {
        greeting = await claudeService.getGreeting(
          true,
          lead.name,
          previousConversations
        );
      } catch (greetErr) {
        console.error('[Voice] Returning greeting generation error:', greetErr.message);
        if (lead.name && lead.name !== 'Unknown') {
          greeting = `Hey ${lead.name}! Good to hear from you again. Welcome back to Steel Building Depot. How can I help you today?`;
        } else {
          greeting = `Hey, welcome back to Steel Building Depot! Good to hear from you again. What can I help you with today?`;
        }
      }
    } else {
      // New caller — create lead immediately so each turn can sync to DB
      lead = new Lead({
        phone: callerPhone !== 'unknown' ? callerPhone : undefined,
        lastSeen: new Date(),
        firstSeen: new Date(),
      });
      await lead.save();
      session.leadId = lead._id.toString();
      greeting = `Hey there! Thanks for calling Steel Building Depot. I'm Alex, I'll be helping you out today. Before we get into things... could I get your name?`;
    }

    // Store greeting in session
    session.messages.push({ role: 'assistant', content: greeting, timestamp: new Date() });

    // Active conversation for this call (transcript updated after each /respond)
    const conversation = new Conversation({
      leadId: lead._id,
      sessionId: callSid,
      messages: mapSessionMessagesToSchema(session),
      status: 'active',
      channel: 'voice',
      startedAt: session.startedAt,
    });
    await conversation.save();
    lead.conversations.push(conversation._id);
    lead.totalConversations = lead.conversations.length;
    lead.lastSeen = new Date();
    await lead.save();

    // Notify admin panel
    const io = req.app.get('io');
    if (io) {
      io.to('admin').emit('new_lead_activity', {
        leadId: lead._id.toString(),
        conversationId: conversation._id.toString(),
        name: lead.name || 'New Caller',
        isReturning,
        tier: lead.tier || 'new',
        score: lead.score || 0,
        channel: 'voice',
        phone: callerPhone,
        timestamp: new Date(),
      });
      io.to('admin').emit('voice_transcript_updated', {
        leadId: lead._id.toString(),
        conversationId: conversation._id.toString(),
        sessionId: callSid,
        messages: conversation.messages,
        channel: 'voice',
      });
    }

    // Return TwiML: say greeting, then listen
    buildTwiML(res, greeting, req);

  } catch (err) {
    console.error('[Voice] Incoming call error:', err);
    const fallback = `Hey, thanks for calling Steel Building Depot. I'm Alex. What can I help you with today?`;
    buildTwiML(res, fallback, req, false);
  }
});

// ─── RESPOND TO SPEECH ────────────────────────────────────────────────────────
// Twilio hits this after customer finishes speaking
router.post('/respond', async (req, res) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult;
  const confidence = parseFloat(req.body.Confidence || '0');

  console.log(`[Voice] Speech from ${callSid}: "${speechResult}" (confidence: ${confidence})`);

  if (!speechResult || speechResult.trim() === '') {
    const baseUrl = getBaseUrl(req);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${baseUrl}/api/voice/respond" method="POST" speechTimeout="${SPEECH_TIMEOUT}" speechModel="experimental_conversations" language="${SPEECH_LANGUAGE}" bargeIn="true">
    <Say voice="${VOICE}">Sorry, I didn't quite catch that. Could you repeat that for me?</Say>
  </Gather>
  <Gather input="speech" action="${baseUrl}/api/voice/respond" method="POST" speechTimeout="4" speechModel="experimental_conversations" language="${SPEECH_LANGUAGE}">
    <Say voice="${VOICE}">I'm still here if you'd like to chat.</Say>
  </Gather>
  <Hangup/>
</Response>`;
    res.type('text/xml');
    return res.send(twiml);
  }

  try {
    // Get Claude's response
    const { text, quoteData } = await voiceClaude.voiceChat(callSid, speechResult.trim());

    console.log(`[Voice] Alex says: "${text.substring(0, 100)}..."`);

    // If quote was generated, log it
    if (quoteData) {
      console.log(`[Voice] Quote generated: $${quoteData.priceMin} - $${quoteData.priceMax}`);
    }

    // Return TwiML with Claude's response first — DB sync runs in background
    buildTwiML(res, text, req);
    void persistVoiceTurn(req, callSid).catch((e) =>
      console.error('[Voice] persistVoiceTurn failed:', e.message || e)
    );

  } catch (err) {
    console.error('[Voice] Respond error:', err);
    const fallback = `Sorry about that, I had a little hiccup on my end. Could you repeat what you just said?`;
    buildTwiML(res, fallback, req, false);
  }
});

// ─── LISTEN (fallback redirect) ───────────────────────────────────────────────
// When gather times out without speech, redirect back to listening
router.post('/listen', (req, res) => {
  const baseUrl = getBaseUrl(req);
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${baseUrl}/api/voice/respond" method="POST" speechTimeout="${SPEECH_TIMEOUT}" speechModel="experimental_conversations" language="${SPEECH_LANGUAGE}">
    <Say voice="${VOICE}">I'm still here whenever you're ready.</Say>
  </Gather>
  <Say voice="${VOICE}">It seems like we got disconnected. Feel free to call back anytime. Bye!</Say>
  <Hangup/>
</Response>`;
  res.type('text/xml');
  res.send(twiml);
});

// ─── CALL STATUS CALLBACK ─────────────────────────────────────────────────────
// Twilio hits this when the call ends. Finalize the active Conversation (synced each /respond).
router.post('/status', async (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  const callDuration = parseInt(req.body.CallDuration || '0', 10);
  const callerPhone = req.body.From || 'unknown';

  console.log(`[Voice] Call ${callSid} status: ${callStatus}, duration: ${callDuration}s`);

  // Only process completed/failed calls
  if (!['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(callStatus)) {
    return res.json({ ok: true });
  }

  try {
    const session = voiceClaude.deleteCallSession(callSid);
    const conversation = await Conversation.findOne({ sessionId: callSid });

    if (conversation && session && session.messages.length > 0) {
      conversation.messages = mapSessionMessagesToSchema(session);
      if (session.quote) conversation.quote = session.quote;
      conversation.status = 'ended';
      conversation.endedAt = new Date();
      if (callDuration) conversation.callDuration = callDuration;
      await conversation.save();

      const lead = await Lead.findById(conversation.leadId);
      if (lead) {
        lead.lastSeen = new Date();
        if (callerPhone !== 'unknown') lead.phone = callerPhone;
        await lead.save();
      }

      const io = req.app.get('io');
      if (io) {
        io.to('admin').emit('voice_transcript_updated', {
          leadId: conversation.leadId.toString(),
          conversationId: conversation._id.toString(),
          sessionId: callSid,
          messages: conversation.messages,
          channel: 'voice',
        });
      }

      console.log(
        `[Voice] Call finalized. Lead: ${lead?.name || '?'} (${lead?._id}), Messages: ${session.messages.length}`
      );
      return res.json({ ok: true });
    }

    if (conversation && (!session || session.messages.length === 0)) {
      conversation.status = 'ended';
      conversation.endedAt = new Date();
      if (callDuration) conversation.callDuration = callDuration;
      await conversation.save();
      console.log(`[Voice] Call finalized (no session). Conversation ${conversation._id}`);
      return res.json({ ok: true });
    }

    if (!session || session.messages.length === 0) {
      console.log(`[Voice] No session for ${callSid}; nothing to merge.`);
      return res.json({ ok: true });
    }

    let lead;
    if (session.leadId) {
      lead = await Lead.findById(session.leadId);
    }
    if (!lead && callerPhone !== 'unknown') {
      lead = await Lead.findOne({ phone: callerPhone });
    }
    if (!lead) {
      lead = new Lead({
        phone: callerPhone,
        lastSeen: new Date(),
        firstSeen: new Date(),
      });
      await lead.save();
    }

    const newConv = new Conversation({
      leadId: lead._id,
      sessionId: callSid,
      messages: mapSessionMessagesToSchema(session),
      quote: session.quote || undefined,
      status: 'ended',
      startedAt: session.startedAt,
      endedAt: new Date(),
      channel: 'voice',
      callDuration: callDuration || undefined,
    });
    await newConv.save();
    lead.conversations.push(newConv._id);
    lead.totalConversations = lead.conversations.length;
    lead.lastSeen = new Date();
    if (callerPhone !== 'unknown') lead.phone = callerPhone;
    await lead.save();

    const userMessages = session.messages.filter((m) => m.role === 'user');
    if (userMessages.length >= 1) {
      try {
        const previousConversations = await Conversation.find({
          _id: {
            $in: lead.conversations.filter((id) => id.toString() !== newConv._id.toString()),
          },
          status: 'ended',
        }).sort({ startedAt: 1 });

        const scoreData = await claudeService.scoreLead(
          session.messages,
          lead.name,
          previousConversations
        );
        claudeService.applyScoreDataToLead(lead, scoreData);
        await lead.save();

        const io = req.app.get('io');
        if (io) {
          io.to('admin').emit('lead_score_updated', {
            leadId: lead._id.toString(),
            name: lead.name,
            score: lead.score,
            tier: lead.tier,
            scoreBreakdown: lead.scoreBreakdown,
            requirements: lead.requirements,
            projectLifecycleStage: lead.projectLifecycleStage,
            projectLifecycleReason: lead.projectLifecycleReason,
            quote: session.quote,
            channel: 'voice',
          });
        }
      } catch (err) {
        console.error('[Voice] Fallback scoring error:', err.message);
      }
    }

    console.log(
      `[Voice] Call saved (fallback). Lead: ${lead.name} (${lead._id}), Messages: ${session.messages.length}`
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[Voice] Status callback error:', err);
    res.json({ ok: true }); // Always 200 to Twilio
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'voice',
    activeCalls: voiceClaude.activeCalls.size,
    voice: VOICE,
    language: SPEECH_LANGUAGE,
    timestamp: new Date()
  });
});

module.exports = router;