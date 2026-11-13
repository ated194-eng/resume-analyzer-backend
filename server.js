const express = require('express');
const cors = require('cors');
require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const cheerio = require('cheerio');
const PDFDocument = require('pdfkit');

const app = express();
app.use(cors());
app.use(express.json());

const MAX_LENGTH = 10000;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB cap
});

// Wrapper so upload errors (like a file that's too big) return clean JSON
const uploadResume = (req, res, next) => {
  upload.single('resume')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'File must be under 5MB'
        : 'File upload failed';
      return res.status(400).json({ error: msg });
    }
    next();
  });
};

async function fetchJobText(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error('that is not a valid URL');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('URL must start with http:// or https://');
  }

  // Basic guard: don't let people point your server at private/internal addresses
  const host = url.hostname;
  const isPrivate =
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') ||
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  if (isPrivate) {
    throw new Error('that address is not allowed');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ResumeAnalyzer/1.0)' }
    });
    if (!res.ok) {
      throw new Error(`the page returned status ${res.status}`);
    }
    const html = await res.text();
    const $ = cheerio.load(html);
    $('script, style, nav, footer, header, noscript, svg').remove();
    return $('body').text().replace(/\s+/g, ' ').trim();
  } finally {
    clearTimeout(timer);
  }
}

class InputError extends Error {}

// Pulls the resume text and job text out of the request
async function getResumeAndJob(req) {
  const file = req.file
  const { jobPosting, jobUrl } = req.body;
  
  if (!file) throw new InputError('Please attach your resume as a PDF');
  if (file.mimetype !== 'application/pdf') throw new InputError('Resume must be a PDF');

  let resume;
  try {
    resume = (await pdfParse(file.buffer)).text;
  } catch {
    throw new InputError('Could not read that PDF');
  }
  if (resume.trim().length < 20) {
    throw new InputError('Could not extract text from this PDF. Try a text-based PDF.');
  }

  let jobText = jobPosting;
  if (!jobText && jobUrl) {
    try {
      jobText = await fetchJobText(jobUrl);
    } catch (err) {
      throw new InputError(`Couldn't read that link (${err.message}). Try pasting the job text instead.`);
    }
  }
  if (!jobText || jobText.trim().length < 20) {
    throw new InputError('A job posting (text or link) is required');
  }

  return { resume: resume.slice(0, MAX_LENGTH), jobText: jobText.slice(0, MAX_LENGTH) };
}

// Draws the PDF from Claude's structured JSON
function buildResumePdf(data, res) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="tailored-resume.pdf"');
  doc.pipe(res);

  const section = (title) => {
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(12).text(title, 50);
    const y = doc.y + 2;
    doc.moveTo(50, y).lineTo(562, y).lineWidth(0.75).stroke();
    doc.moveDown(0.4);
  };

  const row = (left, right) => {
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(10.5);
    const h = doc.heightOfString(left, { width: 380 });
    doc.text(left, 50, y, { width: 380 });
    doc.font('Helvetica').text(right || '', 430, y, { width: 132, align: 'right' });
    doc.x = 50;
    doc.y = y + h;
  };

  const bullets = (items = []) => {
    doc.font('Helvetica').fontSize(10).list(items, {
      bulletRadius: 1.5,
      textIndent: 12,
      bulletIndent: 10,
      lineGap: 1
    });
    doc.x = 50;
    doc.moveDown(0.3);
  };

  // Header
  doc.font('Helvetica-Bold').fontSize(20).text(data.name || '', { align: 'center' });
  doc.font('Helvetica').fontSize(10).text(data.contact || '', { align: 'center' });

  if (data.summary) {
    section('Summary');
    doc.font('Helvetica').fontSize(10).text(data.summary, 50);
  }

  if (data.skills?.length) {
    section('Technical Skills');
    data.skills.forEach((s) => {
      doc.font('Helvetica-Bold').fontSize(10).text(`${s.category}: `, 50, doc.y, { continued: true });
      doc.font('Helvetica').text((s.items || []).join(', '));
    });
  }

  if (data.projects?.length) {
    section('Projects');
    data.projects.forEach((p) => {
      row(p.name, p.tech);
      bullets(p.bullets);
    });
  }

  if (data.experience?.length) {
    section('Experience');
    data.experience.forEach((e) => {
      row(e.title, e.dates);
      doc.font('Helvetica').fontSize(10).text(e.company || '', 50);
      bullets(e.bullets);
    });
  }

  if (data.education?.length) {
    section('Education');
    data.education.forEach((ed) => {
      row(ed.school, ed.dates);
      doc.font('Helvetica').fontSize(10).text(ed.degree || '', 50);
    });
  }

  doc.end();
}

function parseSuggestions(raw) {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    const keywords = Array.isArray(s.missing_keywords)
      ? s.missing_keywords.filter((k) => typeof k === 'string').slice(0, 20).map((k) => k.slice(0, 60))
      : [];
    const bullets = Array.isArray(s.bullet_suggestions)
      ? s.bullet_suggestions
          .filter((b) => b && typeof b.original === 'string' && typeof b.improved === 'string')
          .slice(0, 10)
          .map((b) => ({ original: b.original.slice(0, 500), improved: b.improved.slice(0, 500) }))
      : [];
    return { keywords, bullets };
  } catch {
    return null;
  }
}

