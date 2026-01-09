const mongoose = require('mongoose');

const projectContactSchema = new mongoose.Schema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true,
    index: true
  },
  contactId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Contact',
    required: true,
    index: true
  },
  stage: {
    type: String,
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
      'Potential Future',
      // Legacy stages for backward compatibility
      'New',
      'Contacted',
      'Qualified',
      'Proposal',
      'Negotiation'
    ],
    default: 'New'
  },
  assignedTo: {
    type: String,
    default: ''
  },
  priority: {
    type: String,
    enum: ['High', 'Medium', 'Low'],
    default: 'Medium'
  },
  importedAt: {
    type: Date,
    default: Date.now
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

// Compound index to prevent duplicate project-contact pairs
projectContactSchema.index({ projectId: 1, contactId: 1 }, { unique: true });

// Index for filtering by stage
projectContactSchema.index({ projectId: 1, stage: 1 });

// Index for filtering by assignedTo
projectContactSchema.index({ projectId: 1, assignedTo: 1 });

module.exports = mongoose.model('ProjectContact', projectContactSchema);
