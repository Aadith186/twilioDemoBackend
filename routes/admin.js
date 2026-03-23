const express = require('express');
const router = express.Router();
const { Lead, Conversation } = require('../models');

// ─── GET ALL LEADS ────────────────────────────────────────────────────────────
router.get('/leads', async (req, res) => {
  try {
    const { tier, sort = 'lastSeen', page = 1, limit = 20 } = req.query;
    const filter = {};
    if (tier && tier !== 'all') filter.tier = tier;

    const leads = await Lead.find(filter)
      .sort({ [sort]: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .select('-__v')
      .lean();

    // Ensure totalConversations is accurate from DB (source of truth)
    const leadIds = leads.map(l => l._id);
    let countMap = {};
    if (leadIds.length > 0) {
      const convCounts = await Conversation.aggregate([
        { $match: { leadId: { $in: leadIds } } },
        { $group: { _id: '$leadId', count: { $sum: 1 } } }
      ]);
      countMap = Object.fromEntries(convCounts.map(c => [c._id.toString(), c.count]));
    }

    const leadsWithCount = leads.map(l => ({
      ...l,
      totalConversations: countMap[l._id.toString()] ?? l.totalConversations ?? 0
    }));

    const total = await Lead.countDocuments(filter);

    res.json({ leads: leadsWithCount, total, page: parseInt(page), totalPages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET SINGLE LEAD WITH CONVERSATIONS ──────────────────────────────────────
router.get('/leads/:id', async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id).lean();
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const conversations = await Conversation.find({ leadId: lead._id })
      .sort({ startedAt: -1 });

    res.json({
      lead: { ...lead, totalConversations: conversations.length },
      conversations
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET CONVERSATION TRANSCRIPT ─────────────────────────────────────────────
router.get('/conversations/:id', async (req, res) => {
  try {
    const conversation = await Conversation.findById(req.params.id)
      .populate('leadId', 'name email score tier');
    if (!conversation) return res.status(404).json({ error: 'Not found' });
    res.json(conversation);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DASHBOARD STATS ──────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [total, hot, warm, cold, totalConvs, voiceCalls, chatSessions] = await Promise.all([
      Lead.countDocuments(),
      Lead.countDocuments({ tier: 'hot' }),
      Lead.countDocuments({ tier: 'warm' }),
      Lead.countDocuments({ tier: 'cold' }),
      Conversation.countDocuments(),
      Conversation.countDocuments({ channel: 'voice' }),
      Conversation.countDocuments({ channel: { $ne: 'voice' } }),
    ]);

    const avgScore = await Lead.aggregate([
      { $group: { _id: null, avg: { $avg: '$score' } } }
    ]);

    const recentLeads = await Lead.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .select('name score tier createdAt isReturning');

    res.json({
      total, hot, warm, cold,
      totalConversations: totalConvs,
      voiceCalls,
      chatSessions,
      avgScore: Math.round(avgScore[0]?.avg || 0),
      recentLeads
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
