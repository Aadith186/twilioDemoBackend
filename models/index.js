const mongoose = require('mongoose');

// ─── PROJECT LIFECYCLE (AI-updated from chat + voice) ─────────────────────────
const PROJECT_LIFECYCLE_STAGES = [
  'Initial Contact',
  'Requirements Gathered',
  'Proposal Sent',
  'Negotiation',
  'Deal Closed',
  'Payment Done',
  'Delivered',
];

// ─── QUOTE SCHEMA ─────────────────────────────────────────────────────────────
const QuoteSchema = new mongoose.Schema({
  priceMin: Number,
  priceMax: Number,
  complexity: { type: Number, min: 1, max: 5 },
  basis: String,
  details: {
    sqft: String,
    roofType: String,
    wallPanels: String,
    insulation: String,
    doors: String,
    region: String,
    specialRequirements: String
  },
  generatedAt: { type: Date, default: Date.now }
});

// ─── MESSAGE SCHEMA ───────────────────────────────────────────────────────────
const MessageSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  quote: QuoteSchema,
  /** e.g. voice_call_summary — injected when user returns to chat after a phone call */
  source: { type: String },
  voiceConversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' },
});

// ─── CONVERSATION SCHEMA ──────────────────────────────────────────────────────
const ConversationSchema = new mongoose.Schema({
  leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true },
  messages: [MessageSchema],
  quote: QuoteSchema,
  /** Rolling dense summary for model context; full messages remain source of truth. */
  contextSummary: { type: String, default: '' },
  contextSummaryUpdatedAt: Date,
  status: { type: String, enum: ['active', 'ended'], default: 'active' },
  startedAt: { type: Date, default: Date.now },
  endedAt: Date,
  sessionId: { type: String, required: true },
  // Voice channel support
  channel: { type: String, enum: ['chat', 'voice'], default: 'chat' },
  callDuration: Number,
  /** Voice Conversation ids for which we already ran the one-time chat handoff (no UI bubble). */
  voiceHandoffAppliedIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' }],
});

// ─── LEAD SCHEMA ──────────────────────────────────────────────────────────────
const LeadSchema = new mongoose.Schema({
  name: { type: String, default: 'Unknown' },
  email: String,
  phone: String,
  company: String,
  score: { type: Number, default: 0, min: 0, max: 100 },
  tier: { type: String, enum: ['hot', 'warm', 'cold', 'new'], default: 'new' },
  scoreBreakdown: {
    projectSize: { points: Number, reason: String },
    budgetSignals: { points: Number, reason: String },
    timeline: { points: Number, reason: String },
    decisionMaker: { points: Number, reason: String },
    projectClarity: { points: Number, reason: String }
  },
  requirements: String,
  projectLifecycleStage: {
    type: String,
    enum: PROJECT_LIFECYCLE_STAGES,
    default: 'Initial Contact',
  },
  projectLifecycleReason: String,
  projectLifecycleUpdatedAt: Date,
  conversations: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' }],
  totalConversations: { type: Number, default: 0 },
  lastSeen: { type: Date, default: Date.now },
  firstSeen: { type: Date, default: Date.now },
  isReturning: { type: Boolean, default: false }
}, { timestamps: true });

// Auto-set tier based on score
LeadSchema.pre('save', function (next) {
  if (this.score >= 75) this.tier = 'hot';
  else if (this.score >= 45) this.tier = 'warm';
  else if (this.score >= 1) this.tier = 'cold';
  else this.tier = 'new';
  next();
});

const Lead = mongoose.model('Lead', LeadSchema);
const Conversation = mongoose.model('Conversation', ConversationSchema);

module.exports = { Lead, Conversation, PROJECT_LIFECYCLE_STAGES };
