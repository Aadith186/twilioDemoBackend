const Anthropic = require('@anthropic-ai/sdk');
const { PROJECT_LIFECYCLE_STAGES } = require('../models');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
const SALES_SYSTEM_PROMPT = `You are Alex, a sales executive at Steel Building Depot. You help customers get ballpark estimates for construction and installation projects.

REGISTER (critical — sound human, not like a friend and not like a bot):
- You are a competent sales professional talking to a customer or prospect: respectful, clear, and pleasant — never buddy-buddy, never cold or stiff
- NOT too casual: do not sound like texting a friend. Avoid "What's up", "Hey [Name]!" as a whole opener, "sup", "yo", "dude", "man", "no worries", "cool cool", or slangy check-ins
- NOT too formal: avoid "Dear Sir/Madam", "I would be delighted to", "per your inquiry", "kindly advise", "at your earliest convenience" — that's corporate-AI or legal tone
- Sweet spot: calm, direct, business-appropriate warmth — like a good account exec on a Zoom who knows their product. Example tone: "Hi Akshay — thanks for reaching out. To point you in the right direction, what kind of build are you looking at?"
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
function buildMemoryContext(previousConversations) {
  if (!previousConversations || previousConversations.length === 0) return '';

  let memory = '\n\n--- RETURNING CUSTOMER HISTORY ---\n';
  memory += `This customer has chatted with us ${previousConversations.length} time(s) before.\n\n`;

  previousConversations.forEach((conv, idx) => {
    memory += `PREVIOUS CONVERSATION ${idx + 1} (${new Date(conv.startedAt).toLocaleDateString()}):\n`;

    // Add transcript summary
    const userMessages = conv.messages
      .filter(m => m.role === 'user')
      .map(m => m.content)
      .join(' | ');
    memory += `Customer said: ${userMessages.substring(0, 500)}\n`;

    // Add quote if exists
    if (conv.quote && conv.quote.priceMin) {
      memory += `Quote given: $${conv.quote.priceMin.toLocaleString()} – $${conv.quote.priceMax.toLocaleString()}\n`;
      memory += `Project details: ${JSON.stringify(conv.quote.details)}\n`;
      memory += `Complexity grade: ${conv.quote.complexity}/5\n`;
    }
    memory += '\n';
  });

  memory += '--- END OF HISTORY ---\n\n';
  memory += 'Use this history naturally in conversation. Reference previous projects and quotes when relevant.\n';
  return memory;
}

function buildFullConversationMessages(currentMessages, previousConversations = []) {
  const historicalMessages = previousConversations
    .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime())
    .flatMap((conv) =>
      (conv.messages || [])
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
        .map((m) => ({ role: m.role, content: m.content }))
    );

  const liveMessages = (currentMessages || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .map((m) => ({ role: m.role, content: m.content }));

  return [...historicalMessages, ...liveMessages];
}

// ─── MAIN CHAT FUNCTION ───────────────────────────────────────────────────────
async function chat(messages, previousConversations = []) {
  const memoryContext = buildMemoryContext(previousConversations);
  const systemWithMemory = SALES_SYSTEM_PROMPT + memoryContext;
  const fullContextMessages = buildFullConversationMessages(messages, previousConversations);

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
  const fullConversationMessages = buildFullConversationMessages(
    conversationMessages,
    previousConversations
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
async function getGreeting(isReturning, leadName, previousConversations = []) {
  if (isReturning && (leadName || previousConversations?.length > 0)) {
    let contextPrompt = `[SYSTEM: Generate a brief welcome-back message for a returning customer — tone: professional sales executive (warm, not casual: no "what's up" or buddy slang)`;
    if (leadName && leadName !== 'Unknown') contextPrompt += ` named ${leadName}`;
    contextPrompt += `. `;

    if (previousConversations && previousConversations.length > 0) {
      const summary = previousConversations.map((c, i) => {
        const userMsgs = c.messages?.filter(m => m.role === 'user').map(m => m.content).join(' | ') || '';
        const quote = c.quote?.priceMin ? ` (Quote: $${c.quote.priceMin.toLocaleString()}-$${c.quote.priceMax.toLocaleString()})` : '';
        return `Visit ${i + 1}: ${userMsgs.substring(0, 200)}${quote}`;
      }).join('\n');
      contextPrompt += `You remember their previous chat(s). Use this context to reference what they discussed:\n${summary}\n\n`;
    }
    contextPrompt += `Keep greeting to 2 short sentences max. Tone: professional sales executive — warm but not casual (no "what's up", no buddy slang). Reference their prior project or quote if relevant. End with one clear next step or question.]`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 256,
      system: SALES_SYSTEM_PROMPT,
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
  applyScoreDataToLead,
  PROJECT_LIFECYCLE_STAGES,
};
