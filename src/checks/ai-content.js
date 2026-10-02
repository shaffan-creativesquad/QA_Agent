'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');

const PROMPT = `You are an AI content detector like Grammarly. Analyse the following website text and find sentences or phrases that appear AI-generated.

Return a JSON object with these exact fields:

- "score": integer 0–100 (0 = fully human-written, 100 = entirely AI-generated)
- "verdict": exactly one of: "Human Written" | "Mostly Human" | "Mixed" | "Likely AI" | "AI Generated"
- "sentences": array of AI-sounding sentences/phrases found in the text, each with:
  - "text": the EXACT sentence or short phrase copied verbatim from the website text (max 200 chars)
  - "reason": a short label explaining why it sounds AI — choose from: "AI Filler Phrase" | "Vague Claim" | "Buzzword Overload" | "Robotic Phrasing" | "Generic Benefit List" | "AI Transition Phrase" | "Placeholder Text" | "Corporate Jargon" | "Zero Personality"
  - "fix": one specific, actionable rewrite suggestion to make it sound human (max 130 chars)

Scoring guide:
- 0–20: Clearly human — personal voice, specific details, natural imperfections
- 21–40: Mostly human — occasional generic phrases but overall genuine
- 41–60: Mixed — noticeable AI patterns but also human elements
- 61–80: Likely AI — repetitive structure, vague claims, excessive transitions
- 81–100: AI Generated — formulaic, generic, zero personality

What to flag as AI-written:
- Overused transitions: "Furthermore", "Moreover", "It is worth noting", "In today's world", "Delve into"
- Vague, unverifiable claims: "cutting-edge solutions", "comprehensive services", "industry-leading quality"
- Generic benefit lists with no specifics: "quality, reliability, customer satisfaction"
- Perfectly uniform sentence length with no natural variation
- Buzzwords: "leverage", "synergy", "streamline", "empower", "transform", "innovative"
- Corporate filler that says nothing: "We are committed to delivering excellence"
- Zero personal details, anecdotes, or real numbers

Only flag sentences that genuinely sound AI-generated. Return "sentences": [] if content sounds human.
Return ONLY the raw JSON object — no markdown, no explanation.

WEBSITE TEXT:
`;

let genAI = null;
function getModel() {
  if (!genAI) genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  return genAI.getGenerativeModel({ model: 'gemini-3.8-flash' });
}

async function detectAIContent(pageText, pageUrl) {
  if (!pageText || !process.env.GOOGLE_API_KEY) {
    return { score: null, verdict: null, issues: [] };
  }

  try {
    const result = await getModel().generateContent(PROMPT + pageText.slice(0, 5000));
    const text = (result.response.text() || '').trim();

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { score: null, verdict: null, issues: [] };

    const parsed = JSON.parse(match[0]);
    if (typeof parsed.score !== 'number') return { score: null, verdict: null, issues: [] };

    const score     = Math.max(0, Math.min(100, Math.round(parsed.score)));
    const verdict   = parsed.verdict || scoreToVerdict(score);
    const sentences = Array.isArray(parsed.sentences) ? parsed.sentences : [];

    const issues = sentences
      .filter(s => s && typeof s.text === 'string' && s.text.trim())
      .map(s => ({
        type:        'ai_content',
        message:     `[${(s.reason || 'AI Pattern').slice(0, 50)}] "${s.text.slice(0, 100)}"${s.fix ? ` → ${s.fix.slice(0, 130)}` : ''}`,
        url:         pageUrl,
        _text:       s.text.trim(),
        _reason:     s.reason  || 'AI Pattern',
        _fix:        s.fix     || null,
      }));

    return { score, verdict, issues };
  } catch (err) {
    console.error(`AI content detection failed for ${pageUrl}:`, err.message);
    return { score: null, verdict: null, issues: [] };
  }
}

function scoreToVerdict(score) {
  if (score <= 20) return 'Human Written';
  if (score <= 40) return 'Mostly Human';
  if (score <= 60) return 'Mixed';
  if (score <= 80) return 'Likely AI';
  return 'AI Generated';
}

module.exports = { detectAIContent };
