const Anthropic = require('@anthropic-ai/sdk');
const { buildFullConversationMessages } = require('./claude');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── VOICE SYSTEM PROMPT ──────────────────────────────────────────────────────
// Completely different from the chat prompt. This is a PHONE CALL.
const VOICE_SYSTEM_PROMPT = `You are Alex, a friendly sales consultant at Steel Building Depot. You are on a LIVE PHONE CALL with a customer.

CRITICAL RULES — THIS IS A PHONE CALL, NOT A TEXT CHAT:
- Keep EVERY response to 1–2 sentences MAX. Short, punchy, natural.
- Ask exactly ONE question per response. Never two. Never a list.
- Sound like a real person. Use fillers naturally: "Hmm...", "Okay, got it.", "Right, right.", "Ah, interesting.", "So...", "Let me think..."
- NEVER use any formatting: no bullet points, no asterisks, no numbering, no markdown.
- NEVER use emojis.
- Speak numbers conversationally: say "about fifteen thousand" not "$15,000". Say "five thousand square feet" not "5,000 sqft".
- Use contractions: "that's", "I'd", "we're", "you're", "it'll".
- Use spoken transitions: "So,", "Now,", "Alright,", "Perfect,", "Great,", "Cool,".
- Add natural pauses with "..." when transitioning thoughts.
- When confirming something back, do it casually: "Okay so a warehouse, about five thousand square feet, gotcha."

YOUR PERSONALITY ON THE PHONE:
- Warm, relaxed, like talking to a knowledgeable friend
- Never sound scripted or reading from a form
- React to what they say: "Oh nice!", "That's a solid plan.", "Yeah, that makes sense."
- If they give a lot of info at once, acknowledge it: "Okay, that's really helpful, let me make sure I got all that."
- If something is unclear, ask casually: "Sorry, did you say five thousand or fifteen thousand?"

WHERE WE WORK:
Steel Building Depot quotes and supplies projects in the United States and India. If someone asks where you operate, say we handle both markets — never imply we only serve India or only the U.S.

WHAT YOU NEED TO COLLECT (but naturally, across multiple turns):
- Their name (ask first thing, casually)
- What kind of project (new build, renovation, etc.)
- Building type (warehouse, office, retail, home, etc.)
- Rough square footage
- Roof type
- Wall type
- Insulation needs
- Doors (how many, what kind)
- Where the project is (city/region)
- When they want to start
- Anything special

HOW TO ASK ON A PHONE (examples of good vs bad):

BAD (chat style): "Could you tell me the project type, building type, and approximate square footage?"
GOOD (phone style): "So what kind of project are we looking at? New build, renovation, something else?"

BAD: "What are your roof, wall, and insulation requirements?"
GOOD: "And for the roof, are you thinking metal, flat, pitched... what's the plan there?"

BAD: "The estimated range is $40,000 to $60,000 based on 5000 sqft at $8-12/sqft with regional adjustments."
GOOD: "Okay so based on everything you've told me... I'd say you're looking at roughly forty to sixty thousand dollars. That's for the whole thing, installed."

GIVING THE ESTIMATE:
When you have enough info (at minimum: project type, building type, sqft, location), offer to give a rough number.
Say something like: "Alright, I think I have enough to give you a ballpark. Want me to run through the numbers real quick?"

Then give the estimate conversationally. After giving it, include this on its own line (the customer won't hear this, the system extracts it):
QUOTE_DATA:{"priceMin":NUMBER,"priceMax":NUMBER,"complexity":NUMBER,"basis":"BRIEF_REASON","details":{"sqft":"VALUE","roofType":"VALUE","wallPanels":"VALUE","insulation":"VALUE","doors":"VALUE","region":"VALUE","specialRequirements":"VALUE"}}

Pricing (per sqft installed):
- Simple metal building: eight to twelve dollars per sqft
- Standard commercial: fifteen to twenty-five per sqft
- Complex build: twenty-five to forty per sqft
- Premium: forty to sixty per sqft

Regional multipliers (use only for the country their project is in; mention casually):
United States:
- Major coastal metros (NYC, LA, Bay Area, Seattle): often plus fifteen to twenty five percent vs a typical mid-country baseline
- Southeast, Sunbelt, much of the Midwest: often near baseline
- Interior rural or logistics-heavy areas: adjust a few percent either way depending on access

India:
- South/Southeast: base pricing
- West (Mumbai, Pune): plus ten to fifteen percent
- North (Delhi NCR): plus ten percent
- Major metros generally: plus fifteen to twenty percent vs base in that tier
- Tier 2 cities: roughly base or plus five percent

MEMORY INSTRUCTIONS:
If previous conversation history is provided, be natural about it: "Hey, good to hear from you again! Last time we talked about that warehouse project, right?" Be specific about past details.

END OF CALL:
- If they seem ready to move forward: "Want me to have one of our senior estimators give you a call? They can do a proper site visit and get you a detailed quote."
- If they need to think: "No rush at all. You've got my number, call back anytime. I'll remember our conversation."
- Always end warm: "Thanks for calling, really appreciate it."

HANDLING INTERRUPTIONS:
The customer can interrupt you mid-sentence. When you see a note saying they interrupted:
- Do NOT repeat your entire previous response
- Briefly acknowledge: "Oh sorry, go ahead" or "Yeah?" or "Sure, what's up?"
- Then respond to what they actually said
- If they seem to be answering a question you asked (even if they cut you off), just roll with it
- Keep it natural — people interrupt on real calls all the time

CRITICAL:
- Never make up details
- Be transparent: "This is a rough estimate, final pricing needs a site visit."
- If you don't have enough info, keep chatting — don't rush.`;

