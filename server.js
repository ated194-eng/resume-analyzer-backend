const express = require('express');
const cors = require('cors');
require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const cheerio = require('cheerio');

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

app.get('/', (_req, res) => {
  res.send('Resume Analyzer API is running');
});

app.post('/analyze', uploadResume, async (req, res) => {
  const { jobPosting, jobUrl } = req.body;
  const file = req.file;

  let jobText = jobPosting;
  if (!jobText && jobUrl) {
    try {
      jobText = await fetchJobText(jobUrl);
    } catch (err) {
      return res.status(400).json({
        error: `Couldn't read that link (${err.message}). Try pasting the job text instead.`
      });
    }
  }

  if (!file || !jobText) {
    return res.status(400).json({ error: 'resume file and a job posting (text or link) are required' });
  }

  jobText = jobText.slice(0, MAX_LENGTH);

  if (file.mimetype !== 'application/pdf') {
    return res.status(400).json({ error: 'Resume must be a PDF' });
  }

  let resume;
  try {
    const parsed = await pdfParse(file.buffer);
    resume = parsed.text;
  } catch (err) {
    return res.status(400).json({ error: 'Could not read that PDF' });
  }

  if (typeof jobPosting !== 'string') {
    return res.status(400).json({ error: 'jobPosting must be text' });
  }

  if (resume.trim().length < 20) {
    return res.status(400).json({ error: 'Could not extract text from this PDF. If it is a scan, try a text-based PDF.' });
  }

  if (jobPosting.trim().length < 20) {
    return res.status(400).json({ error: 'jobPosting must be more detailed' });
  }

  if (resume.length > MAX_LENGTH || jobPosting.length > MAX_LENGTH) {
    return res.status(400).json({ error: 'resume and jobPosting must be under 10,000 characters' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30 second timeout

  try {
    const prompt = `You are a resume analysis assistant. Compare the resume and job posting below.

Resume:
${resume}

Job Posting:
${jobText}

The job posting text may include website navigation or boilerplate. Focus only on the job description itself.

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
    console.error('Error calling Anthropic API:', err);

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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});