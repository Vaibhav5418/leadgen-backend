const mongoose = require('mongoose');

const activitySchema = new mongoose.Schema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true
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
    required: true,
    trim: true,
    minlength: 50
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
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

// Indexes for better query performance
activitySchema.index({ projectId: 1 });
activitySchema.index({ type: 1 });
activitySchema.index({ createdAt: -1 });
activitySchema.index({ createdBy: 1 });

module.exports = mongoose.model('Activity', activitySchema);
