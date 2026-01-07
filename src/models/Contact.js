const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema({
  // Basic Information
  name: {
    type: String,
    required: true
  },
  title: {
    type: String,
    default: ''
  },
  company: {
    type: String,
    default: ''
  },
  email: {
    type: String,
    default: ''
  },
  firstPhone: {
    type: String,
    default: ''
  },
  employees: {
    type: String,
    default: ''
  },
  category: {
    type: String,
    default: ''
  },
  industry: {
    type: String,
    default: ''
  },
  keywords: {
    type: String,
    default: ''
  },
  
  // LinkedIn & Social Media
  personLinkedinUrl: {
    type: String,
    default: ''
  },
  companyLinkedinUrl: {
    type: String,
    default: ''
  },
  website: {
    type: String,
    default: ''
  },
  facebookUrl: {
    type: String,
    default: ''
  },
  twitterUrl: {
    type: String,
    default: ''
  },
  
  // Location
  city: {
    type: String,
    default: ''
  },
  state: {
    type: String,
    default: ''
  },
  country: {
    type: String,
    default: ''
  },
  
  // Company Details
  companyAddress: {
    type: String,
    default: ''
  },
  companyCity: {
    type: String,
    default: ''
  },
  companyState: {
    type: String,
    default: ''
  },
  companyCountry: {
    type: String,
    default: ''
  },
  companyPhone: {
    type: String,
    default: ''
  },
  
  // Additional Information
  seoDescription: {
    type: String,
    default: ''
  },
  technologies: {
    type: String,
    default: ''
  },
  annualRevenue: {
    type: String,
    default: ''
  },
  
  // LinkedIn Data
  linkedinData: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  lastLinkedInFetch: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Index for faster searches
contactSchema.index({ name: 1 });
contactSchema.index({ email: 1 });

module.exports = mongoose.model('Contact', contactSchema);