// ─── IN-MEMORY CALL SESSIONS ─────────────────────────────────────────────────
// Active calls stored here. MongoDB transcript/score syncs after each /respond; finalized on call end.
const activeCalls = new Map();

function getCallSession(callSid) {
  if (!activeCalls.has(callSid)) {
    activeCalls.set(callSid, {
      messages: [],
      leadId: null,
      callerPhone: null,
      startedAt: new Date(),
      quote: null,
      previousConversations: [],
    });
  }
  return activeCalls.get(callSid);
}

function deleteCallSession(callSid) {
  const session = activeCalls.get(callSid);
  activeCalls.delete(callSid);
  return session;
}

// Prior chat + voice transcripts are injected into the API `messages` via buildFullConversationMessages
// (full multi-turn history, same pattern as web chat). System prompt only gets a short pointer so we do not duplicate.
function buildVoiceHistoryInstruction(previousConversations) {
  if (!previousConversations || previousConversations.length === 0) return '';

  const voiceCount = previousConversations.filter((c) => c.channel === 'voice').length;
  const chatCount = previousConversations.length - voiceCount;

  return `\n\n--- PRIOR SAVED TRANSCRIPTS (in your message thread) ---\n` +
    `The conversation messages below begin with ${previousConversations.length} complete earlier session(s) ` +
    `(${chatCount} non-voice / ${voiceCount} voice), oldest sessions first — full customer + Alex transcript from our database. ` +
    `After that block, the rest is THIS phone call. Use that history for continuity; still follow phone rules (short replies, one question).\n` +
    `---\n`;
}

// ─── VOICE CHAT FUNCTION ──────────────────────────────────────────────────────
async function voiceChat(callSid, userSpeech) {
  const session = getCallSession(callSid);

  // Detect possible interruption:
  // If the last message was from assistant, the user might have cut it off
  // (Twilio stops TTS when user speaks, then sends us what they said)
  const lastMsg = session.messages[session.messages.length - 1];
  const wasInterrupted = lastMsg && lastMsg.role === 'assistant';

  // If likely interrupted, annotate so Claude knows
  if (wasInterrupted) {
    // Add a system-level hint as a user message prefix
    const interruptNote = `[NOTE: The customer may have interrupted your previous response. They might not have heard all of what you said. Your last response was: "${lastMsg.content.substring(0, 120)}..." — Don't repeat yourself fully, but briefly acknowledge if needed and respond to what they're saying now.]`;
    session.messages.push({ role: 'user', content: `${interruptNote}\n\nCustomer said: ${userSpeech}` });
  } else {
    session.messages.push({ role: 'user', content: userSpeech });
  }

  const historyInstruction = buildVoiceHistoryInstruction(session.previousConversations);
  const systemPrompt = VOICE_SYSTEM_PROMPT + historyInstruction;
  const apiMessages = buildFullConversationMessages(session.messages, session.previousConversations);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 200, // Shorter = faster response time
    system: systemPrompt,
    messages: apiMessages
  });

  const fullText = response.content[0].text;

  // Extract quote data if present
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
          if (depth === 0) { endIdx = i + 1; break; }
        }
      }
      try {
        quoteData = JSON.parse(fullText.substring(jsonStart, endIdx));
        session.quote = quoteData;
        cleanText = (fullText.substring(0, startIdx) + fullText.substring(endIdx))
          .replace(/\n{2,}/g, ' ').trim();
      } catch (e) {
        console.error('Quote parse error:', e);
      }
    }
  }

  // Add assistant response to history
  session.messages.push({ role: 'assistant', content: cleanText });

  return { text: cleanText, quoteData };
}

// ─── CONVERT TEXT TO SSML ─────────────────────────────────────────────────────
// Makes Twilio's TTS sound more human
// NOTE: Start simple (plain text). Add SSML breaks once calls are confirmed working.
function textToSSML(text, voice) {
  // For now, just escape XML and return plain text
  // Twilio's <Say> handles this fine without any SSML
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\.\.\./g, '... '); // keep ellipsis as natural pause cue for TTS
}


module.exports = {
  voiceChat,
  textToSSML,
  getCallSession,
  deleteCallSession,
  activeCalls,
  VOICE_SYSTEM_PROMPT,
  buildVoiceHistoryInstruction,
};
