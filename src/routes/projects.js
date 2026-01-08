const express = require('express');
const router = express.Router();
const multer = require('multer');
const csv = require('csv-parser');
const XLSX = require('xlsx');
const { Readable } = require('stream');
const mongoose = require('mongoose');
const Project = require('../models/Project');
const Contact = require('../models/Contact');
const ProjectContact = require('../models/ProjectContact');
const authenticate = require('../middleware/auth');

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
  },
  fileFilter: (req, file, cb) => {
    const fileName = file.originalname.toLowerCase();
    const allowedExtensions = ['.csv', '.xlsx', '.xls'];
    const allowedMimeTypes = [
      'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/excel',
      'application/x-excel',
      'application/x-msexcel'
    ];
    
    const hasValidExtension = allowedExtensions.some(ext => fileName.endsWith(ext));
    const hasValidMimeType = allowedMimeTypes.includes(file.mimetype);
    
    if (hasValidExtension || hasValidMimeType) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV, XLSX, or XLS files are allowed'), false);
    }
  }
});

// Create a new project
router.post('/', authenticate, async (req, res) => {
  try {
    const {
      companyName,
      website,
      city,
      country,
      industry,
      companySize,
      companyDescription,
      contactPerson,
      campaignDetails,
      channels,
      icpDefinition,
      assignedTo,
      teamAllocation
    } = req.body;

    // Validate required fields
    if (!companyName || !contactPerson?.fullName) {
      return res.status(400).json({
        success: false,
        error: 'Company name and contact person full name are required'
      });
    }

    // Process ICP Definition arrays (convert comma-separated strings to arrays)
    const processIcpArrays = (field) => {
      if (!field) return [];
      if (typeof field === 'string') {
        return field.split(',').map(item => item.trim()).filter(item => item);
      }
      return Array.isArray(field) ? field : [];
    };

    const processedIcp = {
      targetIndustries: processIcpArrays(icpDefinition?.targetIndustries),
      targetJobTitles: processIcpArrays(icpDefinition?.targetJobTitles),
      companySizeMin: icpDefinition?.companySizeMin || 0,
      companySizeMax: icpDefinition?.companySizeMax || 1000,
      geographies: processIcpArrays(icpDefinition?.geographies),
      keywords: processIcpArrays(icpDefinition?.keywords),
      exclusionCriteria: processIcpArrays(icpDefinition?.exclusionCriteria)
    };

    // Process dates
    const startDate = campaignDetails?.startDate ? new Date(campaignDetails.startDate) : null;
    const endDate = campaignDetails?.endDate ? new Date(campaignDetails.endDate) : null;

    const project = new Project({
      companyName,
      website: website || '',
      city: city || '',
      country: country || '',
      industry: industry || '',
      companySize: companySize || '',
      companyDescription: companyDescription || '',
      contactPerson: {
        fullName: contactPerson.fullName,
        designation: contactPerson.designation || '',
        email: contactPerson.email || '',
        phoneNumber: contactPerson.phoneNumber || '',
        linkedInProfileUrl: contactPerson.linkedInProfileUrl || ''
      },
      campaignDetails: {
        ...campaignDetails,
        startDate,
        endDate
      },
      channels: channels || {},
      icpDefinition: processedIcp,
      assignedTo: assignedTo || '',
      teamAllocation: teamAllocation || {},
      createdBy: req.user._id,
      status: 'draft'
    });

    await project.save();

    res.status(201).json({
      success: true,
      data: project,
      message: 'Project created successfully'
    });
  } catch (error) {
    console.error('Error creating project:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create project'
    });
  }
});

// Get all projects
router.get('/', authenticate, async (req, res) => {
  try {
    const { search, status } = req.query;
    let filter = { createdBy: req.user._id };

    if (status) {
      filter.status = status;
    }

    if (search) {
      filter.$or = [
        { companyName: { $regex: search, $options: 'i' } },
        { 'contactPerson.fullName': { $regex: search, $options: 'i' } },
        { 'contactPerson.email': { $regex: search, $options: 'i' } }
      ];
    }

    const projects = await Project.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      data: projects
    });
  } catch (error) {
    console.error('Error fetching projects:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch projects'
    });
  }
});

