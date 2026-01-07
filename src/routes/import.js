const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const Contact = require('../models/Contact');

const router = express.Router();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../../uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.xlsx', '.xls', '.csv'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only Excel (.xlsx, .xls) and CSV files are allowed.'));
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});

// Helper function to normalize column names
function normalizeColumnName(name) {
  if (!name) return '';
  return name.trim().toLowerCase()
    .replace(/#/g, '')
    .replace(/\s+/g, '')
    .replace(/[_-]/g, '')
    .replace(/linkedin/g, 'linkedin')
    .replace(/url/g, 'url')
    .replace(/phone/g, 'phone')
    .replace(/mobile/g, 'phone')
    .replace(/contact/g, 'phone')
    .replace(/number/g, 'phone')
    .replace(/tel/g, 'phone');
}

// Map normalized column names to our schema fields (with multiple variations)
const columnMapping = {
  // Name variations
  'name': 'name',
  'fullname': 'name',
  'contactname': 'name',
  'personname': 'name',
  
  // Title variations
  'title': 'title',
  'jobtitle': 'title',
  'position': 'title',
  'designation': 'title',
  'role': 'title',
  
  // Company variations
  'company': 'company',
  'companyname': 'company',
  'organization': 'company',
  'org': 'company',
  
  // Email variations
  'email': 'email',
  'emailaddress': 'email',
  'e-mail': 'email',
  'mail': 'email',
  
  // Phone variations
  'firstphone': 'firstPhone',
  'phone': 'firstPhone',
  'phonenumber': 'firstPhone',
  'contactnumber': 'firstPhone',
  'mobilenumber': 'firstPhone',
  'mobile': 'firstPhone',
  'telephone': 'firstPhone',
  'tel': 'firstPhone',
  'contact': 'firstPhone',
  
  // Employees variations
  'employees': 'employees',
  'noofemployees': 'employees',
  'numberofemployees': 'employees',
  'employee': 'employees',
  'emp': 'employees',
  
  // Category
  'category': 'category',
  'cat': 'category',
  
  // Industry
  'industry': 'industry',
  'sector': 'industry',
  
  // Keywords
  'keywords': 'keywords',
  'keyword': 'keywords',
  'tags': 'keywords',
  
  // LinkedIn URLs
  'personlinkedinurl': 'personLinkedinUrl',
  'personlinkedin': 'personLinkedinUrl',
  'linkedinurl': 'personLinkedinUrl',
  'linkedin': 'personLinkedinUrl',
  'personlinkedinprofile': 'personLinkedinUrl',
  
  // Website
  'website': 'website',
  'web': 'website',
  'url': 'website',
  'websiteurl': 'website',
  
  // Company LinkedIn
  'companylinkedinurl': 'companyLinkedinUrl',
  'companylinkedin': 'companyLinkedinUrl',
  'companylinkedinprofile': 'companyLinkedinUrl',
  
  // Social Media
  'facebookurl': 'facebookUrl',
  'facebook': 'facebookUrl',
  'fb': 'facebookUrl',
  'twitterurl': 'twitterUrl',
  'twitter': 'twitterUrl',
  'x': 'twitterUrl',
  
  // Location
  'city': 'city',
  'personcity': 'city',
  'state': 'state',
  'personstate': 'state',
  'province': 'state',
  'country': 'country',
  'personcountry': 'country',
  
  // Company Address
  'companyaddress': 'companyAddress',
  'address': 'companyAddress',
  'companyaddr': 'companyAddress',
  'companycity': 'companyCity',
  'companystate': 'companyState',
  'companycountry': 'companyCountry',
  'companyphone': 'companyPhone',
  'companyphonenumber': 'companyPhone',
  
  // Additional fields
  'seodescription': 'seoDescription',
  'description': 'seoDescription',
  'about': 'seoDescription',
  'companydescription': 'seoDescription',
  'technologies': 'technologies',
  'tech': 'technologies',
  'technology': 'technologies',
  'annualrevenue': 'annualRevenue',
  'revenue': 'annualRevenue',
  'annualrevenue': 'annualRevenue'
};

// Function to find the best matching field for a column name
function findMatchingField(columnName) {
  const normalized = normalizeColumnName(columnName);
  
  // Direct match
  if (columnMapping[normalized]) {
    return columnMapping[normalized];
  }
  
  // Partial match - check if normalized column contains any key
  for (const [key, field] of Object.entries(columnMapping)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return field;
    }
  }
  
  return null;
}

// Parse Excel file
function parseExcel(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(worksheet);
  return data;
}

// Parse CSV file
function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    const csv = require('csv-parser');
    const stream = fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', reject);
  });
}

// Transform row data to match our schema
function transformRow(row, columnMappingReport = null) {
  const contact = {};
  
  // Process each column
  Object.keys(row).forEach(key => {
    const mappedField = findMatchingField(key);
    
    if (mappedField) {
      const value = row[key];
      // Handle empty values
      if (value !== undefined && value !== null && value !== '') {
        contact[mappedField] = String(value).trim();
      }
      
      // Track mapping for reporting
      if (columnMappingReport) {
        if (!columnMappingReport.mapped[key]) {
          columnMappingReport.mapped[key] = mappedField;
        }
      }
    } else {
      // Track unmapped columns
      if (columnMappingReport) {
        columnMappingReport.unmapped.add(key);
      }
    }
  });
  
  return contact;
}

