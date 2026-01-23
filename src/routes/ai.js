const express = require('express');
const router = express.Router();
const { generatePersonalizedEmail, generatePersonalizedLinkedInMessage } = require('../services/aiService');
const authenticate = require('../middleware/auth');

/**
 * Generate personalized email
 * POST /api/ai/generate-email
 * Body: { contactId, projectId, baseTemplate? }
 */
router.post('/generate-email', authenticate, async (req, res) => {
  try {
    const { contactId, projectId, baseTemplate } = req.body;

    if (!contactId) {
      return res.status(400).json({
        success: false,
        error: 'Contact ID is required'
      });
    }

    if (!projectId) {
      return res.status(400).json({
        success: false,
        error: 'Project ID is required'
      });
    }

    // Generate personalized email
    const result = await generatePersonalizedEmail(contactId, projectId, baseTemplate);

    res.json({
      success: true,
      data: {
        emailContent: result.emailContent,
        contactInfo: result.contactInfo
      }
    });
  } catch (error) {
    console.error('Error generating email:', error);
    
    let errorMessage = 'Failed to generate personalized email';
    let statusCode = 500;

    if (error.message?.includes('API key') || error.message?.includes('Groq API key')) {
      statusCode = 500;
      errorMessage = 'Groq API key is not configured. Please add GROQ_API_KEY to your .env file.';
    } else if (error.status === 429 || error.message?.includes('quota') || error.message?.includes('billing')) {
      statusCode = 429;
      errorMessage = 'Groq API quota exceeded. Please check your Groq account billing and add credits.';
    } else if (error.message?.includes('Contact not found')) {
      statusCode = 404;
      errorMessage = 'Contact not found';
    } else if (error.message) {
      errorMessage = error.message;
    }

    res.status(statusCode).json({
      success: false,
      error: errorMessage
    });
  }
});

/**
 * Generate personalized LinkedIn message
 * POST /api/ai/generate-linkedin
 * Body: { contactId, projectId, baseTemplate? }
 */
router.post('/generate-linkedin', authenticate, async (req, res) => {
  try {
    const { contactId, projectId, baseTemplate } = req.body;

    if (!contactId) {
      return res.status(400).json({
        success: false,
        error: 'Contact ID is required'
      });
    }

    if (!projectId) {
      return res.status(400).json({
        success: false,
        error: 'Project ID is required'
      });
    }

    // Generate personalized LinkedIn message
    const result = await generatePersonalizedLinkedInMessage(contactId, projectId, baseTemplate);

    res.json({
      success: true,
      data: {
        linkedInMessage: result.linkedInMessage,
        contactInfo: result.contactInfo
      }
    });
  } catch (error) {
    console.error('Error generating LinkedIn message:', error);
    
    let errorMessage = 'Failed to generate personalized LinkedIn message';
    let statusCode = 500;

    if (error.message?.includes('API key') || error.message?.includes('Groq API key')) {
      statusCode = 500;
      errorMessage = 'Groq API key is not configured. Please add GROQ_API_KEY to your .env file.';
    } else if (error.status === 429 || error.message?.includes('quota') || error.message?.includes('billing')) {
      statusCode = 429;
      errorMessage = 'Groq API quota exceeded. Please check your Groq account billing and add credits.';
    } else if (error.message?.includes('Contact not found')) {
      statusCode = 404;
      errorMessage = 'Contact not found';
    } else if (error.message) {
      errorMessage = error.message;
    }

    res.status(statusCode).json({
      success: false,
      error: errorMessage
    });
  }
});

module.exports = router;