app.get('/', (_req, res) => {
  res.send('Resume Analyzer API is running');
});

app.post('/analyze', uploadResume, async (req, res) => {
  try {
    const { resume, jobText } = await getResumeAndJob(req);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30 second timeout
    
    const prompt = `You are a resume analysis assistant. Compare the resume and job posting below.

Resume:
${resume}

Job Posting:
${jobText}

The job posting text may include website navigation or boilerplate. Focus only on the job description itself.

Each "improved" bullet must be ready to paste into the resume as written. Use only facts already in the resume, and do not include advice or phrases like "consider" or "if applicable". Put any advice in the summary instead.

Respond ONLY with valid JSON, no markdown formatting, no preamble, in exactly this shape:
{
  "missing_keywords": ["keyword1", "keyword2"],
  "bullet_suggestions": [{"original": "...", "improved": "..."}],
  "summary": "one or two sentence overall summary"
}`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    }, { signal: controller.signal });

    clearTimeout(timeout);

    const rawText = message.content[0].text;
    const cleaned = rawText.replace(/```json|```/g, '').trim();

    let parsed;
    try {
    parsed = JSON.parse(cleaned);
    } catch (parseErr) {
    console.error('Failed to parse model response as JSON:', rawText);
    return res.status(502).json({ error: 'Received an unexpected response format. Please try again.' });
    }

    res.json(parsed);
  } catch (err) {
    console.error('Error in /analyze', err);

    if (err instanceof InputError) {
      return res.status(400).json({ error: err.message });
    }

    if (err instanceof SyntaxError) {
    // JSON.parse failed — the model didn't return clean JSON
    return res.status(502).json({ error: 'Received an unexpected response format. Please try again.' });
    }

    if (err.status === 401) {
        return res.status(500).json({ error: 'Server configuration error' }); // don't leak API key details to the client
    }

    if (err.status === 429) {
        return res.status(429).json({ error: 'Too many requests right now. Please try again in a moment.' });
    }

    if (err.status === 400) {
        return res.status(400).json({ error: 'Invalid request to AI service' });
    }

    res.status(500).json({ error: 'Failed to analyze resume' });
  }
});

app.post('/tailor', uploadResume, async (req, res) => {
  try {
    const { resume, jobText } = await getResumeAndJob(req);

    const suggestions = parseSuggestions(req.body.suggestions);
    const suggestionBlock = suggestions
      ? `The candidate already reviewed an analysis of this resume. Apply it where it is accurate:

    Keywords worth including (only where the resume genuinely supports them): ${suggestions.keywords.join(', ')}

    Bullet rewrites to use (original -> improved):
    ${suggestions.bullets.map((b) => `- "${b.original}" -> "${b.improved}"`).join('\n')}

    If a suggested rewrite contains advice rather than resume wording, or adds anything not in the original resume, ignore the suggestion and write the best accurate version of that bullet instead.
    `
      : '';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    const prompt = `You are an expert resume editor. Rewrite the candidate's resume so it is tailored to the job posting below.

STRICT RULES:
- Use ONLY facts that appear in the original resume. Never invent employers, job titles, dates, degrees, projects, metrics, or skills.
- You may reorder sections and bullets, tighten wording, and use the job posting's terminology where it accurately describes work the candidate actually did.
- If the job asks for a skill the resume does not show, leave it out. Do not add it.
- Keep it to one page: at most 3 bullets per job, 2 per project, concise wording.
- Keep the name, contact details, links, dates, and school names exactly as written.

Resume:
${resume}

Job Posting:
${jobText}

${suggestionBlock}
The job posting text may include website navigation or boilerplate. Focus only on the job description itself.

Respond ONLY with valid JSON, no markdown formatting, no preamble, in exactly this shape:
{
  "name": "string",
  "contact": "one line: location | email | phone | links",
  "summary": "2-3 sentences, or empty string",
  "skills": [{"category": "string", "items": ["string"]}],
  "projects": [{"name": "string", "tech": "string", "bullets": ["string"]}],
  "experience": [{"title": "string", "company": "string", "dates": "string", "bullets": ["string"]}],
  "education": [{"school": "string", "degree": "string", "dates": "string"}]
}`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }]
    }, { signal: controller.signal });

    clearTimeout(timeout);

    const cleaned = message.content[0].text.replace(/```json|```/g, '').trim();
    let data;
    try {
      data = JSON.parse(cleaned);
    } catch {
      console.error('Failed to parse tailored resume JSON:', cleaned);
      return res.status(502).json({ error: 'Received an unexpected response format. Please try again.' });
    }

    buildResumePdf(data, res);
  } catch (err) {
    console.error('Error in /tailor:', err);
    if (err instanceof InputError) return res.status(400).json({ error: err.message });
    if (err.status === 429) return res.status(429).json({ error: 'Too many requests right now. Please try again in a moment.' });
    res.status(500).json({ error: 'Failed to generate resume' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});