// Import route
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded'
      });
    }

    const categoryFromRequest = req.body?.category || 'IND-IT & Service';

    const filePath = req.file.path;
    const fileExt = path.extname(req.file.originalname).toLowerCase();
    
    let rows = [];
    
    // Parse file based on extension
    if (fileExt === '.csv') {
      rows = await parseCSV(filePath);
    } else if (fileExt === '.xlsx' || fileExt === '.xls') {
      rows = parseExcel(filePath);
    } else {
      // Clean up file
      fs.unlinkSync(filePath);
      return res.status(400).json({
        success: false,
        error: 'Unsupported file format'
      });
    }

    if (!rows || rows.length === 0) {
      fs.unlinkSync(filePath);
      return res.status(400).json({
        success: false,
        error: 'File is empty or could not be parsed'
      });
    }

    // Detect columns in the file
    const detectedColumns = rows.length > 0 ? Object.keys(rows[0]) : [];
    
    // Track column mapping for reporting
    const columnMappingReport = {
      mapped: {},
      unmapped: new Set()
    };

    // Transform and validate rows
    const contacts = [];
    const errors = [];
    
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const contact = transformRow(row, columnMappingReport);
      
      // Always use the category from the request (selected category)
      // This ensures all imported data is stored in the selected category
      contact.category = categoryFromRequest;

      // Only add if name exists
      if (contact.name && contact.name.trim() !== '') {
        contacts.push(contact);
      } else {
        errors.push(`Row ${i + 2}: Missing name field`);
      }
    }

    if (contacts.length === 0) {
      fs.unlinkSync(filePath);
      return res.status(400).json({
        success: false,
        error: 'No valid contacts found in file. Make sure the file has a "Name" column.'
      });
    }

    // Helper function to check for duplicates
    async function checkDuplicate(contactData) {
      const { name, email, company } = contactData;
      
      // Normalize values for comparison
      const normalizedName = name ? name.trim().toLowerCase() : '';
      const normalizedEmail = email ? email.toLowerCase().trim() : '';
      const normalizedCompany = company ? company.trim().toLowerCase() : '';
      
      // Primary check: Name + Email combination (most reliable)
      // This allows same email for different people but prevents exact duplicates
      if (normalizedName && normalizedEmail) {
        const duplicateByNameEmail = await Contact.findOne({
          name: { $regex: new RegExp(`^${normalizedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
          email: { $regex: new RegExp(`^${normalizedEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
        });
        if (duplicateByNameEmail) {
          return {
            isDuplicate: true,
            reason: `Name "${name}" and email "${email}" combination already exists`
          };
        }
      }
      
      // Secondary check: Name + Company combination (for cases where email might be shared)
      // Only check if email is not provided or is empty
      if (normalizedName && normalizedCompany && !normalizedEmail) {
        const duplicateByNameCompany = await Contact.findOne({
          name: { $regex: new RegExp(`^${normalizedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
          company: { $regex: new RegExp(`^${normalizedCompany.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
        });
        if (duplicateByNameCompany) {
          return {
            isDuplicate: true,
            reason: `Name "${name}" and company "${company}" combination already exists`
          };
        }
      }
      
      // Tertiary check: Exact name match (only if no email and no company)
      // This is less strict but helps catch obvious duplicates
      if (normalizedName && !normalizedEmail && !normalizedCompany) {
        const duplicateByName = await Contact.findOne({
          name: { $regex: new RegExp(`^${normalizedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
          email: { $in: ['', null] },
          company: { $in: ['', null] }
        });
        if (duplicateByName) {
          return {
            isDuplicate: true,
            reason: `Name "${name}" already exists (no email or company provided)`
          };
        }
      }
      
      return { isDuplicate: false };
    }

    // Insert contacts into database (skip duplicates)
    const results = {
      inserted: 0,
      skipped: 0,
      errors: []
    };

    for (let i = 0; i < contacts.length; i++) {
      const contactData = contacts[i];
      try {
        const duplicateCheck = await checkDuplicate(contactData);
        
        if (duplicateCheck.isDuplicate) {
          results.skipped++;
          results.errors.push(`Row ${i + 2}: Skipped - ${duplicateCheck.reason} (${contactData.name || 'Unknown'})`);
        } else {
          // Insert new contact
          await Contact.create(contactData);
          results.inserted++;
        }
      } catch (error) {
        results.errors.push(`Row ${i + 2}: Error processing ${contactData.name || 'Unknown'}: ${error.message}`);
      }
    }

    // Clean up uploaded file
    fs.unlinkSync(filePath);

    // Prepare column mapping report
    const mappedColumns = Object.entries(columnMappingReport.mapped).map(([original, mapped]) => ({
      original,
      mapped
    }));
    const unmappedColumns = Array.from(columnMappingReport.unmapped);

    res.json({
      success: true,
      message: `Import completed successfully`,
      data: {
        totalRows: rows.length,
        validContacts: contacts.length,
        inserted: results.inserted,
        skipped: results.skipped,
        errors: results.errors.length > 0 ? results.errors : undefined,
        columnMapping: {
          detected: detectedColumns,
          mapped: mappedColumns,
          unmapped: unmappedColumns.length > 0 ? unmappedColumns : undefined
        }
      }
    });

  } catch (error) {
    // Clean up file if it exists
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    console.error('Import error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to import file'
    });
  }
});

module.exports = router;
