



const express = require('express');
const cors = require('cors');
require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const multer = require('multer');
const pdfParse = require('pdf-parse');

const app = express();
app.use(cors());
app.use(express.json());

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

app.get('/', (req, res) => {
  res.send('Resume Analyzer API is running');
});

app.post('/analyze', async (req, res) => {
  const { resume, jobPosting } = req.body;

  if (!resume || !jobPosting) {
    return res.status(400).json({ error: 'resume and jobPosting are both required' });
  }

  if (file.mimetype !== 'application/pdf') {
    return res.status(400).json({ error: 'Resume must be a PDF' });
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

  const MAX_LENGTH = 10000; // ~ a few pages of text, generous for a resume/job posting
  if (resume.length > MAX_LENGTH || jobPosting.length > MAX_LENGTH) {
    return res.status(400).json({ error: 'resume and jobPosting must be under 10,000 characters' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30 second timeout

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [
        {
          role: 'user',
          content: `You are a resume analysis assistant. Compare the resume and job posting below.

Resume:
${resume}

Job Posting:
${jobPosting}

Respond ONLY with valid JSON, no markdown formatting, no preamble, in exactly this shape:
{
  "missing_keywords": ["keyword1", "keyword2"],
  "bullet_suggestions": [{"original": "...", "improved": "..."}],
  "summary": "one or two sentence overall summary"
}`
        },
      ]
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