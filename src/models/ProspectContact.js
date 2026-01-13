const mongoose = require('mongoose');

const prospectContactSchema = new mongoose.Schema({
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
prospectContactSchema.index({ name: 1 });
prospectContactSchema.index({ email: 1 });
prospectContactSchema.index({ category: 1 });
prospectContactSchema.index({ company: 1 });
prospectContactSchema.index({ company: 1, category: 1 }); // Compound index for common queries
prospectContactSchema.index({ category: 1, company: 1 }); // Reverse compound index
prospectContactSchema.index({ city: 1 });
prospectContactSchema.index({ state: 1 });
prospectContactSchema.index({ country: 1 });
prospectContactSchema.index({ createdAt: 1 }); // For dashboard date range queries
prospectContactSchema.index({ industry: 1 }); // For industry aggregations
prospectContactSchema.index({ industry: 1, createdAt: 1 }); // Compound index for industry growth queries
prospectContactSchema.index({ updatedAt: 1 }); // For recent activity queries
prospectContactSchema.index({ personLinkedinUrl: 1 }); // For LinkedIn enrichment queries
prospectContactSchema.index({ companyLinkedinUrl: 1 }); // For LinkedIn enrichment queries
prospectContactSchema.index({ lastLinkedInFetch: 1 }); // For stale enrichment queries
prospectContactSchema.index({ title: 1 }); // For title-based queries
prospectContactSchema.index({ firstPhone: 1 }); // For phone validation queries
prospectContactSchema.index({ email: 1, title: 1, company: 1 }); // Compound index for outreach ready queries
prospectContactSchema.index({ state: 1, country: 1 }); // Compound index for geographic queries
prospectContactSchema.index({ industry: 1, title: 1 }); // Compound index for ICP matching
prospectContactSchema.index({ keywords: 1 }); // Index for keyword searches

module.exports = mongoose.model('ProspectContact', prospectContactSchema);
