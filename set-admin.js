const mongoose = require('mongoose');
const User = require('./src/models/User');
require('dotenv').config();

async function setAdmin() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/leadgen-crm';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    // Find and update the admin user
    const adminEmail = 'akshay@kology.co';
    const result = await User.findOneAndUpdate(
      { email: adminEmail },
      { $set: { isAdmin: true } },
      { new: true, upsert: false }
    );

    if (result) {
      console.log(`Successfully set ${adminEmail} as admin`);
    } else {
      console.log(`User ${adminEmail} not found. Please create the user first.`);
    }

    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  } catch (error) {
    console.error('Error setting admin:', error);
    process.exit(1);
  }
}

setAdmin();

