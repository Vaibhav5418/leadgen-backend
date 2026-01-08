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

// Indexes for faster searches
contactSchema.index({ name: 1 });
contactSchema.index({ email: 1 });
contactSchema.index({ category: 1 });
contactSchema.index({ company: 1 });
contactSchema.index({ company: 1, category: 1 }); // Compound index for common queries
contactSchema.index({ category: 1, company: 1 }); // Reverse compound index
contactSchema.index({ city: 1 });
contactSchema.index({ state: 1 });
contactSchema.index({ country: 1 });
contactSchema.index({ createdAt: 1 }); // For dashboard date range queries
contactSchema.index({ industry: 1 }); // For industry aggregations
contactSchema.index({ industry: 1, createdAt: 1 }); // Compound index for industry growth queries
contactSchema.index({ updatedAt: 1 }); // For recent activity queries
contactSchema.index({ personLinkedinUrl: 1 }); // For LinkedIn enrichment queries
contactSchema.index({ companyLinkedinUrl: 1 }); // For LinkedIn enrichment queries
contactSchema.index({ lastLinkedInFetch: 1 }); // For stale enrichment queries
contactSchema.index({ title: 1 }); // For title-based queries
contactSchema.index({ firstPhone: 1 }); // For phone validation queries
contactSchema.index({ email: 1, title: 1, company: 1 }); // Compound index for outreach ready queries
contactSchema.index({ state: 1, country: 1 }); // Compound index for geographic queries

module.exports = mongoose.model('Contact', contactSchema);
