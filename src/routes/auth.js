const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = require('../models/User');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Helper to check database connection
const checkDatabaseConnection = () => {
  return mongoose.connection.readyState === 1;
};

// Register new user
router.post('/register', async (req, res) => {
  try {
    console.log('=== Register Request ===');
    console.log('Request body:', req.body);
    
    // Check database connection
    if (!checkDatabaseConnection()) {
      console.error('Database not connected');
      return res.status(503).json({
        success: false,
        error: 'Database connection not available. Please try again later.'
      });
    }
    
    const { email, password, name } = req.body;

    // Validation
    if (!email || !email.trim()) {
      console.log('Validation failed: Email is required');
      return res.status(400).json({
        success: false,
        error: 'Email is required'
      });
    }

    if (!password || !password.trim()) {
      console.log('Validation failed: Password is required');
      return res.status(400).json({
        success: false,
        error: 'Password is required'
      });
    }

    if (password.length < 6) {
      console.log('Validation failed: Password too short');
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 6 characters long'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      console.log('Validation failed: Invalid email format');
      return res.status(400).json({
        success: false,
        error: 'Please provide a valid email address'
      });
    }

    // Check if user already exists
    console.log('Checking for existing user...');
    const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
    if (existingUser) {
      console.log('User already exists:', existingUser.email);
      return res.status(409).json({
        success: false,
        error: 'User with this email already exists'
      });
    }

    // Create new user
    const userData = {
      email: email.toLowerCase().trim(),
      password: password.trim()
    };

    // Add name if provided, otherwise use email prefix
    if (name && name.trim()) {
      userData.name = name.trim();
    } else {
      userData.name = email.split('@')[0];
    }

    console.log('Creating user with data:', { ...userData, password: '***' });
    const user = await User.create(userData);
    console.log('User created successfully:', user.email);

    // Generate JWT token
    const token = jwt.sign(
      { userId: user._id, email: user.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log('Registration successful, sending response...');
    res.status(201).json({
      success: true,
      data: {
        user: {
          id: user._id,
          email: user.email,
          name: user.name
        },
        token
      }
    });
  } catch (error) {
    console.error('=== Registration Error ===');
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    console.error('Error code:', error.code);
    console.error('Full error:', error);
    
    // Handle MongoDB duplicate key error
    if (error.code === 11000) {
      console.log('Duplicate key error detected');
      return res.status(409).json({
        success: false,
        error: 'User with this email already exists'
      });
    }

    // Handle validation errors
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      console.log('Validation error:', messages);
      return res.status(400).json({
        success: false,
        error: messages.join(', ')
      });
    }

    // Handle connection errors
    if (error.name === 'MongoServerError' || error.message?.includes('Mongo')) {
      console.error('MongoDB connection error');
      return res.status(500).json({
        success: false,
        error: 'Database connection error. Please try again later.'
      });
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to register user'
    });
  }
});

// Login user
router.post('/login', async (req, res) => {
  try {
    console.log('=== Login Request ===');
    console.log('Request body:', { email: req.body?.email, password: '***' });
    
    // Check database connection
    if (!checkDatabaseConnection()) {
      console.error('Database not connected');
      return res.status(503).json({
        success: false,
        error: 'Database connection not available. Please try again later.'
      });
    }
    
    const { email, password } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required'
      });
    }

    // Normalize email (lowercase and trim)
    const normalizedEmail = email.toLowerCase().trim();

    // Find user by email
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      console.log(`Login failed: User not found for email: ${normalizedEmail}`);
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    // Check password
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      console.log(`Login failed: Invalid password for email: ${normalizedEmail}`);
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    console.log(`Login successful for: ${normalizedEmail}`);

    // Generate JWT token
    const token = jwt.sign(
      { userId: user._id, email: user.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      data: {
        user: {
          id: user._id,
          email: user.email,
          name: user.name
        },
        token
      }
    });
  } catch (error) {
    console.error('=== Login Error ===');
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    console.error('Full error:', error);
    
    // Handle database errors
    if (error.name === 'MongoServerError' || error.message?.includes('Mongo')) {
      return res.status(500).json({
        success: false,
        error: 'Database connection error. Please try again later.'
      });
    }
    
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to login'
    });
  }
});

// Request password reset
router.post('/request-password-reset', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !email.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Email is required'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a valid email address'
      });
    }

    // Check database connection
    if (!checkDatabaseConnection()) {
      return res.status(503).json({
        success: false,
        error: 'Database connection not available. Please try again later.'
      });
    }

    // Find user by email
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    
    // Always return success to prevent email enumeration
    // In production, you would send an email with a reset token here
    if (user) {
      // TODO: In production, send email with reset token
      // For now, we'll allow direct password reset
      console.log(`Password reset requested for: ${email}`);
    }

    res.json({
      success: true,
      message: 'If an account exists with this email, you will receive password reset instructions.'
    });
  } catch (error) {
    console.error('Password reset request error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to process password reset request'
    });
  }
});

// Reset password
router.post('/reset-password', async (req, res) => {
  try {
    const { email, newPassword } = req.body;

    if (!email || !email.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Email is required'
      });
    }

    if (!newPassword || !newPassword.trim()) {
      return res.status(400).json({
        success: false,
        error: 'New password is required'
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 6 characters long'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a valid email address'
      });
    }

    // Check database connection
    if (!checkDatabaseConnection()) {
      return res.status(503).json({
        success: false,
        error: 'Database connection not available. Please try again later.'
      });
    }

    // Find user by email
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Update password - assign directly and save
    // The pre-save hook will automatically hash it
    user.password = newPassword.trim();
    
    // Save the user - this will trigger the pre-save hook to hash the password
    await user.save();

    console.log(`Password reset successful for: ${email}`);

    res.json({
      success: true,
      message: 'Password has been reset successfully'
    });
  } catch (error) {
    console.error('Password reset error:', error);
    
    // Handle validation errors
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        error: messages.join(', ')
      });
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to reset password'
    });
  }
});

// Get current user (protected route)
router.get('/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'No token provided'
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.userId).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    res.json({
      success: true,
      data: {
        user: {
          id: user._id,
          email: user.email,
          name: user.name
        }
      }
    });
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired token'
      });
    }
    
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get user'
    });
  }
});

module.exports = router;
