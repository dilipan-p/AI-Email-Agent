// src/services/aiService.js
// AI analysis engine using OpenAI GPT-4
// Handles: intent detection, tone analysis, priority scoring, reply generation
// Falls back to heuristic analysis when OpenAI is unavailable.

const logger = require('../config/logger');
const { fallbackAnalysis } = require('./fallbackAnalysis');

class AiService {
  constructor() {
    // OpenAI is optional — only initialize if API key is provided
    if (process.env.OPENAI_API_KEY) {
      const OpenAI = require('openai');
      this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    } else {
      this.client = null;
      logger.info('No OPENAI_API_KEY found — running in rule-based mode');
    }
    this.model = process.env.OPENAI_MODEL || 'gpt-4o';
    this.maxTokens = parseInt(process.env.OPENAI_MAX_TOKENS) || 1000;
  }

  // ============================================================
  // CORE: Analyze email - returns full analysis object
  // ============================================================
  async analyzeEmail(email) {
    const startTime = Date.now();
    logger.info(`Analyzing email from ${email.sender}`, { subject: email.subject });

    // No OpenAI key — go straight to rule-based fallback
    if (!this.client) {
      logger.info('Using rule-based engine (no OpenAI key configured)');
      return {
        ...fallbackAnalysis(email),
        analysisDurationMs: Date.now() - startTime,
      };
    }

    const systemPrompt = `You are an AI email analyst. Analyze emails and return ONLY valid JSON.

Respond with this exact JSON structure:
{
  "intent": "meeting_request|question|task_request|spam|promotional|personal|informational|other",
  "tone": "formal|informal|friendly|humorous|neutral|urgent|angry|unknown",
  "priority": "high|medium|low",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation",
  "keyPoints": ["point1", "point2"],
  "isSafeToAutoReply": true|false,
  "extractedDatetime": "any mentioned dates/times or null",
  "extractedParticipants": ["email1@example.com"],
  "suggestedDecision": "AUTO_REPLY|NEEDS_APPROVAL|IGNORE|DELETE",
  "isKnownSafe": true|false
}

Rules:
- spam/promotional/advertising = DELETE
- meeting requests from known contacts = AUTO_REPLY
- angry/sensitive/unknown sender = NEEDS_APPROVAL
- newsletters/marketing = DELETE
- informational only = IGNORE
- confidence must reflect your certainty (be conservative)`;

    const userPrompt = `Analyze this email:

FROM: ${email.sender} (${email.senderName || 'Unknown'})
SUBJECT: ${email.subject || '(no subject)'}
BODY:
${(email.body || '').substring(0, 2000)}

${email.isKnownContact ? 'NOTE: Sender IS in known contacts list.' : 'NOTE: Sender is NOT in known contacts list (unknown sender).'}`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: this.maxTokens,
        temperature: 0.1,   // Low temperature for consistent analysis
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });

      const raw = response.choices[0]?.message?.content || '{}';
      let analysis;

      try {
        analysis = JSON.parse(raw);
      } catch {
        logger.error('Failed to parse AI analysis JSON', { raw });
        analysis = this._fallbackAnalysis();
      }

      const duration = Date.now() - startTime;
      logger.info(`Email analyzed in ${duration}ms`, {
        intent: analysis.intent,
        decision: analysis.suggestedDecision,
        confidence: analysis.confidence,
      });

      return {
        ...analysis,
        aiModel: this.model,
        tokensUsed: response.usage?.total_tokens || 0,
        analysisDurationMs: duration,
      };
    } catch (err) {
      const duration = Date.now() - startTime;

      // Classify the error so we can log it clearly
      const isQuotaError = err?.status === 429 || /quota|rate.?limit/i.test(err.message);
      const isAuthError  = err?.status === 401 || /auth|api.?key/i.test(err.message);
      const errorType    = isQuotaError ? 'QUOTA_EXCEEDED'
                         : isAuthError  ? 'AUTH_FAILURE'
                         : 'API_ERROR';

      logger.warn(`OpenAI unavailable (${errorType}) — switching to heuristic fallback`, {
        errorType,
        errorMessage: err.message,
        sender: email.sender,
        subject: email.subject,
      });

      // Run the intelligent heuristic fallback
      const heuristicResult = fallbackAnalysis(email);

      logger.info('Heuristic fallback analysis complete', {
        intent:    heuristicResult.intent,
        tone:      heuristicResult.tone,
        priority:  heuristicResult.priority,
        confidence: heuristicResult.confidence,
        decision:  heuristicResult.suggestedDecision,
      });

      return {
        ...heuristicResult,
        analysisDurationMs: duration,
        openAiError: err.message,
      };
    }
  }

  // ============================================================
  // Generate a reply based on tone and context
  // ============================================================
  async generateReply(email, analysis, additionalContext = '') {
    logger.info(`Generating reply for email from ${email.sender}`);

    const toneInstructions = {
      formal: 'Write a professional, structured reply. Use formal language. Include proper greeting and sign-off.',
      informal: 'Write a casual, friendly reply. Use conversational language. Keep it natural and warm.',
      friendly: 'Write a warm, helpful reply. Be personable and engaging while remaining professional.',
      humorous: 'Write a light, pleasant reply. Safe, subtle humor is okay but keep it professional.',
      urgent: 'Write a prompt, clear reply. Acknowledge urgency and provide direct answers.',
      angry: 'Write a calm, empathetic, de-escalating reply. Be professional and understanding.',
      neutral: 'Write a clear, concise, professional reply.',
      unknown: 'Write a polite, professional reply.',
    };

    const toneGuide = toneInstructions[analysis.tone] || toneInstructions.neutral;

    const systemPrompt = `You are a professional email assistant writing replies on behalf of a user.

${toneGuide}

Rules:
- Keep replies concise (3-5 sentences max unless detail is required)
- Be accurate and context-aware
- Never invent facts or make commitments the user hasn't approved
- No offensive humor, sarcasm, or risky language
- Do not add placeholders like [Your Name] - the user will sign off
- End with "Best regards" for formal, "Thanks" or "Best" for informal
- Do NOT include a signature block`;

    const userPrompt = `Write a reply to this email:

FROM: ${email.senderName || email.sender}
SUBJECT: ${email.subject}
EMAIL BODY:
${(email.body || '').substring(0, 1500)}

INTENT: ${analysis.intent}
TONE: ${analysis.tone}
KEY POINTS: ${(analysis.keyPoints || []).join('; ')}
${additionalContext ? `ADDITIONAL CONTEXT: ${additionalContext}` : ''}

Generate the reply body only (no subject line, no "From:", just the message body):`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: 500,
        temperature: 0.3,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });

      const reply = response.choices[0]?.message?.content?.trim() || '';
      logger.info(`Reply generated (${reply.length} chars)`);
      return reply;
    } catch (err) {
      logger.error('Reply generation failed', { error: err.message });
      throw new Error(`Reply generation failed: ${err.message}`);
    }
  }

  // ============================================================
  // Extract meeting details from email
  // ============================================================
  async extractMeetingDetails(email) {
    const systemPrompt = `Extract meeting information from emails. Return ONLY valid JSON:
{
  "hasMeetingRequest": true|false,
  "proposedTimes": ["ISO datetime strings or natural language dates"],
  "duration": "in minutes or null",
  "location": "physical or virtual location or null",
  "meetingPurpose": "brief description or null",
  "participants": ["email addresses mentioned"],
  "timezone": "timezone if mentioned or null",
  "isFlexible": true|false
}`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: 300,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Extract meeting info from:\n\nSUBJECT: ${email.subject}\n\n${email.body?.substring(0, 1000)}` },
        ],
      });

      return JSON.parse(response.choices[0]?.message?.content || '{"hasMeetingRequest": false}');
    } catch (err) {
      logger.error('Meeting extraction failed', { error: err.message });
      return { hasMeetingRequest: false };
    }
  }

  // ============================================================
  // Classify if email is definitely spam/promotional
  // ============================================================
  async classifySpam(email) {
    const systemPrompt = `Classify if an email is spam or promotional. Return ONLY JSON:
{
  "isSpam": true|false,
  "isPromotional": true|false,
  "confidence": 0.0-1.0,
  "reason": "brief reason"
}`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: 150,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `FROM: ${email.sender}\nSUBJECT: ${email.subject}\n\n${email.body?.substring(0, 500)}` },
        ],
      });

      return JSON.parse(response.choices[0]?.message?.content || '{"isSpam": false, "confidence": 0}');
    } catch {
      return { isSpam: false, isPromotional: false, confidence: 0 };
    }
  }

  // Legacy helper kept for JSON parse failures (non-API errors).
  // For API failures, analyzeEmail() now calls fallbackAnalysis() directly.
  _fallbackAnalysis() {
    return {
      intent: 'other',
      tone: 'unknown',
      priority: 'medium',
      confidence: 0.0,
      reasoning: 'JSON parse error on AI response - defaulting to safe NEEDS_APPROVAL',
      keyPoints: [],
      isSafeToAutoReply: false,
      extractedDatetime: null,
      extractedParticipants: [],
      suggestedDecision: 'NEEDS_APPROVAL',
      isKnownSafe: false,
      aiModel: this.model,
      tokensUsed: 0,
    };
  }
}

module.exports = new AiService();
