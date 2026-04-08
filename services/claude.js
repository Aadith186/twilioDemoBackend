const Anthropic = require('@anthropic-ai/sdk');
const { PROJECT_LIFECYCLE_STAGES, Conversation } = require('../models');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── CONTEXT SIZE (token / rate-limit pressure) ─────────────────────────────
// Rough guide: ~4 chars ≈ 1 token for English. Prior = stitched older sessions; live = current thread.
// Set any limit to 0 or negative to disable trimming for that bucket (full history — may hit limits).
function parseCharLimit(raw, fallback) {
  const n = parseInt(String(raw != null && raw !== '' ? raw : fallback), 10);
  return Number.isNaN(n) ? fallback : n;
}

function resolveContextLimits(options = {}) {
  const defPrior = parseCharLimit(process.env.CLAUDE_MAX_PRIOR_CONTEXT_CHARS, 45000);
  const defLive = parseCharLimit(process.env.CLAUDE_MAX_LIVE_CONTEXT_CHARS, 28000);
  return {
    maxPriorChars: options.maxPriorChars !== undefined ? options.maxPriorChars : defPrior,
    maxLiveChars: options.maxLiveChars !== undefined ? options.maxLiveChars : defLive,
  };
}

function resolveSummaryMaxChars() {
  return parseCharLimit(process.env.CLAUDE_CONTEXT_SUMMARY_MAX_CHARS, 2200);
}

function resolveLiveVerbatimMessageCount(options = {}) {
  if (options.useLiveHybrid === false) return 0;
  if (options.liveVerbatimMessageCount != null) {
    const n = parseInt(String(options.liveVerbatimMessageCount), 10);
    return Number.isNaN(n) ? 12 : n;
  }
  return parseCharLimit(process.env.CLAUDE_LIVE_VERBATIM_TURNS, 12);
}

function capSummaryText(text, maxChars) {
  const s = String(text || '').trim();
  if (!s || maxChars <= 0) return s;
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars - 20)}\n…(trimmed)…`;
}

/**
 * Merge the latest user+assistant exchange into a dense rolling summary for model context.
 * On any failure returns previousSummary unchanged.
 */
async function mergeConversationContextSummary({
  previousSummary = '',
  newUserContent = '',
  newAssistantContent = '',
  channel = 'chat',
  userMessageOnly = false,
} = {}) {
  const maxOut = resolveSummaryMaxChars();
  const prev = String(previousSummary || '').trim();
  const u = String(newUserContent || '').trim();
  const a = String(newAssistantContent || '').trim();
  if (!u && !a) return prev;

  const channelNote =
    channel === 'voice'
      ? 'This exchange was on a phone call — keep spoken tone out of the summary; store facts only.'
      : 'Web chat exchange.';

  const userPayload =
    userMessageOnly && u
      ? `PREVIOUS SUMMARY (keep all facts unless corrected):\n${prev || '(none)'}\n\nThe customer’s last message on a phone call (no assistant reply was recorded after it):\n${u}\n\nFold any new facts from that message into the summary. Do not mention missing replies or the call ending. Reply with the updated summary only.`
      : `PREVIOUS SUMMARY (keep all facts unless corrected):\n${prev || '(none)'}\n\nNEW — Customer:\n${u}\n\nNEW — Alex:\n${a}\n\nReply with the updated summary only.`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 768,
      system: `You maintain a compact MEMORY SUMMARY for a steel-building sales CRM. Output plain text only — short labeled lines or bullets. No markdown headings. Preserve EVERY concrete fact from the previous summary (names, numbers, sqft, locations, quotes, materials, timeline). Merge in the new exchange; do not drop prior facts unless the customer explicitly corrected them (then update). ${channelNote} Max length: about ${Math.floor(maxOut / 5)} words. Be dense.`,
      messages: [
        {
          role: 'user',
          content: userPayload,
        },
      ],
    });
    const out = (response.content[0] && response.content[0].text) ? String(response.content[0].text).trim() : '';
    if (!out) return prev;
    return capSummaryText(out, maxOut);
  } catch (e) {
    console.error('[Claude] mergeConversationContextSummary:', e.message || e);
    return prev;
  }
}

/**
 * Reload conversation from DB and extend contextSummary from the last user+assistant pair.
 * Safe to fire-and-forget.
 */
async function refreshContextSummaryAfterTurn(conversationId) {
  if (!conversationId) return;
  try {
    const conv = await Conversation.findById(conversationId).lean();
    if (!conv || !conv.messages || conv.messages.length < 2) return;
    const msgs = conv.messages;
    const last = msgs[msgs.length - 1];
    const prev = msgs[msgs.length - 2];
    if (last.role !== 'assistant' || prev.role !== 'user') return;
    const merged = await mergeConversationContextSummary({
      previousSummary: conv.contextSummary || '',
      newUserContent: String(prev.content || ''),
      newAssistantContent: String(last.content || ''),
      channel: conv.channel === 'voice' ? 'voice' : 'chat',
    });
    await Conversation.findByIdAndUpdate(conversationId, {
      contextSummary: merged,
      contextSummaryUpdatedAt: new Date(),
    });
  } catch (e) {
    console.error('[Claude] refreshContextSummaryAfterTurn:', e.message || e);
  }
}

/** Keep the newest messages whose total content fits in maxChars; drop oldest first. */
function keepRecentMessagesWithinBudget(messages, maxChars) {
  if (!messages || messages.length === 0) return [];
  if (maxChars <= 0) return messages;

  const kept = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const c = String(m.content || '');
    if (c.length > maxChars && kept.length === 0) {
      return [{ role: m.role, content: `…(truncated)…\n${c.slice(-(maxChars - 16))}` }];
    }
    if (total + c.length > maxChars) break;
    kept.push({ role: m.role, content: c });
    total += c.length;
  }
  kept.reverse();
  if (kept.length > 0 && kept.length < messages.length) {
    const first = kept[0];
    kept[0] = {
      role: first.role,
      content: '[Older messages omitted — most recent history follows.]\n\n' + first.content,
    };
  }
  return kept;
}

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
const SALES_SYSTEM_PROMPT = `You are Alex, a sales executive at Steel Building Depot. You help customers get ballpark estimates for construction and installation projects.

