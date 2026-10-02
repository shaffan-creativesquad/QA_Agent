'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');

const PROMPT = `You are a professional proofreader reviewing website copy. Analyze the following text for:
- Spelling mistakes (typos, misspelled words)
- Grammar errors (subject-verb disagreement, wrong tense, missing articles, run-on sentences)
- Tone and clarity issues (awkward phrasing, confusing or overly complex sentences)
- Consistency problems (inconsistent capitalization of brand/product names, mixed terminology)

Return ONLY a valid JSON array. Each item must be an object with:
- "issue": a short one-sentence description of the problem
- "quote": the exact short piece of problematic text from the page (max 80 chars)

Return [] if there are no issues. No markdown, no extra text — only the raw JSON array.

WEBSITE TEXT:
`;

let genAI = null;
function getModel() {
  if (!genAI) genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  return genAI.getGenerativeModel({ model: 'gemini-3.8-flash' });
}

async function proofreadContent(pageText, pageUrl) {
  if (!pageText || !process.env.GOOGLE_API_KEY) return [];

  try {
    const result = await getModel().generateContent(PROMPT + pageText.slice(0, 5000));
    const text = (result.response.text() || '').trim();
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];

    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(item => item && typeof item.issue === 'string' && item.issue.length > 5)
      .map(item => ({
        type: 'proofreading',
        message: item.quote
          ? `${item.issue.slice(0, 200)} → "${item.quote.slice(0, 80)}"`
          : item.issue.slice(0, 300),
        url: pageUrl,
      }));
  } catch (err) {
    console.error(`Proofreading failed for ${pageUrl}:`, err.message);
    return [];
  }
}

module.exports = { proofreadContent };
