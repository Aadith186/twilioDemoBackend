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

      // Load past conversations for memory
      const convIds = lead.conversations.slice(-3);
      const previousConversations = await Conversation.find({
        _id: { $in: convIds },
        status: 'ended'
      }).sort({ startedAt: -1 });
      session.previousConversations = previousConversations;

      // Personalized greeting
      if (lead.name && lead.name !== 'Unknown') {
        greeting = `Hey ${lead.name}! Good to hear from you again. Welcome back to Steel Building Depot. How can I help you today?`;
      } else {
        greeting = `Hey, welcome back to Steel Building Depot! Good to hear from you again. What can I help you with today?`;
      }
    } else {
      // New caller
      greeting = `Hey there! Thanks for calling Steel Building Depot. I'm Alex, I'll be helping you out today. Before we get into things... could I get your name?`;
    }

    // Store greeting in session
    session.messages.push({ role: 'assistant', content: greeting });

    // Notify admin panel
    if (req.app.get('io')) {
      req.app.get('io').to('admin').emit('new_lead_activity', {
        leadId: session.leadId,
        name: lead?.name || 'New Caller',
        isReturning,
        tier: lead?.tier || 'new',
        score: lead?.score || 0,
        channel: 'voice',
        phone: callerPhone,
        timestamp: new Date(),
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

    // Return TwiML with Claude's response
    buildTwiML(res, text, req);

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
// Twilio hits this when the call ends. We save everything to MongoDB.
router.post('/status', async (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  const callDuration = parseInt(req.body.CallDuration || '0');
  const callerPhone = req.body.From || 'unknown';

  console.log(`[Voice] Call ${callSid} status: ${callStatus}, duration: ${callDuration}s`);

  // Only process completed/failed calls
  if (!['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(callStatus)) {
    return res.json({ ok: true });
  }

  try {
    // Get session data
    const session = voiceClaude.deleteCallSession(callSid);

    if (!session || session.messages.length === 0) {
      console.log(`[Voice] No session data for ${callSid}, skipping save.`);
      return res.json({ ok: true });
    }

    // Find or create lead
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

    // Create conversation record
    const conversation = new Conversation({
      leadId: lead._id,
      sessionId: callSid,
      messages: session.messages.map(m => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp || new Date()
      })),
      quote: session.quote || undefined,
      status: 'ended',
      startedAt: session.startedAt,
      endedAt: new Date(),
      channel: 'voice',
      callDuration: callDuration,
    });
    await conversation.save();

    // Link to lead
    lead.conversations.push(conversation._id);
    lead.totalConversations = lead.conversations.length;
    lead.lastSeen = new Date();
    if (callerPhone !== 'unknown') lead.phone = callerPhone;
    await lead.save();

    // Score the lead if there were enough messages
    const userMessages = session.messages.filter(m => m.role === 'user');
    if (userMessages.length >= 2) {
      try {
        const previousConversations = await Conversation.find({
          _id: { $in: lead.conversations.filter(id => id.toString() !== conversation._id.toString()) },
          status: 'ended'
        }).sort({ startedAt: 1 });

        const scoreData = await claudeService.scoreLead(
          session.messages,
          lead.name,
          previousConversations
        );

        lead.score = scoreData.score;
        if (scoreData.scoreBreakdown) lead.scoreBreakdown = scoreData.scoreBreakdown;
        if (scoreData.requirements) lead.requirements = scoreData.requirements;
        if (scoreData.name && lead.name === 'Unknown') lead.name = scoreData.name;
        if (scoreData.email && !lead.email) lead.email = scoreData.email;
        if (scoreData.company && !lead.company) lead.company = scoreData.company;
        await lead.save();

        console.log(`[Voice] Lead scored: ${lead.name} = ${lead.score} (${lead.tier})`);

        // Notify admin panel
        if (req.app.get('io')) {
          req.app.get('io').to('admin').emit('lead_score_updated', {
            leadId: lead._id.toString(),
            name: lead.name,
            score: lead.score,
            tier: lead.tier,
            scoreBreakdown: lead.scoreBreakdown,
            requirements: lead.requirements,
            quote: session.quote,
            channel: 'voice',
          });
        }
      } catch (err) {
        console.error('[Voice] Scoring error:', err.message);
      }
    }

    console.log(`[Voice] Call saved. Lead: ${lead.name} (${lead._id}), Messages: ${session.messages.length}`);
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