const mongoose = require('mongoose');

const projectSchema = new mongoose.Schema({
  // Step 1: Company Details
  companyName: {
    type: String,
    required: true,
    trim: true
  },
  website: {
    type: String,
    default: '',
    trim: true
  },
  city: {
    type: String,
    default: '',
    trim: true
  },
  country: {
    type: String,
    default: '',
    trim: true
  },
  industry: {
    type: String,
    default: '',
    trim: true
  },
  companySize: {
    type: String,
    default: '',
    trim: true
  },
  companyDescription: {
    type: String,
    default: '',
    trim: true
  },

  // Step 2: Contact Person
  contactPerson: {
    fullName: {
      type: String,
      required: true,
      trim: true
    },
    designation: {
      type: String,
      default: '',
      trim: true
    },
    email: {
      type: String,
      default: '',
      trim: true
    },
    phoneNumber: {
      type: String,
      default: '',
      trim: true
    },
    linkedInProfileUrl: {
      type: String,
      default: '',
      trim: true
    }
  },

  // Step 3: Campaign Details
  campaignDetails: {
    servicesOffered: {
      leadGeneration: {
        type: Boolean,
        default: false
      },
      marketResearch: {
        type: Boolean,
        default: false
      },
      appointmentSetting: {
        type: Boolean,
        default: false
      },
      dataEnrichment: {
        type: Boolean,
        default: false
      }
    },
    expectationsFromUs: {
      type: String,
      default: '',
      trim: true
    },
    leadQuotaCommitted: {
      type: Number,
      default: 0
    },
    startDate: {
      type: Date,
      default: null
    },
    endDate: {
      type: Date,
      default: null
    }
  },

  // Step 4: Channels
  channels: {
    linkedInOutreach: {
      type: Boolean,
      default: false
    },
    coldEmail: {
      type: Boolean,
      default: false
    },
    coldCalling: {
      type: Boolean,
      default: false
    }
  },

  // Step 5: ICP Definition
  icpDefinition: {
    targetIndustries: {
      type: [String],
      default: []
    },
    targetJobTitles: {
      type: [String],
      default: []
    },
    companySizeMin: {
      type: Number,
      default: 0
    },
    companySizeMax: {
      type: Number,
      default: 1000
    },
    geographies: {
      type: [String],
      default: []
    },
    keywords: {
      type: [String],
      default: []
    },
    exclusionCriteria: {
      type: [String],
      default: []
    }
  },

  // Step 6: Team Allocation
  assignedTo: {
    type: String,
    default: '',
    trim: true
  },
  teamAllocation: {
    note: {
      type: String,
      default: 'Team assignments can be configured after project creation'
    }
  },

  // Metadata
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  status: {
    type: String,
    enum: ['draft', 'active', 'completed', 'archived'],
    default: 'draft'
  }
}, {
  timestamps: true
});

// Indexes for better query performance
projectSchema.index({ companyName: 1 });
projectSchema.index({ 'contactPerson.email': 1 });
projectSchema.index({ status: 1 });
projectSchema.index({ createdAt: -1 });
projectSchema.index({ createdBy: 1 });

module.exports = mongoose.model('Project', projectSchema);