// Get a single project
router.get('/:id', authenticate, async (req, res) => {
  try {
    const project = await Project.findOne({
      _id: req.params.id,
      createdBy: req.user._id
    }).lean();

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    res.json({
      success: true,
      data: project
    });
  } catch (error) {
    console.error('Error fetching project:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch project'
    });
  }
});

// Get similar contacts for a project
router.get('/:id/similar-contacts', authenticate, async (req, res) => {
  try {
    const project = await Project.findOne({
      _id: req.params.id,
      createdBy: req.user._id
    }).lean();

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    // Build query to find similar contacts based on project data
    let contactFilter = {};

    // Match by industry if available
    if (project.industry) {
      contactFilter.industry = { $regex: project.industry, $options: 'i' };
    }

    // Match by ICP target industries
    if (project.icpDefinition?.targetIndustries && project.icpDefinition.targetIndustries.length > 0) {
      const industryRegex = project.icpDefinition.targetIndustries.map(ind => 
        new RegExp(ind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      );
      contactFilter.$or = [
        ...(contactFilter.$or || []),
        { industry: { $in: industryRegex } }
      ];
    }

    // Match by company name similarity (exclude the project's company)
    if (project.companyName) {
      const companyWords = project.companyName.split(/\s+/).filter(w => w.length > 2);
      if (companyWords.length > 0) {
        const companyRegex = companyWords.map(word => 
          new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
        );
        contactFilter.$or = [
          ...(contactFilter.$or || []),
          { company: { $in: companyRegex } }
        ];
      }
    }

    // Match by keywords from ICP
    if (project.icpDefinition?.keywords && project.icpDefinition.keywords.length > 0) {
      const keywordRegex = project.icpDefinition.keywords.map(kw => 
        new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      );
      contactFilter.$or = [
        ...(contactFilter.$or || []),
        { keywords: { $in: keywordRegex } }
      ];
    }

    // Match by geography (city, country)
    if (project.city || project.country) {
      const geoFilter = {};
      if (project.city) {
        geoFilter.$or = [
          { city: { $regex: project.city, $options: 'i' } },
          { companyCity: { $regex: project.city, $options: 'i' } }
        ];
      }
      if (project.country) {
        geoFilter.$or = [
          ...(geoFilter.$or || []),
          { country: { $regex: project.country, $options: 'i' } },
          { companyCountry: { $regex: project.country, $options: 'i' } }
        ];
      }
      if (Object.keys(geoFilter).length > 0) {
        contactFilter.$or = [
          ...(contactFilter.$or || []),
          geoFilter
        ];
      }
    }

    // If no specific filters, get all contacts (fallback)
    if (Object.keys(contactFilter).length === 0) {
      contactFilter = {};
    }

    // Exclude the project's contact person if they exist in the database
    if (project.contactPerson?.email) {
      contactFilter.email = { $ne: project.contactPerson.email };
    }

    // Get imported contacts for this project (these should always be shown)
    const importedProjectContacts = await ProjectContact.find({ projectId: project._id })
      .populate('contactId', 'name title company email firstPhone category industry keywords city state country companyCity companyState companyCountry personLinkedinUrl companyLinkedinUrl website')
      .lean();

    // Create a map of imported contact IDs to their project contact data
    const importedContactMap = new Map();
    const importedContactIds = new Set();
    
    importedProjectContacts.forEach(pc => {
      if (pc.contactId && pc.contactId._id) {
        const contactId = pc.contactId._id.toString();
        importedContactIds.add(contactId);
        importedContactMap.set(contactId, {
          stage: pc.stage,
          assignedTo: pc.assignedTo,
          priority: pc.priority,
          projectContactId: pc._id
        });
      }
    });

    // Exclude imported contacts from similar contacts query to avoid duplicates
    if (importedContactIds.size > 0) {
      contactFilter._id = { $nin: Array.from(importedContactIds).map(id => new mongoose.Types.ObjectId(id)) };
    }

    // Get similar contacts from databank (excluding already imported ones)
    const similarContacts = await Contact.find(contactFilter)
      .select('name title company email firstPhone category industry keywords city state country companyCity companyState companyCountry personLinkedinUrl companyLinkedinUrl website')
      .limit(1000)
      .lean();

    // Start with imported contacts (these are priority)
    const allContacts = importedProjectContacts
      .filter(pc => pc.contactId && pc.contactId._id)
      .map(pc => {
        const contact = { ...pc.contactId };
        contact._id = pc.contactId._id;
        contact.projectContactId = pc._id;
        contact.stage = pc.stage || 'New';
        contact.assignedTo = pc.assignedTo || '';
        contact.priority = pc.priority || 'Medium';
        return contact;
      });

    // Add similar contacts from databank (that aren't already imported)
    similarContacts.forEach(contact => {
      const contactId = contact._id.toString();
      if (!importedContactIds.has(contactId)) {
        // Check if this contact has project contact data (shouldn't happen, but just in case)
        if (importedContactMap.has(contactId)) {
          const projectContact = importedContactMap.get(contactId);
          contact.stage = projectContact.stage;
          contact.assignedTo = projectContact.assignedTo;
          contact.priority = projectContact.priority;
          contact.projectContactId = projectContact.projectContactId;
        }
        allContacts.push(contact);
      }
    });

    res.json({
      success: true,
      data: allContacts,
      count: allContacts.length
    });
  } catch (error) {
    console.error('Error fetching similar contacts:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch similar contacts'
    });
  }
});

