const mongoose = require('mongoose');

const activitySchema = new mongoose.Schema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true
  },
  contactId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Contact',
    required: false,
    default: null
  },
  type: {
    type: String,
    enum: ['call', 'email', 'linkedin'],
    required: true
  },
  template: {
    type: String,
    default: ''
  },
  outcome: {
    type: String,
    required: true,
    trim: true
  },
  conversationNotes: {
    type: String,
    required: false,
    trim: true,
    default: ''
  },
  nextAction: {
    type: String,
    required: true,
    trim: true
  },
  nextActionDate: {
    type: Date,
    required: true
  },
  phoneNumber: {
    type: String,
    required: false,
    default: null,
    trim: true
  },
  email: {
    type: String,
    required: false,
    default: null,
    trim: true
  },
  linkedInUrl: {
    type: String,
    required: false,
    default: null,
    trim: true
  },
  status: {
    type: String,
    required: false,
    enum: [
      'CIP',
      'No Reply',
      'Not Interested',
      'Meeting Proposed',
      'Meeting Scheduled',
      'In-Person Meeting',
      'Meeting Completed',
      'SQL',
      'Tech Discussion',
      'WON',
      'Lost',
      'Low Potential - Open',
      'Potential Future'
    ],
    default: null
  },
  linkedInAccountName: {
    type: String,
    required: false,
    trim: true,
    default: null
  },
  lnRequestSent: {
    type: String,
    required: false,
    enum: [
      'Yes',
      'No',
      'Existing Connect',
      'Inactive Profile',
      'Irrelevant Profile',
      'Open to Work'
    ],
    default: null
  },
  connected: {
    type: String,
    required: false,
    enum: ['Yes', 'No'],
    default: null
  },
  callNumber: {
    type: String,
    required: false,
    enum: ['1st call', '2nd call', '3rd call'],
    default: null
  },
  callStatus: {
    type: String,
    required: false,
    enum: [
      'Interested',
      'Not Interested',
      'Ring',
      'Busy',
      'Call Back',
      'Hang Up',
      'Switch Off',
      'Future',
      'Details Shared',
      'Demo Booked',
      'Invalid',
      'Existing',
      'Demo Completed'
    ],
    default: null
  },
  callDate: {
    type: Date,
    required: false,
    default: null
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

// Indexes for better query performance
activitySchema.index({ projectId: 1, createdAt: -1 }); // Compound index for project activities query
activitySchema.index({ contactId: 1, createdAt: -1 }); // Compound index for contact activities query
activitySchema.index({ projectId: 1, contactId: 1, nextActionDate: 1 }); // Compound index for next action queries
activitySchema.index({ contactId: 1 });
activitySchema.index({ type: 1 });
activitySchema.index({ createdAt: -1 });
activitySchema.index({ createdBy: 1 });
activitySchema.index({ nextActionDate: 1 }); // Index for next action date filtering

module.exports = mongoose.model('Activity', activitySchema);
