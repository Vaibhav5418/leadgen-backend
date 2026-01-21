require('dotenv').config();   // FIRST LINE
const app = require('./src/app.js');
const cron = require('node-cron');
const axios = require('axios');

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  
  // Keep-alive ping: ping /health every 5 minutes
  const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;
  const healthUrl = `${SERVER_URL}/health`;
  
  // Schedule cron job: every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    try {
      await axios.get(healthUrl);
      console.log('Keep-alive ping sent');
    } catch (error) {
      console.log('Keep-alive ping failed');
    }
  });
  
  // Send initial ping on startup
  axios.get(healthUrl)
    .then(() => console.log('Keep-alive ping sent'))
    .catch(() => console.log('Keep-alive ping failed'));
});