REGISTER (critical — sound human, not like a friend and not like a bot):
- You are a competent sales professional talking to a customer or prospect: respectful, clear, and pleasant — never buddy-buddy, never cold or stiff
- NOT too casual: do not sound like texting a friend. Avoid "What's up", "Hey [Name]!" as a whole opener, "sup", "yo", "dude", "man", "no worries", "cool cool", or slangy check-ins
- NOT too formal: avoid "Dear Sir/Madam", "I would be delighted to", "per your inquiry", "kindly advise", "at your earliest convenience" — that's corporate-AI or legal tone
- Sweet spot: calm, direct, business-appropriate warmth — like a good account exec on a Zoom who knows their product: real reactions, plain words, no brochure-speak. Example tone: "Hi Akshay — thanks for reaching out. To point you in the right direction, what kind of build are you looking at?"
- Greetings: prefer "Hi [Name]," or "Good morning [Name]," over "Hey!" Open with purpose (why you're chatting / next step), not small talk
- Short, natural sentences. Skip filler ("I'm here to help", "Feel free to ask", "Let me know if you need anything else", "I'm still here")
- Never repeat the same acknowledgment or opener across messages. Vary: Okay / Right / Makes sense / Sounds good / I follow / Thanks for that / Got it (don't lean on one word every time)
- Do not restate your job title every reply — introduce yourself once if needed, then focus on their project
- React to substance: reference what they said; skip empty praise ("Great question!", "Love that!") unless it genuinely fits
- One question at a time unless they gave multiple answers — then acknowledge briefly and ask the next single thing
- Use their name sparingly (every few messages), not every line
- Contractions are fine (we're, that's, I've). Plain English beats jargon
- No emojis unless the customer used one first — and even then use at most one, rarely
- If they're vague, ask one sharp clarifying question instead of "happy to help" loops

PHRASES AND PATTERNS TO AVOID (AI + wrong register):
- "I'm here" / "I'm still here" / "I'm here whenever you're ready"
- "What's up" / "What's up?" / "How's it going?" as a sales open — too casual for this role
- "How can I assist you?" / "What can I help you with today?" after you've already started — ask the next concrete question instead
- Stacking hedges ("I think maybe we could potentially…") — one clear thought
- Same opener three times in a row (always "Absolutely," or always "Great!")
- Over-thanking ("Thank you so much for sharing that!") — brief thanks or none
- Announcing you're about to ask — just ask

YOUR GOAL:
Guide the customer through a natural conversation to gather enough information to generate a price range estimate. You need to collect:
1. Their name (first thing — greet them and ask)
2. Project type (new build, renovation, addition, etc.)
3. Building type (warehouse, office, retail, residential, etc.)
4. Approximate square footage
5. Roof type (metal, flat/TPO, pitched, etc.)
6. Wall type (metal panels, brick, concrete, drywall, etc.)
7. Insulation requirements (if any)
8. Number and type of doors
9. Location/region (for pricing adjustments)
10. Timeline (when they want to start)
11. Any special requirements or features

CONVERSATION FLOW:
- Start: Brief professional greeting, then ask for their name (or next step if name known)
- After name: Move straight into what they're planning — no chit-chat
- Continue gathering details naturally through conversation
- Once you have enough info (at minimum: project type, building type, sqft, location), you can offer to generate a quote
- Always confirm before generating the quote: "I have enough to give you a price range — shall I?"

QUOTE GENERATION:
When you have enough information, include a quote block in your response using EXACTLY this format (on its own line):
QUOTE_DATA:{"priceMin":NUMBER,"priceMax":NUMBER,"complexity":NUMBER,"basis":"BRIEF_REASON","details":{"sqft":"VALUE","roofType":"VALUE","wallPanels":"VALUE","insulation":"VALUE","doors":"VALUE","region":"VALUE","specialRequirements":"VALUE"}}

Pricing guidelines (rough per sqft installed):
- Simple metal building, basic finishes: $8–$12/sqft
- Standard commercial (office/retail): $15–$25/sqft  
- Complex build (special materials, high insulation): $25–$40/sqft
- Premium/specialised: $40–$60/sqft

Complexity scale 1–5:
1 = Simple shed/basic structure
2 = Standard warehouse/storage
3 = Commercial office/retail
4 = Complex multi-use or heavy insulation/special requirements
5 = Premium/highly specialised

Regional multipliers (mention this affects pricing):
- Southeast/South: base
- Midwest: +5%
- Northeast/New England: +12%
- West Coast: +18%
- Mountain/Northwest: +8%

MEMORY INSTRUCTIONS:
If you are given previous conversation history for a returning customer, reference it naturally. If they ask "do you remember our last chat?" or similar, summarise what you discussed, what quote was given, and any details they shared. Be specific — mention the project type, sqft, price range you gave, and anything personal they shared.

IMPORTANT RULES:
- Never make up details the customer hasn't provided
- If you don't have enough info for a quote, keep asking questions
- Always be transparent that these are estimates and final pricing requires a site visit
- If they seem ready to move forward, offer to have a senior estimator call them
- Read the last few messages you sent: do not echo the same opening or sign-off pattern — vary like a human would across a real back-and-forth`;

// ─── RETURNING USER MEMORY PROMPT ────────────────────────────────────────────
function buildMemoryContext(previousConversations, meta = {}) {
  if (!previousConversations || previousConversations.length === 0) return '';

  const quoteHints = previousConversations
    .map((conv, idx) => {
      if (!conv.quote || conv.quote.priceMin == null) return null;
      return `Session ${idx + 1}: $${conv.quote.priceMin.toLocaleString()} – $${conv.quote.priceMax.toLocaleString()}`;
    })
    .filter(Boolean);

  const usedSummaries = meta.usedPriorSummaries === true;

  let memory = '\n\n--- RETURNING CUSTOMER ---\n';
  memory += usedSummaries
    ? `This lead has ${previousConversations.length} earlier session(s) below as compact summaries (oldest first), plus the newest session in full recent turns.\n`
    : `This lead has ${previousConversations.length} earlier conversation(s) in the message thread below (oldest first), each labeled — user + Alex lines (may be trimmed for length).\n`;
  if (quoteHints.length) memory += `Saved quotes from prior sessions: ${quoteHints.join('; ')}.\n`;
  if (meta.priorTrimmed || meta.liveTrimmed) {
    memory +=
      'Some content may be omitted for size — use summaries and quote hints; if something material is missing, ask one short clarifying question.\n';
  }
  memory += 'Reference prior projects and numbers naturally; do not re-ask for details clearly already captured.\n';
  return memory;
}

/**
 * Load every Conversation row for this lead with full embedded messages (not just lead.conversations[]).
 * Excludes the active thread by conversation _id or Twilio CallSid (web sessionId).
 */
async function fetchAllPriorConversationsForLead(leadId, { excludeConversationId, excludeSessionId } = {}) {
  if (leadId == null || leadId === '') return [];
  let excludeId = excludeConversationId;
  if (excludeSessionId != null && String(excludeSessionId).trim() !== '' && excludeId == null) {
    const cur = await Conversation.findOne({ sessionId: String(excludeSessionId) }).select('_id').lean();
    if (cur && cur._id) excludeId = cur._id;
  }
  const filter = { leadId };
  if (excludeId != null) filter._id = { $ne: excludeId };
  return Conversation.find(filter).sort({ startedAt: 1 }).lean();
}

/** Active thread summary for hybrid live context (voice CallSid or web sessionId). */
async function getContextSummaryForSession(sessionId) {
  if (sessionId == null || String(sessionId).trim() === '') return '';
  const c = await Conversation.findOne({ sessionId: String(sessionId) }).select('contextSummary').lean();
  return c && c.contextSummary ? String(c.contextSummary).trim() : '';
}

const VOICE_UI_FALLBACK_MAX_CHARS = 2000;
const VOICE_UI_FALLBACK_MAX_TURNS = 12;

function formatVoiceCallWhenForUi(conv) {
  const d = conv.endedAt || conv.startedAt;
  if (!d) return 'recent call';
  try {
    return new Date(d).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return String(d);
  }
}

function voiceConversationFallbackExcerpt(conv) {
  const msgs = (conv.messages || []).filter(
    (m) => m && (m.role === 'user' || m.role === 'assistant') && m.content
  );
  if (msgs.length === 0) return 'Brief phone call — no transcript details saved.';
  const lines = [];
  let len = 0;
  for (let i = 0; i < Math.min(msgs.length, VOICE_UI_FALLBACK_MAX_TURNS); i++) {
    const m = msgs[i];
    const label = m.role === 'user' ? 'You' : 'Alex';
    const line = `${label}: ${String(m.content).trim()}`;
    if (len + line.length > VOICE_UI_FALLBACK_MAX_CHARS) break;
    lines.push(line);
    len += line.length + 1;
  }
  let body = lines.join('\n');
  if (body.length > VOICE_UI_FALLBACK_MAX_CHARS) {
    body = `${body.slice(0, VOICE_UI_FALLBACK_MAX_CHARS - 1)}…`;
  }
  return body;
}

/**
 * Map prior Conversation docs to rows for chat UI. Voice threads become one recap bubble each
 * (contextSummary + transcript fallback); chat threads stay one row per message.
 */
/** Plain summary text for model context after a call (no markdown UI). */
function voiceConversationToHandoffSummaryText(conv) {
  if (!conv || conv.channel !== 'voice') return '';
  const summary = (conv.contextSummary || '').trim();
  if (summary) return summary;
  return voiceConversationFallbackExcerpt(conv);
}

/** One UI row for a ended voice thread (same shape as priorConversationsToUiHistoryMessages voice branch). */
function voiceConversationToUiRecapRow(conv) {
  if (!conv || conv.channel !== 'voice') return null;
  const when = formatVoiceCallWhenForUi(conv);
  const summary = (conv.contextSummary || '').trim();
  const body = summary
    ? `**Phone call** (${when})\n\nHere's what we covered:\n\n${summary}`
    : `**Phone call** (${when})\n\n${voiceConversationFallbackExcerpt(conv)}`;
  const ts = conv.endedAt || conv.startedAt || new Date();
  return {
    role: 'assistant',
    content: body,
    timestamp: ts,
    quote: null,
    source: 'voice_call_summary',
  };
}

function priorConversationsToUiHistoryMessages(conversations) {
  const sorted = [...(conversations || [])].sort(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
  );
  return sorted.flatMap((conv) => {
    if (conv.channel === 'voice') {
      const row = voiceConversationToUiRecapRow(conv);
      return row ? [row] : [];
    }
    return (conv.messages || []).map((m) => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp || conv.startedAt,
      quote: m.quote || null,
    }));
  });
}

