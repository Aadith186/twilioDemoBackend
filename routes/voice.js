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

/*
 * Transcription quality (Twilio <Gather>):
 * - TWILIO_SPEECH_MODEL: default experimental_conversations. Try phone_call for phone-tuned STT; pair with TWILIO_GATHER_ENHANCED=true (Twilio docs).
 * - TWILIO_SPEECH_LANG: en-US often recognizes US English better than en-IN if your callers are mostly US.
 * - TWILIO_SPEECH_HINTS: comma-separated terms, e.g. "steel building,warehouse,square feet,estimate"
 * - For studio-grade STT: Twilio Media Streams + Deepgram/AssemblyAI (not implemented here).
 */
const SPEECH_MODEL = process.env.TWILIO_SPEECH_MODEL || 'experimental_conversations';
// NOTE: speechModel requires integer speechTimeout — 'auto' is NOT supported with experimental_conversations.
// Seconds to listen after Alex speaks before Twilio POSTs empty SpeechResult to /respond.
const SPEECH_TIMEOUT = process.env.TWILIO_SPEECH_TIMEOUT || '8';
// Each “dead air” retry: one Gather with this timeout (one POST per timeout, so one counter step).
const SILENCE_RETRY_TIMEOUT = process.env.TWILIO_SILENCE_RETRY_TIMEOUT || '12';
// Human-style nudges before hangup (default 3). The (max+1)th empty/low-confidence round ends the call.
const MAX_SILENCE_PROMPTS = Math.max(1, parseInt(process.env.TWILIO_MAX_SILENCE_PROMPTS || '3', 10));
// If > 0 and Twilio Confidence is below this, treat as mis-heard (garbage STT) and retry like silence.
const MIN_SPEECH_CONFIDENCE = parseFloat(process.env.TWILIO_MIN_SPEECH_CONFIDENCE || '0');

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Helper: build the base URL from the request
function getBaseUrl(req) {
  if (process.env.SERVER_PUBLIC_URL) {
    return process.env.SERVER_PUBLIC_URL.replace(/\/$/, '');
  }
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

function gatherSpeechAttrs(baseUrl, speechTimeout) {
  let attrs = `input="speech" action="${baseUrl}/api/voice/respond" method="POST" speechTimeout="${speechTimeout}" speechModel="${escapeXml(SPEECH_MODEL)}" language="${escapeXml(SPEECH_LANGUAGE)}" bargeIn="true"`;
  if (SPEECH_MODEL === 'phone_call' && String(process.env.TWILIO_GATHER_ENHANCED).toLowerCase() === 'true') {
    attrs += ' enhanced="true"';
  }
  const hintsRaw = process.env.TWILIO_SPEECH_HINTS;
  if (hintsRaw && String(hintsRaw).trim()) {
    const hintsNormalized = String(hintsRaw).replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    attrs += ` hints="${escapeXml(hintsNormalized)}"`;
  }
  return attrs;
}

/**
 * Dead air or unusable STT: up to MAX_SILENCE_PROMPTS human-style listens, then polite hangup.
 * With <Gather action=/respond>, timeout POSTs here again with empty SpeechResult — one increment per listen window.
 */
function sendSilenceRetryOrHangup(res, req, callSid, opts = {}) {
  const garbled = opts.garbled === true;
  const baseUrl = getBaseUrl(req);
  const voiceAttr = `voice="${VOICE}"`;
  const session = voiceClaude.getCallSession(callSid);
  session.silencePromptCount = (session.silencePromptCount || 0) + 1;
  const n = session.silencePromptCount;

  if (n > MAX_SILENCE_PROMPTS) {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say ${voiceAttr}>Alright, I'm going to let you go — if you still need us, call back anytime. Take care!</Say>
  <Hangup/>
</Response>`;
    res.type('text/xml');
    return res.send(twiml);
  }

  let inner;
  if (garbled) {
    inner = `<Say ${voiceAttr}>That broke up on my end — could you say that once more?</Say>`;
  } else if (n === 1) {
    inner = `<Pause length="1"/>`;
  } else if (n === 2) {
    inner = `<Say ${voiceAttr}>Hello — you still there?</Say>`;
  } else {
    inner = `<Say ${voiceAttr}>I'll give you a few more seconds. Go ahead whenever you're ready.</Say>`;
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather ${gatherSpeechAttrs(baseUrl, SILENCE_RETRY_TIMEOUT)}>
    ${inner}
  </Gather>
</Response>`;
  res.type('text/xml');
  return res.send(twiml);
}

// One <Gather> per TwiML: when action is set, Twilio POSTs to /respond on speech or timeout (verbs after Gather are skipped).
function buildTwiML(res, sayText, req, isSSML = true, _callSid = null) {
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
  <Gather ${gatherSpeechAttrs(baseUrl, SPEECH_TIMEOUT)}>
    <Say ${voiceAttr}>${sayContent}</Say>
  </Gather>
</Response>`;

  res.type('text/xml');
  res.send(twiml);
}

/** Twilio From vs stored Lead.phone often differ (+1… vs digits) — try variants so returning callers hit the same lead. */
function callerPhoneVariants(callerPhone) {
  if (!callerPhone || callerPhone === 'unknown') return [];
  const raw = String(callerPhone).trim();
  const variants = new Set([raw]);
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 10) {
    const last10 = digits.slice(-10);
    variants.add(last10);
    variants.add(`+1${last10}`);
    variants.add(`1${last10}`);
    variants.add(`+${digits}`);
  }
  return [...variants];
}

async function findLeadByCallerPhone(callerPhone) {
  const variants = callerPhoneVariants(callerPhone);
  if (variants.length === 0) return null;
  return Lead.findOne({ phone: { $in: variants } });
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

    void claudeService
      .refreshContextSummaryAfterTurn(conversation._id)
      .then(() => Conversation.findById(conversation._id).select('contextSummary').lean())
      .then((doc) => {
        const sess = voiceClaude.getCallSession(callSid);
        if (doc && sess) sess.rollingSummary = String(doc.contextSummary || '').trim();
      })
      .catch((e) => console.error('[Voice] contextSummary refresh:', e.message || e));

    let lead =
      (session.leadId && (await Lead.findById(session.leadId))) ||
      (session.callerPhone && session.callerPhone !== 'unknown'
        ? await findLeadByCallerPhone(session.callerPhone)
        : null);
    if (!lead) return;

    lead.lastSeen = new Date();
    if (session.callerPhone && session.callerPhone !== 'unknown') {
      lead.phone = session.callerPhone;
    }
    await lead.save();

    const userMessages = session.messages.filter((m) => m.role === 'user');
    if (userMessages.length < 1) return;

    const previousConversations = await claudeService.fetchAllPriorConversationsForLead(lead._id, {
      excludeConversationId: conversation._id,
    });

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
    let lead = await findLeadByCallerPhone(callerPhone);
    let isReturning = false;
    let greeting = '';
    let previousConversations = [];

    if (lead) {
      isReturning = true;
      lead.lastSeen = new Date();
      lead.isReturning = true;
      await lead.save();

      session.leadId = lead._id.toString();

      // Full saved history (chat + voice), including still-open web sessions — same as what the user actually discussed
      previousConversations = await claudeService.fetchAllPriorConversationsForLead(lead._id, {});
      session.previousConversations = previousConversations;

      // Returning caller greeting: phone-appropriate, uses full prior thread context (not "ended only").
      try {
        greeting = await claudeService.getGreeting(
          true,
          lead.name,
          previousConversations,
          { channel: 'voice' }
        );
      } catch (greetErr) {
        console.error('[Voice] Returning greeting generation error:', greetErr.message);
        if (lead.name && lead.name !== 'Unknown') {
          greeting = `Hi ${lead.name}, good to hear from you again — this is Alex at Steel Building Depot. What can I help you with today?`;
        } else {
          greeting = `Hi, welcome back to Steel Building Depot. I'm Alex — what can I help you with today?`;
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
      greeting = `Thanks for calling Steel Building Depot — I'm Alex. Before we get into your project, could I get your name?`;
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
    // Never inject this call's (still-empty) thread as "prior" context if lists are ever reloaded
    session.previousConversations = previousConversations.filter(
      (c) => c._id.toString() !== conversation._id.toString()
    );
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
    buildTwiML(res, greeting, req, true, callSid);

  } catch (err) {
    console.error('[Voice] Incoming call error:', err);
    const fallback = `Hey, thanks for calling Steel Building Depot. I'm Alex. What can I help you with today?`;
    buildTwiML(res, fallback, req, false, callSid);
  }
});

