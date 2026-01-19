const mongoose = require('mongoose');

let isConnected = false;
let connectionPromise = null;

/**
 * Initialize MongoDB connection in the background
 * Returns a promise that resolves when connected, but doesn't block server startup
 */
function connectDB() {
  // Return existing connection promise if already connecting
  if (connectionPromise) {
    return connectionPromise;
  }

  const MONGODB_URI = process.env.MONGODB_URI;
  
  if (!MONGODB_URI) {
    console.warn('⚠️ MONGODB_URI not set. Database operations will fail.');
    connectionPromise = Promise.resolve(null);
    return connectionPromise;
  }

  // Connection options optimized for Render free tier
  const mongooseOptions = {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    connectTimeoutMS: 10000,
    maxPoolSize: 10,
    minPoolSize: 1, // Reduced for free tier
    maxIdleTimeMS: 30000,
    retryWrites: true,
    retryReads: true,
  };

  // Start connection in background (non-blocking)
  connectionPromise = mongoose.connect(MONGODB_URI, mongooseOptions)
    .then(() => {
      isConnected = true;
      console.log('✅ MongoDB Atlas connected successfully');
      
      // Handle connection events
      mongoose.connection.on('error', (err) => {
        console.error('❌ MongoDB connection error:', err.message);
        isConnected = false;
      });
      
      mongoose.connection.on('disconnected', () => {
        console.warn('⚠️ MongoDB disconnected. Attempting to reconnect...');
        isConnected = false;
      });
      
      mongoose.connection.on('reconnected', () => {
        console.log('✅ MongoDB reconnected successfully');
        isConnected = true;
      });
      
      mongoose.connection.on('close', () => {
        console.warn('⚠️ MongoDB connection closed');
        isConnected = false;
      });

      return mongoose.connection;
    })
    .catch((err) => {
      console.error('❌ MongoDB connection error:', err.message);
      console.log('💡 Make sure to set MONGODB_URI in your .env file');
      isConnected = false;
      // Don't throw - allow server to start even if DB fails
      return null;
    });

  return connectionPromise;
}

/**
 * Get connection status (non-blocking)
 */
function isDBConnected() {
  return isConnected && mongoose.connection.readyState === 1;
}

/**
 * Get connection promise (for routes that need to wait for DB)
 */
function getConnectionPromise() {
  return connectionPromise || connectDB();
}

module.exports = {
  connectDB,
  isDBConnected,
  getConnectionPromise,
  connection: mongoose.connection
};