/**
 * If the call ended right after the customer spoke (no assistant reply yet), fold that line into contextSummary.
 */
async function finalizeVoiceContextSummaryOnHangup(conversationId) {
  if (!conversationId) return;
  try {
    const conv = await Conversation.findById(conversationId).lean();
    if (!conv || !conv.messages || conv.messages.length === 0) return;
    const last = conv.messages[conv.messages.length - 1];
    if (last.role !== 'user') return;
    const merged = await mergeConversationContextSummary({
      previousSummary: conv.contextSummary || '',
      newUserContent: String(last.content || ''),
      newAssistantContent: '',
      channel: 'voice',
      userMessageOnly: true,
    });
    await Conversation.findByIdAndUpdate(conversationId, {
      contextSummary: merged,
      contextSummaryUpdatedAt: new Date(),
    });
  } catch (e) {
    console.error('[Claude] finalizeVoiceContextSummaryOnHangup:', e.message || e);
  }
}

/**
 * Anthropic expects alternating user/assistant turns; stitched DB history can start with assistant (greeting)
 * or have consecutive same-role lines. Merge consecutive same role so the API always gets valid alternation.
 */
function ensureAnthropicMessageAlternation(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m || !m.content || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const msg = { role: m.role, content: String(m.content).trim() };
    if (!msg.content) continue;
    if (out.length === 0) {
      if (msg.role === 'assistant') {
        out.push({ role: 'user', content: '(Customer joined after your earlier welcome in a prior session.)' });
      }
      out.push(msg);
      continue;
    }
    const last = out[out.length - 1];
    if (last.role === msg.role) {
      last.content = `${last.content}\n\n${msg.content}`;
    } else {
      out.push(msg);
    }
  }
  return out;
}

