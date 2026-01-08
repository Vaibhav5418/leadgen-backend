const express = require('express');
const router = express.Router();
const Groq = require('groq-sdk');
const Contact = require('../models/Contact');

// Initialize Groq client (will be created when API key is available)
let groq = null;

// Function to get or create Groq client
function getGroqClient() {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('Groq API key is not configured');
  }
  
  if (!groq) {
    groq = new Groq({
      apiKey: process.env.GROQ_API_KEY
    });
  }
  
  return groq;
}

// Helper function to fetch website content (simplified - you may want to use a web scraping library)
async function fetchWebsiteContent(url) {
  try {
    // Normalize URL
    let normalizedUrl = url;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      normalizedUrl = `https://${url}`;
    }

    // For now, we'll use OpenAI's ability to analyze websites
    // In production, you might want to use a web scraping service like Puppeteer or Cheerio
    // For this implementation, we'll pass the URL to ChatGPT and let it analyze
    return normalizedUrl;
  } catch (error) {
    throw new Error(`Failed to fetch website: ${error.message}`);
  }
}

// Analyze company website using ChatGPT
router.post('/analyze', async (req, res) => {
  try {
    console.log('=== Company Analysis Request ===');
    console.log('Request body:', req.body);
    
    const { companyName, website, prompt: userPrompt } = req.body;

    if (!website) {
      return res.status(400).json({
        success: false,
        error: 'Website URL is required'
      });
    }

    if (!process.env.GROQ_API_KEY) {
      console.error('Groq API key is not configured');
      return res.status(500).json({
        success: false,
        error: 'Groq API key is not configured. Please add GROQ_API_KEY to your .env file.'
      });
    }
    
    console.log('Groq API key found, proceeding with analysis...');

    // Normalize website URL and derive a fallback name from the host
    const normalizedWebsite = website.startsWith('http') ? website : `https://${website}`;
    let derivedCompanyName = companyName;
    try {
      derivedCompanyName = derivedCompanyName || new URL(normalizedWebsite).hostname.replace(/^www\./, '');
    } catch (e) {
      // If URL parsing fails, keep provided companyName (if any)
      derivedCompanyName = derivedCompanyName || 'Unknown company';
    }

    // Create prompt for Groq model (allows user override)
    const defaultPrompt = `
Analyze the following company website as a business expert:

Website URL: ${normalizedWebsite}

Carefully review the website content including:
- Homepage messaging
- Services / Products
- Value propositions
- Target audience
- Positioning and claims

Provide a structured analysis with the following sections:

1) Company Overview
   - What the company does
   - Target customers or industries
   - Geographic or market focus (if mentioned)
   - Overall positioning in the market

2) Company’s Core Offering
   - Primary services or products
   - Key solutions the company sells
   - How these offerings create value for customers

3) Other Important Business Information
   - Ideal customer profile (ICP)
   - Revenue model (inferred if not stated)
   - Key strengths or differentiators
   - Risks, limitations, or points to verify before doing business
   - Any red flags or missing information on the website

Formatting Rules:
- Use clear headings and bullet points
- Keep language professional and concise
- Do NOT include marketing fluff
- Base conclusions strictly on website content and reasonable inference

Return the output as a clean, readable business summary.`;

    const prompt = userPrompt?.trim()
      ? `${userPrompt.trim()}\n\nWebsite URL: ${normalizedWebsite}`
      : defaultPrompt;

    // Get Groq client
    const groqClient = getGroqClient();
    
    // Call Groq API (OpenAI-compatible chat.completions)
    const modelCandidates = [
      'llama-3.3-70b-versatile',   // recommended current
      'llama-3.2-11b-text-preview' // lightweight fallback
    ];

    let completion;
    let lastErr;
    for (const model of modelCandidates) {
      try {
        completion = await groqClient.chat.completions.create({
          model,
      messages: [
        {
          role: 'system',
          content: 'You are a Business Expert specializing in company analysis and market research. Provide detailed, professional, and actionable insights.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: 2000,
      temperature: 0.7
    });
        lastErr = null;
        break;
      } catch (modelErr) {
        lastErr = modelErr;
        // try next model if decommissioned/unavailable
        if (!(modelErr?.message?.includes('model') || modelErr?.code === 'model_decommissioned')) {
          break;
        }
      }
    }

    if (!completion && lastErr) {
      throw lastErr;
    }

    const analysisText = completion.choices[0].message.content;

    // Parse the analysis into structured format
    const analysis = {
      companyOverview: '',
      coreOffering: '',
      businessConsiderations: ''
    };

    // Try to parse the structured response
    const sections = analysisText.split(/\d+\)\s+/);
    if (sections.length > 1) {
      analysis.companyOverview = sections[1]?.split(/2\)/)?.[0]?.trim() || '';
      analysis.coreOffering = sections[2]?.split(/3\)/)?.[0]?.trim() || '';
      analysis.businessConsiderations = sections[3]?.trim() || '';
    } else {
      // If parsing fails, use the full text
      analysis.companyOverview = analysisText;
      analysis.coreOffering = '';
      analysis.businessConsiderations = '';
    }

    res.json({
      success: true,
      data: {
        companyName,
        website: normalizedWebsite,
        analysis,
        fullText: analysisText,
        generatedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('=== Error analyzing company ===');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    console.error('Error type:', error.constructor.name);
    console.error('Error status:', error.status);
    console.error('Error code:', error.code);
    
    // Provide more specific error messages
    let errorMessage = 'Failed to analyze company website';
    let statusCode = 500;
    
    // Check for quota/billing errors (429 status)
    if (error.status === 429 || error.message?.includes('quota') || error.message?.includes('billing')) {
      statusCode = 429;
      errorMessage = 'Groq API quota exceeded. Please check your Groq account billing and add credits.';
    } else if (error.message?.includes('API key') || error.message?.includes('Invalid API key') || error.status === 401) {
      statusCode = 401;
      errorMessage = 'Groq API key is invalid or not configured. Please check your .env file.';
    } else if (error.message?.includes('rate limit') || error.code === 'rate_limit_exceeded') {
      statusCode = 429;
      errorMessage = 'Groq API rate limit exceeded. Please try again later.';
    } else if (error.message?.includes('insufficient_quota') || error.code === 'insufficient_quota') {
      statusCode = 429;
      errorMessage = 'Groq API quota exceeded. Please check your Groq account balance.';
    } else if (error.message?.includes('model')) {
      errorMessage = 'Groq model error. Please check your API configuration.';
    } else if (error.message) {
      errorMessage = error.message;
    }
    
    res.status(statusCode).json({
      success: false,
      error: errorMessage
    });
  }
});

// Get cached analysis for a company (if stored in database)
router.get('/:companyName', async (req, res) => {
  try {
    const { companyName } = req.params;
    const decodedCompanyName = decodeURIComponent(companyName);

    // For now, we'll return a message that analysis needs to be generated
    // In the future, you could store analyses in the database
    res.json({
      success: true,
      message: 'Analysis not cached. Please generate analysis using POST /analyze',
      companyName: decodedCompanyName
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
