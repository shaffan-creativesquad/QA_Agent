'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');

const PROMPT = `You are a developer doing a QA review of a website screenshot. Find real rendering and content defects only.

Return ONLY a valid JSON array of strings, where each string is a plain one-sentence description of a specific defect.
Return [] if there are no defects. No markdown, no severity labels, no explanations — only the JSON array of strings.

Check for:
- Layout sections visibly broken, overlapping, or collapsed
- Buttons with no visible text (blank button area)
- Images not loading (broken image icon showing)
- Placeholder or lorem ipsum text visible to users
- Navigation menu broken or items misaligned
- Text cut off or overflowing outside its box
- Form fields or labels misaligned
- Horizontal overflow causing page to be wider than viewport
- Any obvious "TODO", "coming soon placeholder", or dummy content
- Spinner or loading state stuck on screen`;

let genAI = null;
function getModel() {
  if (!genAI) genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  return genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
}

async function analyzeScreenshot(screenshotBase64, pageUrl) {
  if (!screenshotBase64 || !process.env.GOOGLE_API_KEY) return [];

  try {
    const result = await getModel().generateContent([
      { inlineData: { data: screenshotBase64, mimeType: 'image/jpeg' } },
      PROMPT,
    ]);

    const text = (result.response.text() || '').trim();
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];

    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(s => typeof s === 'string' && s.length > 5)
      .map(s => ({ type: 'visual', message: s.slice(0, 300), url: pageUrl }));
  } catch (err) {
    console.error(`Visual analysis failed for ${pageUrl}:`, err.message);
    return [];
  }
}

module.exports = { analyzeScreenshot };