// ─── RESPOND TO SPEECH ────────────────────────────────────────────────────────
// Twilio hits this after customer finishes speaking
router.post('/respond', async (req, res) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult;
  const confidence = parseFloat(req.body.Confidence || '0');

  console.log(`[Voice] Speech from ${callSid}: "${speechResult}" (confidence: ${confidence})`);

  const hasText = speechResult && speechResult.trim() !== '';
  if (hasText && !Number.isNaN(MIN_SPEECH_CONFIDENCE) && MIN_SPEECH_CONFIDENCE > 0 && confidence < MIN_SPEECH_CONFIDENCE) {
    return sendSilenceRetryOrHangup(res, req, callSid, { garbled: true });
  }

  if (!hasText) {
    return sendSilenceRetryOrHangup(res, req, callSid, { garbled: false });
  }

  try {
    const session = voiceClaude.getCallSession(callSid);
    session.silencePromptCount = 0;

    // Get Claude's response
    const { text, quoteData } = await voiceClaude.voiceChat(callSid, speechResult.trim());

    console.log(`[Voice] Alex says: "${text.substring(0, 100)}..."`);

    // If quote was generated, log it
    if (quoteData) {
      console.log(`[Voice] Quote generated: $${quoteData.priceMin} - $${quoteData.priceMax}`);
    }

    // Return TwiML with Claude's response first — DB sync runs in background
    buildTwiML(res, text, req, true, callSid);
    void persistVoiceTurn(req, callSid).catch((e) =>
      console.error('[Voice] persistVoiceTurn failed:', e.message || e)
    );

  } catch (err) {
    console.error('[Voice] Respond error:', err);
    const fallback = `Sorry about that, I had a little hiccup on my end. Could you repeat what you just said?`;
    buildTwiML(res, fallback, req, false, callSid);
  }
});

// ─── LISTEN (fallback redirect) ───────────────────────────────────────────────
// When gather times out without speech, redirect back to listening
router.post('/listen', (req, res) => {
  const baseUrl = getBaseUrl(req);
  const voiceAttr = `voice="${VOICE}"`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather ${gatherSpeechAttrs(baseUrl, SILENCE_RETRY_TIMEOUT)}>
    <Say ${voiceAttr}>Whenever you're ready, go ahead.</Say>
  </Gather>
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
        const previousConversations = await claudeService.fetchAllPriorConversationsForLead(lead._id, {
          excludeConversationId: newConv._id,
        });

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