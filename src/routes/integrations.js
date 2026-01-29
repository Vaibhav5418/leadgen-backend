const express = require('express');
const authenticate = require('../middleware/auth');
const { appendEmailRowToSheet } = require('../services/googleSheetsService');

const router = express.Router();

/**
 * Append email row to Google Sheet
 * POST /api/integrations/google-sheets/email
 * Body: { to, subject, body, projectId?, contactId? }
 */
router.post('/google-sheets/email', authenticate, async (req, res) => {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    const sheetName = process.env.GOOGLE_SHEETS_SHEET_NAME || 'Sheet1';

    if (!spreadsheetId) {
      return res.status(500).json({
        success: false,
        error: 'GOOGLE_SHEETS_SPREADSHEET_ID is not configured on the server'
      });
    }

    const { to, subject, body } = req.body || {};

    if (!to || String(to).trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Prospect email (To) is required'
      });
    }

    const result = await appendEmailRowToSheet({
      spreadsheetId,
      sheetName,
      to: String(to).trim(),
      subject: subject || '',
      body: body || ''
    });

    return res.json({
      success: true,
      data: {
        updatedRange: result.updates?.updatedRange || null
      }
    });
  } catch (error) {
    console.error('Error appending email to Google Sheet:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to write email to Google Sheet'
    });
  }
});

module.exports = router;