function buildFullConversationMessages(currentMessages, previousConversations = [], options = {}) {
  const labelPriorSessions = options.labelPriorSessions === true;
  const usePriorSummaries = options.usePriorSummaries !== false;
  const currentConversationSummary = String(options.currentConversationSummary || '').trim();
  const verbatimCount = resolveLiveVerbatimMessageCount(options);
  const { maxPriorChars, maxLiveChars } = resolveContextLimits(options);

  const sorted = [...(previousConversations || [])].sort(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
  );

  let usedPriorSummaries = false;
  const historicalMessages = sorted.flatMap((conv) => {
    const summary = (conv.contextSummary || '').trim();
    if (usePriorSummaries && summary) {
      usedPriorSummaries = true;
      const ch = conv.channel === 'voice' ? 'phone call' : 'web chat';
      const when = conv.startedAt
        ? new Date(conv.startedAt).toISOString().slice(0, 19).replace('T', ' ')
        : 'unknown date';
      const label = labelPriorSessions
        ? `--- Prior ${ch} (${when}) — condensed summary ---\n${summary}`
        : `Prior ${ch} (${when}): ${summary}`;
      return [{ role: 'user', content: label }];
    }

    const rows = (conv.messages || [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
      .map((m, idx) => {
        let content = String(m.content);
        if (labelPriorSessions && idx === 0) {
          const ch = conv.channel === 'voice' ? 'phone call' : 'web chat';
          const when = conv.startedAt
            ? new Date(conv.startedAt).toISOString().slice(0, 19).replace('T', ' ')
            : 'unknown date';
          content = `--- Prior ${ch} (${when}) — transcript below ---\n${content}`;
        }
        return { role: m.role, content };
      });
    return rows;
  });

  let liveMessages = (currentMessages || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .map((m) => ({ role: m.role, content: String(m.content) }));

  const fullLiveLen = liveMessages.length;
  let liveSummaryPrefix = [];
  if (verbatimCount > 0 && liveMessages.length > verbatimCount) {
    if (currentConversationSummary) {
      liveSummaryPrefix = [
        {
          role: 'user',
          content: `[THIS SESSION — earlier turns (summary)]\n${currentConversationSummary}`,
        },
      ];
      liveMessages = liveMessages.slice(-verbatimCount);
    } else {
      liveMessages = liveMessages.slice(-verbatimCount);
    }
  }

  const combinedLive = [...liveSummaryPrefix, ...liveMessages];

  let trimmedHistorical =
    maxPriorChars <= 0 ? historicalMessages : keepRecentMessagesWithinBudget(historicalMessages, maxPriorChars);
  let priorTrimmed = maxPriorChars > 0 && trimmedHistorical.length < historicalMessages.length;

  if (maxPriorChars > 0 && historicalMessages.length > 0 && trimmedHistorical.length === 0) {
    trimmedHistorical = [
      {
        role: 'user',
        content:
          '[Earlier sessions exist but were omitted for context size — use quote hints in system if any; ask the customer to recap key details if needed.]',
      },
    ];
    priorTrimmed = true;
  }

  const trimmedLive =
    maxLiveChars <= 0 ? combinedLive : keepRecentMessagesWithinBudget(combinedLive, maxLiveChars);
  const liveTrimmed =
    maxLiveChars > 0 &&
    (trimmedLive.length < combinedLive.length ||
      (verbatimCount > 0 && fullLiveLen > verbatimCount));

  const messages = ensureAnthropicMessageAlternation([...trimmedHistorical, ...trimmedLive]);

  return { messages, priorTrimmed, liveTrimmed, usedPriorSummaries };
}

function buildRecentVoiceHandoffSystemBlock(handoff) {
  if (!handoff || !handoff.summaries || !handoff.summaries.length) return '';
  const nameLine =
    handoff.customerName && String(handoff.customerName).trim() && handoff.customerName !== 'Unknown'
      ? `You already know their name: ${handoff.customerName.trim()}. Use it naturally; do not ask "what's your name?" again.\n`
      : '';
  const parts = handoff.summaries
    .map((s, i) => `--- Phone call ${handoff.summaries.length > 1 ? i + 1 + ' ' : ''}(internal notes) ---\n${String(s).trim()}`)
    .join('\n\n');
  return (
    `\n\n--- RETURNING FROM A RECENT PHONE CALL ---\n` +
    `The customer may have just come back to this web chat right after speaking with you on the phone. ` +
    `Their message might be short (e.g. hi, hello, hey).\n` +
    nameLine +
    `What you covered on the call (for your memory only — do not paste this as a bullet report to the customer):\n${parts}\n\n` +
    `How to reply:\n` +
    `- Sound like you remember the call: 2–4 short sentences in plain prose — what you discussed, where things left off, and one clear next step or question.\n` +
    `- Do NOT output a formatted recap card, markdown headings, or "CUSTOMER PROJECT DETAILS" style blocks unless they explicitly ask for a written summary.\n` +
    `- Do NOT open like a first-time web visitor (no "thanks for visiting" + asking for their name if you already have it from the call or prior chat).\n` +
    `- Then continue the sale naturally from where the call ended.\n` +
    `---\n`
  );
}

// ─── MAIN CHAT FUNCTION ───────────────────────────────────────────────────────
async function chat(messages, previousConversations = [], options = {}) {
  const currentConversationSummary = options.currentConversationSummary ?? '';
  const built = buildFullConversationMessages(messages, previousConversations, {
    labelPriorSessions: true,
    currentConversationSummary,
  });
  const memoryContext = buildMemoryContext(previousConversations, {
    priorTrimmed: built.priorTrimmed,
    liveTrimmed: built.liveTrimmed,
    usedPriorSummaries: built.usedPriorSummaries,
  });
  const voiceHandoffBlock = buildRecentVoiceHandoffSystemBlock(options.recentVoiceHandoff);
  const systemWithMemory = SALES_SYSTEM_PROMPT + memoryContext + voiceHandoffBlock;
  const fullContextMessages = built.messages;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: systemWithMemory,
    messages: fullContextMessages
  });

  const fullText = response.content[0].text;

  // Extract quote data if present (brace-matching for nested JSON)
  let quoteData = null;
  let cleanText = fullText;

  const quoteMarker = 'QUOTE_DATA:';
  const startIdx = fullText.indexOf(quoteMarker);
  if (startIdx !== -1) {
    const jsonStart = startIdx + quoteMarker.length;
    if (fullText[jsonStart] === '{') {
      let depth = 0;
      let endIdx = jsonStart;
      for (let i = jsonStart; i < fullText.length; i++) {
        if (fullText[i] === '{') depth++;
        else if (fullText[i] === '}') {
          depth--;
          if (depth === 0) {
            endIdx = i + 1;
            break;
          }
        }
      }
      const jsonStr = fullText.substring(jsonStart, endIdx);
      try {
        quoteData = JSON.parse(jsonStr);
        cleanText = (fullText.substring(0, startIdx) + fullText.substring(endIdx)).replace(/\n{2,}/g, '\n\n').trim();
      } catch (e) {
        console.error('Failed to parse quote data:', e);
      }
    }
  }

  return { text: cleanText, quoteData };
}

function normalizeProjectLifecycleStage(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  const t = raw.trim().toLowerCase();
  for (const s of PROJECT_LIFECYCLE_STAGES) {
    if (s.toLowerCase() === t) return s;
  }
  return null;
}

/**
 * Apply scoreLead JSON to a Lead document (score, requirements, lifecycle, extracted fields).
 * Lifecycle stage is only overwritten when the model returns a valid canonical stage.
 */
function applyScoreDataToLead(lead, scoreData) {
  if (!scoreData || typeof scoreData !== 'object') return;
  if (typeof scoreData.score === 'number') lead.score = scoreData.score;
  if (scoreData.scoreBreakdown) lead.scoreBreakdown = scoreData.scoreBreakdown;
  if (scoreData.requirements) lead.requirements = scoreData.requirements;
  if (scoreData.name && lead.name === 'Unknown') lead.name = scoreData.name;
  if (scoreData.email && !lead.email) lead.email = scoreData.email;
  if (scoreData.phone && !lead.phone) lead.phone = scoreData.phone;
  if (scoreData.company && !lead.company) lead.company = scoreData.company;
  const stage = normalizeProjectLifecycleStage(scoreData.projectLifecycleStage);
  if (stage) {
    lead.projectLifecycleStage = stage;
    if (typeof scoreData.projectLifecycleReason === 'string' && scoreData.projectLifecycleReason.trim()) {
      lead.projectLifecycleReason = scoreData.projectLifecycleReason.trim();
    }
    lead.projectLifecycleUpdatedAt = new Date();
  }
}

// ─── LEAD SCORING FUNCTION ────────────────────────────────────────────────────
async function scoreLead(conversationMessages, leadName, previousConversations = []) {
  const scorePriorCap = parseCharLimit(process.env.CLAUDE_MAX_SCORE_PRIOR_CHARS, 22000);
  const scoreLiveCap = parseCharLimit(process.env.CLAUDE_MAX_SCORE_LIVE_CHARS, 18000);
  const { messages: fullConversationMessages } = buildFullConversationMessages(
    conversationMessages,
    previousConversations,
    {
      labelPriorSessions: false,
      maxPriorChars: scorePriorCap,
      maxLiveChars: scoreLiveCap,
      useLiveHybrid: false,
    }
  );

  const transcript = fullConversationMessages
    .map(m => `${m.role === 'user' ? (leadName || 'Customer') : 'Alex'}: ${m.content}`)
    .join('\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 512,
    system: `You are a B2B construction lead scoring engine. Analyse conversations and return ONLY valid JSON — no markdown, no explanation, just the JSON object.`,
    messages: [{
      role: 'user',
      content: `Score this construction sales conversation. The transcript may span multiple chat sessions (returning customers) — consider the FULL history across all conversations when scoring. Return ONLY this JSON structure:
{
  "score": <0-100 integer>,
  "scoreBreakdown": {
    "projectSize": { "points": <0-25>, "reason": "<brief reason>" },
    "budgetSignals": { "points": <0-25>, "reason": "<brief reason>" },
    "timeline": { "points": <0-20>, "reason": "<brief reason>" },
    "decisionMaker": { "points": <0-15>, "reason": "<brief reason>" },
    "projectClarity": { "points": <0-15>, "reason": "<brief reason>" }
  },
  "requirements": "<one sentence summary of their project>",
  "projectLifecycleStage": "<EXACTLY one of: ${PROJECT_LIFECYCLE_STAGES.join(' | ')} | null — choose the MOST ADVANCED stage clearly evidenced in the transcript; use null only if unclear>",
  "projectLifecycleReason": "<one short phrase citing evidence; empty string if projectLifecycleStage is null>",
  "name": "<customer name if mentioned, else null>",
  "email": "<email if mentioned, else null>",
  "phone": "<phone if mentioned, else null>",
  "company": "<company if mentioned, else null>"
}

Lifecycle guide (steel building sales): map explicitly when supported — Initial Contact = first touch only; Requirements Gathered = scope/sqft/location/details discussed; Proposal Sent = quote or formal proposal shared; Negotiation = revising price/terms; Deal Closed = verbal/written commitment to proceed; Payment Done = payment or deposit confirmed; Delivered = project handoff/delivery discussed or completed.

Scoring guide:
- projectSize (0-25): Large commercial/industrial=25, medium commercial=15, small/residential=8, unclear=0
- budgetSignals (0-25): Has budget approved=25, mentioned budget range=15, asking for estimate=8, price shopping=3
- timeline (0-20): Starting within 1 month=20, 1-3 months=15, 3-6 months=10, just exploring=3
- decisionMaker (0-15): Confirmed decision maker=15, influencer=8, unclear=3
- projectClarity (0-15): All details provided=15, most details=10, some details=5, vague=0

FULL TRANSCRIPT (all chat sessions, chronological):
${transcript}`
    }]
  });

  try {
    const raw = response.content[0].text.trim();
    const clean = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('Score parse error:', e);
    return {
      score: 10,
      scoreBreakdown: {},
      requirements: 'Unable to parse',
      projectLifecycleStage: null,
      projectLifecycleReason: '',
      name: null,
      email: null,
      phone: null,
      company: null,
    };
  }
}

