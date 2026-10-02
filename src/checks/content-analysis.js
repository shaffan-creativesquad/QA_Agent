'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');

// Chain-of-thought prompt: count first, then score — prevents hallucinated percentages
const PROMPT = `You are an expert AI content detector. Analyse the website text below using this exact method:

STEP 1 — Split the text into individual meaningful sentences (ignore nav links, phone numbers, single words).
STEP 2 — For each sentence decide: AI-written or Human-written.
STEP 3 — ai_score = round((ai_sentence_count / total_sentences) * 100), then adjust ±15 based on overall tone.

━━━ AI-WRITTEN SIGNALS (flag these) ━━━
• Generic openers: "In today's fast-paced", "In the digital age", "Are you looking for", "Welcome to"
• Buzzwords: leverage, synergy, streamline, empower, transform, innovative, cutting-edge, comprehensive, seamless, holistic, robust, scalable
• Vague benefit claims: "high-quality service", "exceptional results", "customer satisfaction", "industry-leading", "world-class"
• AI transition phrases at sentence start: "Furthermore,", "Moreover,", "Additionally,", "It is worth noting", "In conclusion,"
• Corporate filler: "We are committed to", "Our team is dedicated to", "We strive to", "We pride ourselves on"
• Generic CTAs: "Contact us today to learn more", "Get started on your journey", "Take the next step"
• Parallel buzzword lists: "quality, reliability, and excellence" / "fast, efficient, and affordable"
• Zero specificity: no real numbers, locations, names, dates, prices, or concrete examples

━━━ HUMAN-WRITTEN SIGNALS (do NOT flag these) ━━━
• Specific numbers, prices, locations, client names, real dates
• Personal voice: "I", "we" with actual stories, contractions (we're, it's, you'll), "honestly", "tbh"
• Natural imperfections: casual punctuation, fragments, conversational run-ons
• Varied sentence rhythm: mix of very short and long sentences
• Genuine opinions or trade-offs: "we don't do X", "this works best for Y"
• Local/specific references: actual neighbourhood, product model, real before/after results

━━━ SCORING CALIBRATION ━━━
0–15  → Human Written   (mostly personal, specific, natural)
16–35 → Mostly Human    (few AI phrases but overall genuine)
36–55 → Mixed           (clear mix, roughly half-half)
56–75 → Likely AI       (majority formulaic, vague, transitional)
76–100→ AI Generated    (almost entirely templated, zero personality)

Return ONLY this raw JSON (no markdown, no explanation):
{
  "total_sentences": <integer — how many sentences you found>,
  "ai_sentence_count": <integer — how many sound AI-written>,
  "ai_score": <0-100 integer>,
  "ai_verdict": "<Human Written|Mostly Human|Mixed|Likely AI|AI Generated>",
  "ai_sentences": [
    {
      "text": "<exact sentence or phrase copied verbatim from the text, max 200 chars>",
      "reason": "<AI Filler Phrase|Vague Claim|Buzzword Overload|Robotic Phrasing|Generic Benefit List|AI Transition Phrase|Corporate Jargon|Zero Personality>",
      "fix": "<specific concrete rewrite that sounds human, max 130 chars>"
    }
  ],
  "proof_issues": [
    {
      "type": "<spelling|grammar|tone|clarity>",
      "quote": "<the problematic word or phrase, max 80 chars>",
      "fix": "<correction or suggestion, max 120 chars>"
    }
  ]
}

WEBSITE TEXT:
`;

const MODEL = 'gemini-3.8-flash';

let genAI = null;
function getModel() {
  if (!genAI) genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  return genAI.getGenerativeModel({ model: MODEL });
}

// On 429 rate-limit: wait 60s and retry up to 2 times
// On 503 busy: wait 10s and retry up to 3 times
async function generateWithRetry(prompt) {
  let attempt = 0;
  while (true) {
    try {
      const result = await getModel().generateContent(prompt);
      return result;
    } catch (err) {
      const is429 = err.message.includes('429') || err.message.includes('Too Many Requests');
      const is503 = err.message.includes('503') || err.message.includes('high demand') ||
                    err.message.includes('Service Unavailable');

      if (is429 && attempt < 2) {
        attempt++;
        console.log(`[content] Rate limited — waiting 65s before retry ${attempt}/2…`);
        await new Promise(r => setTimeout(r, 65000));
        continue;
      }
      if (is503 && attempt < 3) {
        attempt++;
        console.log(`[content] Gemini busy — waiting 10s before retry ${attempt}/3…`);
        await new Promise(r => setTimeout(r, 10000));
        continue;
      }
      throw err;
    }
  }
}

async function analyzePageContent(pageText, pageUrl) {
  if (!pageText || !process.env.GOOGLE_API_KEY) {
    return { score: null, verdict: null, proofIssues: [], aiIssues: [] };
  }

  try {
    const result = await generateWithRetry(PROMPT + pageText.slice(0, 5000));
    const raw = (result.response.text() || '').trim();

    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return { score: null, verdict: null, proofIssues: [], aiIssues: [] };

    const parsed = JSON.parse(match[0]);
    if (typeof parsed.ai_score !== 'number') return { score: null, verdict: null, proofIssues: [], aiIssues: [] };

    // Validate: if total_sentences and ai_sentence_count provided, cross-check score
    let score = Math.max(0, Math.min(100, Math.round(parsed.ai_score)));
    if (parsed.total_sentences > 0 && typeof parsed.ai_sentence_count === 'number') {
      const computed = Math.round((parsed.ai_sentence_count / parsed.total_sentences) * 100);
      // If Gemini's score diverges by more than 20 points from the sentence ratio, trust the ratio
      if (Math.abs(score - computed) > 20) {
        score = Math.max(0, Math.min(100, Math.round((score + computed) / 2)));
      }
    }

    const verdict = parsed.ai_verdict || scoreToVerdict(score);

    const aiIssues = (Array.isArray(parsed.ai_sentences) ? parsed.ai_sentences : [])
      .filter(s => s && typeof s.text === 'string' && s.text.trim())
      .map(s => ({
        type:    'ai_content',
        message: `[${(s.reason || 'AI Pattern').slice(0, 50)}] "${s.text.slice(0, 100)}"${s.fix ? ` → ${s.fix.slice(0, 130)}` : ''}`,
        url:     pageUrl,
        _text:   s.text.trim(),
        _reason: s.reason || 'AI Pattern',
        _fix:    s.fix    || null,
      }));

    const proofIssues = (Array.isArray(parsed.proof_issues) ? parsed.proof_issues : [])
      .filter(i => i && typeof i.quote === 'string' && i.quote.trim())
      .map(i => ({
        type:    'proofreading',
        message: `[${i.type || 'writing'}] "${i.quote.slice(0, 80)}" → ${(i.fix || '').slice(0, 120)}`,
        url:     pageUrl,
      }));

    console.log(`[content] ${pageUrl} → ${score}% AI (${parsed.ai_sentence_count}/${parsed.total_sentences} sentences)`);
    return { score, verdict, proofIssues, aiIssues };

  } catch (err) {
    console.error(`Content analysis failed for ${pageUrl}:`, err.message);
    return { score: null, verdict: null, proofIssues: [], aiIssues: [] };
  }
}

function scoreToVerdict(score) {
  if (score <= 15) return 'Human Written';
  if (score <= 35) return 'Mostly Human';
  if (score <= 55) return 'Mixed';
  if (score <= 75) return 'Likely AI';
  return 'AI Generated';
}

module.exports = { analyzePageContent };
