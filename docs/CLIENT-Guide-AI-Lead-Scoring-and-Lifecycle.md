# AI Lead Scoring & Project Lifecycle — Client Guide

This document explains how **Steel Building Depot** (or your deployment’s) AI assistant analyzes sales conversations to produce a **lead score**, **score breakdown**, **project lifecycle stage**, and **structured lead fields**. It reflects the current server implementation used for **web chat** and **voice calls**.

---

## 1. What the system does

After customers interact with the AI (Alex) via **chat** or **phone**, the system:

1. **Combines the full conversation history** (including past ended sessions for the same lead, when available).
2. **Sends that transcript** to an AI model configured as a *B2B construction lead scoring engine*.
3. **Receives a structured JSON result** with:
   - Overall **score** (0–100)
   - **Score breakdown** (five dimensions with points and short reasons)
   - **One-line project summary** (“requirements”)
   - **Project lifecycle stage** (one of seven canonical stages) and a **brief reason**
   - **Extracted contact fields** (name, email, phone, company) when mentioned in conversation
4. **Stores** these values on the **lead** record in the database so your **admin API** and dashboard can display them.

**Important:** Scores and stages are **assistive**—they prioritize follow-up and reporting. They are **not** a guarantee of revenue, budget, or timeline.

---

## 2. When scoring runs

| Channel | When |
|--------|------|
| **Web chat** | After each **user message**, when scoring is triggered for that session (same pipeline for all chat turns that perform scoring). |
| **Voice** | After each **recognized caller utterance** (background job), once there is at least one user message in the call, so Twilio response time is not blocked. |

**History:** The model is instructed to consider the **full transcript across earlier ended conversations** for that lead (returning customers), not only the current session.

**Serving data to your app:** Lead records (including `score`, `scoreBreakdown`, `requirements`, lifecycle fields) are available through **`GET /api/admin/leads`** and **`GET /api/admin/leads/:id`** (`server/routes/admin.js`). Voice-specific persistence is handled in **`server/routes/voice.js`**; scoring logic itself lives in **`server/services/claude.js`**.

---

## 3. Overall lead score (0–100)

The AI outputs a single integer **`score`** from **0** to **100**. It is **conceptually aligned** with the sum of the five breakdown dimensions below (maximum **100** points in the rubric).

If the model’s JSON **cannot be parsed**, the system may fall back to a **low default score** and minimal fields so the pipeline keeps running—this is a technical safeguard, not a business rule.

---

## 4. Score breakdown — dimensions and rubric

Each dimension includes **points** (within the stated range) and a **short text reason** the AI uses to justify that score. Your UI can show both.

| Dimension | Max points | What the AI considers (rubric in product) |
|-----------|------------|-------------------------------------------|
| **Project size** | **25** | **25** — Large commercial / industrial scope.<br>**15** — Medium commercial.<br>**8** — Small / residential.<br>**0** — Unclear or not enough signal. |
| **Budget signals** | **25** | **25** — Budget approved or clearly allocated.<br>**15** — Customer mentioned a budget range.<br>**8** — Primarily asking for an estimate.<br>**3** indicators of price shopping only / weak budget signal. |
| **Timeline** | **20** | **20** — Start within **1 month**.<br>**15** — **1–3 months**.<br>**10** — **3–6 months**.<br>**3** — Early exploration / no clear near-term start. |
| **Decision maker** | **15** | **15** — Confirmed decision maker.<br>**8** — Influencer (not final authority) or partial signal.<br>**3** — Role in decision unclear. |
| **Project clarity** | **15** | **15** — Essentially all needed details discussed.<br>**10** — Most details present.<br>**5** — Some details.<br>**0** — Very vague. |

**Total if all maxed:** 25 + 25 + 20 + 15 + 15 = **100**.

The AI also returns a **one-sentence** field **`requirements`** summarizing the project from the conversation.

---

## 5. Lead tier (Hot / Warm / Cold / New)

Tiers are **derived automatically from `score`** when the lead is saved (not chosen freely by the AI):

| Tier | Score range |
|------|-------------|
| **Hot** | **≥ 75** |
| **Warm** | **45 – 74** |
| **Cold** | **1 – 44** |
| **New** | **0** |

---

## 6. Project lifecycle stage

The AI assigns **one** lifecycle **stage** that is the **most advanced stage clearly supported by evidence** in the transcript. Stages are fixed labels (order matters for reporting):

1. **Initial Contact**  
2. **Requirements Gathered**  
3. **Proposal Sent**  
4. **Negotiation**  
5. **Deal Closed**  
6. **Payment Done**  
7. **Delivered**

**Mapping guidance (as configured for the model):**

| Stage | Meaning (evidence-based) |
|-------|---------------------------|
| **Initial Contact** | First touch only; little detail yet. |
| **Requirements Gathered** | Scope, square footage, location, or similar details discussed. |
| **Proposal Sent** | A quote or formal proposal was shared. |
| **Negotiation** | Price or terms being revised or discussed in depth. |
| **Deal Closed** | Clear verbal or written commitment to proceed. |
| **Payment Done** | Payment or deposit confirmed in conversation. |
| **Delivered** | Handoff / delivery discussed or completed. |

The AI also returns **`projectLifecycleReason`**: a **short phrase** pointing to why that stage was chosen. Invalid or missing stages from the model are **not** written to the lead; a valid stage from the list above is required to update the stored stage.

**Default for new leads:** **Initial Contact** (until the model returns another valid stage).

---

## 7. Extracted contact and company fields

From the same scoring pass, when clearly stated in the transcript:

- **name**, **email**, **phone**, **company**  

Business rules on the server may **only fill blanks** for some fields (e.g. don’t overwrite an existing email with a guess). Exact merge rules are implemented in code (`applyScoreDataToLead` in `server/services/claude.js`).

---

## 8. Quotes (separate from the score rubric)

When the assistant generates a **price range** in chat or voice, that can be stored as **quote** data on the conversation (price band, complexity, structured details). That is **not** the same JSON as the lead-scoring output but complements it for sales follow-up.

---

## 9. Technical notes (for your IT contact)

- **Model:** Configured in code as **Claude Sonnet** (`claude-sonnet-4-20250514` for scoring in the current implementation).
- **Input:** Plain-formatted transcript (customer vs Alex), built from current and past **ended** sessions where applicable.
- **Output:** Strict **JSON** (no markdown). Parsing failures trigger safe fallbacks.
- **API:** Admin routes expose lead documents; real-time dashboards may also receive **socket** events when scores update after chat or voice.

---

## 10. Suggested disclaimer for end users or contracts

*“Lead scores, tiers, and lifecycle stages are generated by AI from conversation text and are intended to support sales prioritization and reporting. They are estimates only and should be confirmed by your team before commercial or contractual decisions.”*

---

*Document generated to match the product logic in `server/services/claude.js`, `server/models/index.js`, `server/routes/admin.js`, and `server/routes/voice.js`. If the scoring prompt or tier thresholds change in code, update this guide accordingly.*
