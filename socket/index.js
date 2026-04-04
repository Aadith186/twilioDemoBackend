const { v4: uuidv4 } = require('uuid');
const { Lead, Conversation } = require('../models');
const claudeService = require('../services/claude');

/** Allow reconnect / refresh to reopen a recently ended conversation (ms). */
const RESUME_CONVERSATION_MS = 30 * 60 * 1000;

module.exports = function setupSockets(io) {

  io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // ─── START SESSION ──────────────────────────────────────────────────────
    socket.on('start_session', async ({ sessionId, fingerprint, resumeConversationId }) => {
      try {
        const sid = sessionId || uuidv4();
        socket.sessionId = sid;
        socket.join(`session:${sid}`);

        // Check for returning lead by fingerprint/sessionId
        let lead = null;
        let isReturning = false;

        if (fingerprint) {
          // Try to find existing lead by stored leadId in fingerprint
          lead = await Lead.findById(fingerprint).catch(() => null);
          if (lead) {
            isReturning = true;

            // Update last seen
            lead.lastSeen = new Date();
            lead.isReturning = true;
            await lead.save();
          }
        }

        // Create new lead if not found
        if (!lead) {
          lead = new Lead({ lastSeen: new Date(), firstSeen: new Date() });
          await lead.save();
        }

        // Resume same conversation after refresh (same lead + stored conversation id)
        if (resumeConversationId) {
          const existing = await Conversation.findById(resumeConversationId);
          const belongsToLead =
            existing &&
            existing.leadId &&
            existing.leadId.toString() === lead._id.toString();
          const endedRecently =
            existing &&
            existing.status === 'ended' &&
            existing.endedAt &&
            Date.now() - new Date(existing.endedAt).getTime() < RESUME_CONVERSATION_MS;
          const canResume =
            belongsToLead &&
            (existing.status === 'active' || endedRecently);

          if (canResume) {
            existing.status = 'active';
            existing.endedAt = undefined;
            await existing.save();

            socket.leadId = lead._id.toString();
            socket.conversationId = existing._id.toString();
            socket.sessionId = existing.sessionId || sid;

            const uiMessages = (existing.messages || []).map((m) => ({
              role: m.role,
              content: m.content,
              quote: m.quote || null,
              timestamp: m.timestamp || existing.startedAt
            }));

            socket.emit('session_started', {
              sessionId: existing.sessionId || sid,
              leadId: lead._id.toString(),
              conversationId: existing._id.toString(),
              isReturning,
              resumed: true,
              greeting: null,
              messages: uiMessages
            });

            claudeService
              .fetchAllPriorConversationsForLead(lead._id, {
                excludeConversationId: existing._id,
              })
              .then((previousConversations) => {
                if (!previousConversations.length) return;
                const historyMessages = previousConversations
                  .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime())
                  .flatMap((conv) =>
                    (conv.messages || []).map((m) => ({
                      role: m.role,
                      content: m.content,
                      timestamp: m.timestamp || conv.startedAt,
                      quote: m.quote || null
                    }))
                  );
                socket.emit('history_loaded', { historyMessages });
              })
              .catch((err) => console.error('history_loaded error:', err));

            return;
          }
        }

        // All conversations for this lead (by leadId), full messages — not only lead.conversations[]
        const priorOtherConversations = await claudeService.fetchAllPriorConversationsForLead(lead._id, {});
        const hadPriorConversations = isReturning && priorOtherConversations.length > 0;

        let lastMessageAt = null;
        for (const conv of priorOtherConversations) {
          const convLast = (conv.messages || [])
            .map((m) => (m?.timestamp ? new Date(m.timestamp).getTime() : new Date(conv.startedAt).getTime()))
            .reduce((max, t) => Math.max(max, t), -Infinity);
          if (convLast !== -Infinity) {
            if (!lastMessageAt) lastMessageAt = new Date(convLast);
            else if (convLast > lastMessageAt.getTime()) lastMessageAt = new Date(convLast);
          }
        }

        const shouldSendLongGapGreeting =
          lastMessageAt &&
          Date.now() - lastMessageAt.getTime() > RESUME_CONVERSATION_MS;

        // Create new conversation
        const conversation = new Conversation({
          leadId: lead._id,
          sessionId: sid,
          messages: [],
          status: 'active'
        });
        await conversation.save();

        // Link conversation to lead
        lead.conversations.push(conversation._id);
        lead.totalConversations = lead.conversations.length;
        await lead.save();

        socket.leadId = lead._id.toString();
        socket.conversationId = conversation._id.toString();

        let greetingToSend = null;
        if (!hadPriorConversations) {
          // New lead: professional welcome + ask name (matches chat SALES_SYSTEM_PROMPT register)
          greetingToSend =
            isReturning && lead.name && lead.name !== 'Unknown'
              ? `Welcome back, ${lead.name}. I'm Alex at Steel Building Depot. What can I help you with on your project today?`
              : "Hi — thanks for visiting Steel Building Depot. I'm Alex; I help folks get a ballpark on steel building projects. Could I get your name to get started?";
          conversation.messages.push({ role: 'assistant', content: greetingToSend });
          await conversation.save();
        } else if (shouldSendLongGapGreeting) {
          // Returning user but last chat was > 30 minutes ago: short professional follow-up
          greetingToSend = lead.name && lead.name !== 'Unknown'
            ? `Hi ${lead.name}, good to see you back. Picking up where we left off, or looking at something new?`
            : `Hi — good to see you back. Picking up where we left off, or looking at something new?`;
          conversation.messages.push({ role: 'assistant', content: greetingToSend });
          await conversation.save();
        }

        socket.emit('session_started', {
          sessionId: sid,
          leadId: lead._id.toString(),
          conversationId: conversation._id.toString(),
          isReturning,
          resumed: false,
          greeting: greetingToSend
        });

        // Send previous history after session is ready
        if (priorOtherConversations.length) {
          const historyMessages = priorOtherConversations
            .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime())
            .flatMap((conv) =>
              (conv.messages || []).map((m) => ({
                role: m.role,
                content: m.content,
                timestamp: m.timestamp || conv.startedAt,
                quote: m.quote || null
              }))
            );
          socket.emit('history_loaded', { historyMessages });
        }

        // Notify admin of new session
        io.to('admin').emit('new_lead_activity', {
          leadId: lead._id.toString(),
          name: lead.name,
          isReturning,
          tier: lead.tier,
          score: lead.score,
          timestamp: new Date()
        });

      } catch (err) {
        console.error('start_session error:', err);
        socket.emit('error', { message: 'Failed to start session' });
      }
    });

    // ─── SEND MESSAGE ───────────────────────────────────────────────────────
    socket.on('send_message', async ({ content }) => {
      try {
        if (!socket.conversationId || !socket.leadId) {
          return socket.emit('error', { message: 'No active session' });
        }

        const conversation = await Conversation.findById(socket.conversationId);
        const lead = await Lead.findById(socket.leadId);
        if (!conversation || !lead) return;

        // Save user message
        conversation.messages.push({ role: 'user', content });
        await conversation.save();

        // Emit typing indicator
        socket.emit('ai_typing', true);

        // All other conversations for this lead (full messages), not only lead.conversations[]
        const previousConversations = await claudeService.fetchAllPriorConversationsForLead(lead._id, {
          excludeConversationId: conversation._id,
        });

        // Get AI response
        const { text, quoteData } = await claudeService.chat(
          conversation.messages,
          previousConversations
        );

        // Save AI response
        conversation.messages.push({ role: 'assistant', content: text });

        // If quote was generated, save it
        if (quoteData) {
          conversation.quote = quoteData;
        }

        await conversation.save();

        // Stop typing indicator
        socket.emit('ai_typing', false);

        // Send response to client
        socket.emit('receive_message', {
          role: 'assistant',
          content: text,
          quote: quoteData || null,
          timestamp: new Date()
        });

        // Score lead on every user message
        const userMessageCount = conversation.messages.filter(m => m.role === 'user').length;
        if (userMessageCount > 0) {
          const scoreData = await claudeService.scoreLead(
            conversation.messages,
            lead.name,
            previousConversations
          );

          claudeService.applyScoreDataToLead(lead, scoreData);

          await lead.save();

          // Notify admin of score update
          io.to('admin').emit('lead_score_updated', {
            leadId: lead._id.toString(),
            name: lead.name,
            score: lead.score,
            tier: lead.tier,
            scoreBreakdown: lead.scoreBreakdown,
            requirements: lead.requirements,
            projectLifecycleStage: lead.projectLifecycleStage,
            projectLifecycleReason: lead.projectLifecycleReason,
            quote: quoteData || conversation.quote
          });

          // Send score to chat client (for subtle UX feedback if desired)
          socket.emit('score_updated', { score: lead.score, tier: lead.tier });
        }

        // Also extract name early from first few messages
        if (userMessageCount <= 2 && lead.name === 'Unknown') {
          const scoreData = await claudeService.scoreLead(
            conversation.messages,
            null,
            previousConversations
          );
          if (scoreData.name) {
            lead.name = scoreData.name;
            await lead.save();
            io.to('admin').emit('lead_name_updated', {
              leadId: lead._id.toString(),
              name: lead.name
            });
          }
        }

      } catch (err) {
        console.error('send_message error:', err);
        socket.emit('ai_typing', false);
        socket.emit('error', { message: 'Failed to send message' });
      }
    });

    // ─── ADMIN JOINS ────────────────────────────────────────────────────────
    socket.on('join_admin', () => {
      socket.join('admin');
      console.log(`Admin joined: ${socket.id}`);
    });

    // ─── END SESSION ────────────────────────────────────────────────────────
    socket.on('end_session', async () => {
      try {
        if (!socket.conversationId) return;
        const conversation = await Conversation.findById(socket.conversationId);
        if (conversation) {
          conversation.status = 'ended';
          conversation.endedAt = new Date();
          await conversation.save();
        }
      } catch (err) {
        console.error('end_session error:', err);
      }
    });

    // ─── DISCONNECT ─────────────────────────────────────────────────────────
    // Do not auto-end conversations here: refresh / tab close disconnects briefly
    // and would force a new greeting. Use `end_session` for explicit end.
    socket.on('disconnect', async () => {
      console.log(`Socket disconnected: ${socket.id}`);
    });
  });
};
