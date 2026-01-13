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

// Connection options to handle reconnection and prevent ECONNRESET errors
const mongooseOptions = {
  serverSelectionTimeoutMS: 5000, // Timeout after 5s instead of 30s
  socketTimeoutMS: 45000, // Close sockets after 45s of inactivity
  connectTimeoutMS: 10000, // Give up initial connection after 10s
  maxPoolSize: 10, // Maintain up to 10 socket connections
  minPoolSize: 2, // Maintain at least 2 socket connections
  maxIdleTimeMS: 30000, // Close connections after 30s of inactivity
  retryWrites: true, // Retry write operations on network errors
  retryReads: true, // Retry read operations on network errors
};

mongoose.connect(MONGODB_URI, mongooseOptions)
  .then(() => {
    console.log('✅ MongoDB Atlas connected successfully');
    
    // Handle connection events
    mongoose.connection.on('error', (err) => {
      console.error('❌ MongoDB connection error:', err.message);
    });
    
    mongoose.connection.on('disconnected', () => {
      console.warn('⚠️ MongoDB disconnected. Attempting to reconnect...');
    });
    
    mongoose.connection.on('reconnected', () => {
      console.log('✅ MongoDB reconnected successfully');
    });
    
    mongoose.connection.on('close', () => {
      console.warn('⚠️ MongoDB connection closed');
    });
  })
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