// Update a project
router.put('/:id', authenticate, async (req, res) => {
  try {
    const {
      companyName,
      website,
      city,
      country,
      industry,
      companySize,
      companyDescription,
      contactPerson,
      campaignDetails,
      channels,
      icpDefinition,
      assignedTo,
      teamAllocation,
      status
    } = req.body;

    const project = await Project.findOne({
      _id: req.params.id,
      createdBy: req.user._id
    });

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    // Process ICP Definition arrays
    const processIcpArrays = (field) => {
      if (!field) return [];
      if (typeof field === 'string') {
        return field.split(',').map(item => item.trim()).filter(item => item);
      }
      return Array.isArray(field) ? field : [];
    };

    // Build update object
    const updateData = {};

    if (companyName) updateData.companyName = companyName;
    if (website !== undefined) updateData.website = website;
    if (city !== undefined) updateData.city = city;
    if (country !== undefined) updateData.country = country;
    if (industry !== undefined) updateData.industry = industry;
    if (companySize !== undefined) updateData.companySize = companySize;
    if (companyDescription !== undefined) updateData.companyDescription = companyDescription;
    if (assignedTo !== undefined) updateData.assignedTo = assignedTo;
    if (status) updateData.status = status;

    if (contactPerson) {
      updateData.contactPerson = {
        fullName: contactPerson.fullName || project.contactPerson.fullName,
        designation: contactPerson.designation !== undefined ? contactPerson.designation : project.contactPerson.designation,
        email: contactPerson.email !== undefined ? contactPerson.email : project.contactPerson.email,
        phoneNumber: contactPerson.phoneNumber !== undefined ? contactPerson.phoneNumber : project.contactPerson.phoneNumber,
        linkedInProfileUrl: contactPerson.linkedInProfileUrl !== undefined ? contactPerson.linkedInProfileUrl : project.contactPerson.linkedInProfileUrl
      };
    }

    if (campaignDetails) {
      updateData.campaignDetails = {
        ...project.campaignDetails,
        ...campaignDetails
      };
      if (campaignDetails.startDate) {
        updateData.campaignDetails.startDate = new Date(campaignDetails.startDate);
      }
      if (campaignDetails.endDate) {
        updateData.campaignDetails.endDate = new Date(campaignDetails.endDate);
      }
    }

    if (channels) {
      updateData.channels = { ...project.channels, ...channels };
    }

    if (icpDefinition) {
      updateData.icpDefinition = {
        targetIndustries: processIcpArrays(icpDefinition.targetIndustries),
        targetJobTitles: processIcpArrays(icpDefinition.targetJobTitles),
        companySizeMin: icpDefinition.companySizeMin !== undefined ? icpDefinition.companySizeMin : project.icpDefinition.companySizeMin,
        companySizeMax: icpDefinition.companySizeMax !== undefined ? icpDefinition.companySizeMax : project.icpDefinition.companySizeMax,
        geographies: processIcpArrays(icpDefinition.geographies),
        keywords: processIcpArrays(icpDefinition.keywords),
        exclusionCriteria: processIcpArrays(icpDefinition.exclusionCriteria)
      };
    }

    if (teamAllocation) {
      updateData.teamAllocation = { ...project.teamAllocation, ...teamAllocation };
    }

    Object.assign(project, updateData);
    await project.save();

    res.json({
      success: true,
      data: project,
      message: 'Project updated successfully'
    });
  } catch (error) {
    console.error('Error updating project:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update project'
    });
  }
});