// ─── GREETING MESSAGE ─────────────────────────────────────────────────────────
async function getGreeting(isReturning, leadName, previousConversations = [], options = {}) {
  const forVoice = options.channel === 'voice';

  if (isReturning && (leadName || previousConversations?.length > 0)) {
    let contextPrompt = forVoice
      ? `[SYSTEM: You are Alex on a LIVE PHONE CALL at Steel Building Depot. Generate a short spoken welcome-back — sounds like a real person on the phone, not a chatbot or email.`
      : `[SYSTEM: Generate a brief welcome-back message for a returning customer — tone: professional sales executive (warm, not casual: no "what's up" or buddy slang)`;
    if (leadName && leadName !== 'Unknown') contextPrompt += ` The customer's name is ${leadName}.`;
    contextPrompt += ` `;

    if (previousConversations && previousConversations.length > 0) {
      const cap = forVoice ? 1200 : 400;
      const summary = previousConversations.map((c, i) => {
        const stored = (c.contextSummary || '').trim();
        if (stored) {
          const quote = c.quote?.priceMin
            ? ` (Quote: $${c.quote.priceMin.toLocaleString()}-$${c.quote.priceMax.toLocaleString()})`
            : '';
          return `Session ${i + 1}: ${stored.substring(0, cap)}${quote}`;
        }
        const lines = (c.messages || [])
          .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
          .map((m) => `${m.role === 'user' ? 'Customer' : 'Alex'}: ${m.content}`);
        const body = lines.join(' ').substring(0, cap);
        const quote = c.quote?.priceMin ? ` (Quote: $${c.quote.priceMin.toLocaleString()}-$${c.quote.priceMax.toLocaleString()})` : '';
        return `Session ${i + 1}: ${body}${quote}`;
      }).join('\n');
      contextPrompt += `They have talked with us before. Use this so you sound like you remember (be specific — project type, location, numbers they gave, quote if any):\n${summary}\n\n`;
    }
    contextPrompt += forVoice
      ? `Rules: 1–2 short sentences only, no bullets or lists, no markdown, no emoji. Sound relaxed and human (contractions OK). Mention something concrete from prior chats if you have it; otherwise warm generic welcome-back. One natural follow-up question. End there.]`
      : `Keep greeting to 2 short sentences max. Tone: professional sales executive — warm but not casual (no "what's up", no buddy slang). Reference their prior project or quote if relevant. End with one clear next step or question.]`;

    const systemForGreeting = forVoice
      ? `You write brief, natural phone dialogue for a steel building sales rep. Never robotic, never corporate-AI. No markdown.`
      : SALES_SYSTEM_PROMPT;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: forVoice ? 180 : 256,
      system: systemForGreeting,
      messages: [{ role: 'user', content: contextPrompt }]
    });
    return response.content[0].text;
  }

  return "Hi — thanks for visiting Steel Building Depot. I'm Alex; I help folks get a ballpark on steel building projects. Could I get your name to get started?";
}

module.exports = {
  chat,
  scoreLead,
  getGreeting,
  buildFullConversationMessages,
  resolveContextLimits,
  fetchAllPriorConversationsForLead,
  getContextSummaryForSession,
  priorConversationsToUiHistoryMessages,
  voiceConversationToUiRecapRow,
  voiceConversationToHandoffSummaryText,
  finalizeVoiceContextSummaryOnHangup,
  applyScoreDataToLead,
  mergeConversationContextSummary,
  refreshContextSummaryAfterTurn,
  PROJECT_LIFECYCLE_STAGES,
};
