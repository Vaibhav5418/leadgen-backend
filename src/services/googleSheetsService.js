const { google } = require('googleapis');

function getServiceAccountCredentials() {
  // Option A: full JSON in env (recommended for Render/Vercel style deploys)
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      const parsed = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      return {
        client_email: parsed.client_email,
        private_key: parsed.private_key
      };
    } catch (e) {
      throw new Error('Invalid GOOGLE_SERVICE_ACCOUNT_JSON (must be valid JSON)');
    }
  }

  // Option B: split env vars
  const client_email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const private_key = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (client_email && private_key) {
    return { client_email, private_key };
  }

  throw new Error(
    'Google Sheets credentials not configured. Set GOOGLE_SERVICE_ACCOUNT_JSON or (GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY).'
  );
}

function getSheetsClient() {
  const { client_email, private_key } = getServiceAccountCredentials();
  if (!client_email || !private_key) {
    throw new Error('Google service account credentials missing client_email/private_key');
  }

  const auth = new google.auth.JWT({
    email: client_email,
    key: String(private_key).replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  return google.sheets({ version: 'v4', auth });
}

async function appendEmailRowToSheet({ spreadsheetId, sheetName, to, subject, body }) {
  if (!spreadsheetId) throw new Error('Missing spreadsheetId');
  if (!sheetName) throw new Error('Missing sheetName');

  const sheets = getSheetsClient();

  const values = [[to || '', subject || '', body || '']];

  // Append to first 3 columns (A:C). Assumes your sheet has headers like:
  // A: To, B: Subject, C: Body
  const range = `${sheetName}!A:C`;

  const res = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values }
  });

  return res.data;
}

module.exports = {
  appendEmailRowToSheet
};