// Delete a project
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const project = await Project.findOneAndDelete({
      _id: req.params.id,
      createdBy: req.user._id
    });

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    res.json({
      success: true,
      message: 'Project deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting project:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete project'
    });
  }
});

// Bulk import prospects
router.post('/bulk-import', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'File is required (CSV, XLSX, or XLS)'
      });
    }

    const { projectId, assignTo, defaultStage } = req.body;

    if (!projectId) {
      return res.status(400).json({
        success: false,
        error: 'Project ID is required'
      });
    }

    // Verify project exists and user has access
    const project = await Project.findOne({
      _id: projectId,
      createdBy: req.user._id
    });

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    // Parse file (CSV, XLSX, or XLS)
    const contacts = [];
    const errors = [];
    const fileName = req.file.originalname.toLowerCase();
    const isExcel = fileName.endsWith('.xlsx') || fileName.endsWith('.xls');
    
    if (isExcel) {
      // Parse Excel file
      try {
        const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(worksheet);
        
        rows.forEach((row, index) => {
          const rowNumber = index + 1;
          
          // Normalize column names (case-insensitive)
          const normalizedRow = {};
          Object.keys(row).forEach(key => {
            normalizedRow[key.toLowerCase().trim()] = row[key];
          });

          // Get values with case-insensitive matching
          const name = normalizedRow['name'] || '';
          const email = normalizedRow['email'] || '';
          const company = normalizedRow['company'] || '';
          const phone = normalizedRow['phone'] || '';
          const title = normalizedRow['title'] || '';
          // Support multiple LinkedIn column name variations
          const linkedinUrl = normalizedRow['linkedin'] || 
                              normalizedRow['linkedinurl'] || 
                              normalizedRow['linkedin url'] || 
                              normalizedRow['personlinkedinurl'] || 
                              normalizedRow['person linkedin url'] || 
                              normalizedRow['linkedin profile'] || 
                              normalizedRow['linkedinprofile'] || '';

          // Validate required fields
          if (!name || !email || !company) {
            errors.push({
              row: rowNumber,
              error: 'Missing required fields (Name, Email, Company)'
            });
            return;
          }

          // Validate email format
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          const trimmedEmail = email.toString().trim().toLowerCase();
          if (!emailRegex.test(trimmedEmail)) {
            errors.push({
              row: rowNumber,
              email: trimmedEmail,
              error: 'Invalid email format'
            });
            return;
          }

          // Create contact object
          contacts.push({
            name: name.toString().trim(),
            email: trimmedEmail,
            company: company.toString().trim(),
            firstPhone: phone ? phone.toString().trim() : '',
            title: title ? title.toString().trim() : '',
            personLinkedinUrl: linkedinUrl ? linkedinUrl.toString().trim() : ''
          });
        });
      } catch (excelError) {
        console.error('Error parsing Excel file:', excelError);
        return res.status(400).json({
          success: false,
          error: 'Failed to parse Excel file. Please ensure it is a valid XLSX or XLS file.'
        });
      }
    } else {
      // Parse CSV file
      const stream = Readable.from(req.file.buffer.toString());
      
      await new Promise((resolve, reject) => {
        let rowNumber = 0;
        stream
          .pipe(csv())
          .on('data', (row) => {
            rowNumber++;
            
            // Normalize column names (case-insensitive)
            const normalizedRow = {};
            Object.keys(row).forEach(key => {
              normalizedRow[key.toLowerCase().trim()] = row[key];
            });

            // Get values with case-insensitive matching
            const name = normalizedRow['name'] || '';
            const email = normalizedRow['email'] || '';
            const company = normalizedRow['company'] || '';
            const phone = normalizedRow['phone'] || '';
            const title = normalizedRow['title'] || '';
            // Support multiple LinkedIn column name variations
            const linkedinUrl = normalizedRow['linkedin'] || 
                                normalizedRow['linkedinurl'] || 
                                normalizedRow['linkedin url'] || 
                                normalizedRow['personlinkedinurl'] || 
                                normalizedRow['person linkedin url'] || 
                                normalizedRow['linkedin profile'] || 
                                normalizedRow['linkedinprofile'] || '';

            // Validate required fields
            if (!name || !email || !company) {
              errors.push({
                row: rowNumber,
                error: 'Missing required fields (Name, Email, Company)'
              });
              return;
            }

            // Validate email format
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            const trimmedEmail = email.trim().toLowerCase();
            if (!emailRegex.test(trimmedEmail)) {
              errors.push({
                row: rowNumber,
                email: trimmedEmail,
                error: 'Invalid email format'
              });
              return;
            }

            // Create contact object
            contacts.push({
              name: name.trim(),
              email: trimmedEmail,
              company: company.trim(),
              firstPhone: phone ? phone.trim() : '',
              title: title ? title.trim() : '',
              personLinkedinUrl: linkedinUrl ? linkedinUrl.trim() : ''
            });
          })
          .on('end', resolve)
          .on('error', reject);
      });
    }

    if (contacts.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No valid contacts found in CSV file'
      });
    }

    // Check for duplicate emails in the CSV
    const emailSet = new Set();
    const duplicatesInCSV = [];
    contacts.forEach((contact, index) => {
      if (emailSet.has(contact.email)) {
        duplicatesInCSV.push(index);
      } else {
        emailSet.add(contact.email);
      }
    });

    // Remove duplicates from CSV
    const uniqueContacts = contacts.filter((_, index) => !duplicatesInCSV.includes(index));

    // Check for existing contacts in database (case-insensitive email matching)
    const emailsToCheck = uniqueContacts.map(c => c.email.toLowerCase());
    
    // Fetch all contacts and filter case-insensitively
    // Using $in with all possible case variations would be inefficient, so we fetch and filter
    const allPossibleEmails = [...new Set(emailsToCheck)];
    const existingEmails = await Contact.find({
      $or: allPossibleEmails.map(email => ({
        email: { $regex: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
      }))
    }).select('_id email').lean();

    // Create maps for case-insensitive matching
    const existingEmailMap = new Map();
    existingEmails.forEach(c => {
      const emailLower = c.email.toLowerCase();
      if (!existingEmailMap.has(emailLower)) {
        existingEmailMap.set(emailLower, c._id);
      }
    });

    // Separate new contacts and existing contacts
    const newContacts = [];
    const existingContacts = [];
    const seenEmails = new Set();

    uniqueContacts.forEach(contact => {
      const emailLower = contact.email.toLowerCase();
      
      // Skip if we've already processed this email in this batch
      if (seenEmails.has(emailLower)) {
        return;
      }
      seenEmails.add(emailLower);
      
      if (existingEmailMap.has(emailLower)) {
        existingContacts.push({
          ...contact,
          contactId: existingEmailMap.get(emailLower)
        });
      } else {
        newContacts.push(contact);
      }
    });

    // Create new contacts in database
    let createdContacts = [];
    if (newContacts.length > 0) {
      try {
        // Check for duplicates by email before inserting
        const emailsToInsert = newContacts.map(c => c.email);
        const existingByEmail = await Contact.find({
          email: { $in: emailsToInsert }
        }).select('_id email').lean();
        
        const existingEmailsSet = new Set(existingByEmail.map(c => c.email.toLowerCase()));
        const contactsToInsert = newContacts.filter(c => !existingEmailsSet.has(c.email.toLowerCase()));
        const duplicateEmails = newContacts.filter(c => existingEmailsSet.has(c.email.toLowerCase()));
        
        if (duplicateEmails.length > 0) {
          console.log(`Skipping ${duplicateEmails.length} contacts that already exist in database`);
          // Add existing contacts to existingContacts array
          duplicateEmails.forEach(dupContact => {
            const existing = existingByEmail.find(e => e.email.toLowerCase() === dupContact.email.toLowerCase());
            if (existing) {
              existingContacts.push({
                ...dupContact,
                contactId: existing._id
              });
            }
          });
        }
        
        if (contactsToInsert.length > 0) {
          createdContacts = await Contact.insertMany(contactsToInsert, { ordered: false });
          console.log(`✓ Created ${createdContacts.length} new contacts in Contact collection (databank)`);
        }
      } catch (insertError) {
        // Handle partial inserts (some might succeed)
        if (insertError.writeErrors) {
          console.error('Some contacts failed to insert:', insertError.writeErrors.length);
          // Get successfully inserted contacts
          const insertedIds = insertError.insertedIds || {};
          createdContacts = Object.values(insertedIds).map(id => ({ _id: id }));
          
          // Handle duplicate key errors - add to existing contacts
          const duplicateErrors = insertError.writeErrors.filter(err => err.code === 11000);
          if (duplicateErrors.length > 0) {
            // Try to find these contacts by email
            const duplicateEmails = duplicateErrors.map(err => {
              const doc = err.op;
              return doc.email;
            });
            const existingDups = await Contact.find({
              email: { $in: duplicateEmails }
            }).select('_id email').lean();
            
            existingDups.forEach(existing => {
              const dupContact = newContacts.find(c => c.email.toLowerCase() === existing.email.toLowerCase());
              if (dupContact) {
                existingContacts.push({
                  ...dupContact,
                  contactId: existing._id
                });
              }
            });
          }
        } else {
          throw insertError;
        }
      }
    }

    // Link all contacts (new and existing) to the project
    const projectContacts = [];
    let skipped = 0;

    // Check for existing project-contact links (prevent duplicates)
    const allContactIds = [
      ...createdContacts.map(c => c._id),
      ...existingContacts.map(c => c.contactId)
    ].filter(id => id); // Remove any undefined/null IDs

    // Remove duplicates from allContactIds array itself
    const uniqueContactIds = [...new Set(allContactIds.map(id => id.toString()))].map(id => new mongoose.Types.ObjectId(id));

    const existingProjectContacts = await ProjectContact.find({
      projectId: project._id,
      contactId: { $in: uniqueContactIds }
    }).select('contactId').lean();

    const existingProjectContactSet = new Set(
      existingProjectContacts.map(pc => pc.contactId.toString())
    );

    // Create project-contact links for new contacts
    for (const contact of createdContacts) {
      if (!existingProjectContactSet.has(contact._id.toString())) {
        projectContacts.push({
          projectId: project._id,
          contactId: contact._id,
          stage: defaultStage || 'New',
          assignedTo: assignTo || project.assignedTo || '',
          createdBy: req.user._id
        });
      } else {
        skipped++;
      }
    }

    // Update existing contacts with imported data (fill in missing fields or update with new data)
    if (existingContacts.length > 0) {
      const updatePromises = existingContacts.map(async (contact) => {
        try {
          const existingContact = await Contact.findById(contact.contactId);
          if (existingContact) {
            const updateData = {};
            
            // Update fields if they're provided in import and missing or different in existing contact
            if (contact.name && contact.name.trim() !== '' && (!existingContact.name || existingContact.name.trim() === '')) {
              updateData.name = contact.name;
            }
            if (contact.company && contact.company.trim() !== '' && (!existingContact.company || existingContact.company.trim() === '')) {
              updateData.company = contact.company;
            }
            if (contact.firstPhone && contact.firstPhone.trim() !== '' && (!existingContact.firstPhone || existingContact.firstPhone.trim() === '')) {
              updateData.firstPhone = contact.firstPhone;
            }
            if (contact.title && contact.title.trim() !== '' && (!existingContact.title || existingContact.title.trim() === '')) {
              updateData.title = contact.title;
            }
            if (contact.personLinkedinUrl && contact.personLinkedinUrl.trim() !== '' && (!existingContact.personLinkedinUrl || existingContact.personLinkedinUrl.trim() === '')) {
              updateData.personLinkedinUrl = contact.personLinkedinUrl;
            }
            
            // Update if there are any fields to update
            if (Object.keys(updateData).length > 0) {
              await Contact.findByIdAndUpdate(contact.contactId, updateData);
              console.log(`Updated contact ${contact.contactId} with imported data`);
            }
          }
        } catch (updateError) {
          console.error(`Error updating contact ${contact.contactId}:`, updateError);
        }
      });
      
      await Promise.all(updatePromises);
    }

    // Create project-contact links for existing contacts
    for (const contact of existingContacts) {
      if (!existingProjectContactSet.has(contact.contactId.toString())) {
        projectContacts.push({
          projectId: project._id,
          contactId: contact.contactId,
          stage: defaultStage || 'New',
          assignedTo: assignTo || project.assignedTo || '',
          createdBy: req.user._id
        });
      } else {
        skipped++;
      }
    }

    let projectContactsCreated = 0;
    if (projectContacts.length > 0) {
      try {
        // Use insertMany with ordered: false to handle duplicates gracefully
        // The unique index on {projectId, contactId} will prevent duplicates
        const result = await ProjectContact.insertMany(projectContacts, { 
          ordered: false,
          rawResult: false
        });
        projectContactsCreated = result.length;
        console.log(`✓ Created ${projectContactsCreated} ProjectContact documents in MongoDB linking contacts to project ${projectId}`);
      } catch (linkError) {
        // Handle duplicate key errors (E11000)
        if (linkError.code === 11000 || linkError.writeErrors) {
          // Count successfully inserted vs duplicates
          const writeErrors = linkError.writeErrors || [];
          const duplicateErrors = writeErrors.filter(err => err.code === 11000);
          projectContactsCreated = projectContacts.length - writeErrors.length;
          skipped += duplicateErrors.length;
          console.log(`✓ Created ${projectContactsCreated} ProjectContact documents, ${duplicateErrors.length} duplicates skipped`);
        } else {
          console.error('Error linking contacts to project:', linkError);
          throw linkError;
        }
      }
    }

    // Calculate final imported count (actual ProjectContact documents created)
    const imported = projectContactsCreated;
    const totalSkipped = skipped + duplicatesInCSV.length;

    const newContactsCount = createdContacts.length;
    const existingContactsCount = existingContacts.length;
    
    console.log(`\n=== Bulk Import Summary ===`);
    console.log(`✓ Contact Collection (Databank): ${newContactsCount} new contacts created, ${existingContactsCount} existing contacts updated`);
    console.log(`✓ ProjectContact Collection: ${projectContactsCreated} project-contact links created`);
    console.log(`✓ Total imported to project: ${imported} prospects`);
    console.log(`✓ Skipped: ${totalSkipped} (${duplicatesInCSV.length} duplicates in CSV, ${skipped} already in project)`);
    console.log(`✓ Errors: ${errors.length}`);
    console.log(`===========================\n`);

    res.json({
      success: true,
      data: {
        imported,
        skipped: totalSkipped,
        errors: errors.length,
        total: contacts.length,
        duplicatesInCSV: duplicatesInCSV.length,
        alreadyInProject: skipped,
        newContactsInDatabank: newContactsCount,
        existingContactsInDatabank: existingContactsCount,
        projectContactsCreated: projectContactsCreated
      },
      message: `Successfully imported ${imported} prospects. ${newContactsCount > 0 ? `${newContactsCount} new contacts saved to Contact collection (databank).` : ''} ${existingContactsCount > 0 ? `${existingContactsCount} existing contacts updated in Contact collection.` : ''} ${projectContactsCreated > 0 ? `${projectContactsCreated} ProjectContact links created.` : ''} ${totalSkipped > 0 ? `${totalSkipped} duplicates skipped.` : ''}`
    });
  } catch (error) {
    console.error('Error importing prospects:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to import prospects'
    });
  }
});

module.exports = router;
