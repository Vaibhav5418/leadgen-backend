const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const compression = require('compression');

const app = express();

// Enable compression for all responses
app.use(compression());

// Middleware
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// Allow both production and preview Vercel URLs
const allowedOrigins = [
  FRONTEND_URL,
  'http://localhost:5173',
  /^https:\/\/.*\.vercel\.app$/, // Allow all Vercel preview URLs
  'https://leadgen-frontend-kappa.vercel.app' // Production URL
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // Check if origin matches any allowed origin
    const isAllowed = allowedOrigins.some(allowed => {
      if (typeof allowed === 'string') {
        return origin === allowed;
      } else if (allowed instanceof RegExp) {
        return allowed.test(origin);
      }
      return false;
    });
    
    if (isAllowed) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// MongoDB Atlas Connection
const MONGODB_URI = process.env.MONGODB_URI;

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB Atlas connected successfully'))
  .catch((err) => {
    console.error('❌ MongoDB connection error:', err.message);
    console.log('💡 Make sure to set MONGODB_URI in your .env file');
  });

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/import', require('./routes/import'));
app.use('/api/linkedin', require('./routes/linkedin'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/company-analysis', require('./routes/company-analysis'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/activities', require('./routes/activities'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK',
    database: mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected'
  });
});

module.exports = app;
