const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { connectDB } = require('./db/connection');

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

// Lightweight health check endpoint (for Render uptime pings)
// Returns immediately without checking database
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// MongoDB connection - start in background (non-blocking)
// Server will start even if DB connection is still establishing
connectDB();

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/import', require('./routes/import'));
app.use('/api/linkedin', require('./routes/linkedin'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/master-dashboard', require('./routes/master-dashboard'));
app.use('/api/company-analysis', require('./routes/company-analysis'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/activities', require('./routes/activities'));

// Detailed health check endpoint (includes database status)
app.get('/api/health', (req, res) => {
  const { isDBConnected } = require('./db/connection');
  res.json({ 
    status: 'OK',
    database: isDBConnected() ? 'Connected' : 'Disconnected'
  });
});

module.exports = app;
