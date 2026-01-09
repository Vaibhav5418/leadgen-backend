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
  // No file size limit - allow any size (removed limits object)
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
    let filter = {}; // Show all projects created by any user

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
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 })
      .lean();
    
    // Manually populate createdBy if it's still an ObjectId (lean() sometimes doesn't populate correctly)
    const User = require('../models/User');
    const mongoose = require('mongoose');
    
    // Extract user IDs properly - handle both populated and unpopulated cases
    const userIdsToFetch = [];
    
    projects.forEach(project => {
      if (project.createdBy) {
        // Check if already populated (has name or email property)
        if (project.createdBy.name || project.createdBy.email) {
          // Already populated, skip
          return;
        }
        
        // Try to extract the ObjectId
        let userId = null;
        if (typeof project.createdBy === 'string') {
          // It's a string ObjectId
          if (mongoose.Types.ObjectId.isValid(project.createdBy)) {
            userId = project.createdBy;
          }
        } else if (project.createdBy._id) {
          // It's an object with _id property
          userId = project.createdBy._id.toString();
        } else if (mongoose.Types.ObjectId.isValid(project.createdBy)) {
          // It's an ObjectId object
          userId = project.createdBy.toString();
        }
        
        if (userId && mongoose.Types.ObjectId.isValid(userId)) {
          userIdsToFetch.push(userId);
        }
      }
    });
    
    // Fetch users if we have any unpopulated createdBy fields
    if (userIdsToFetch.length > 0) {
      const uniqueUserIds = [...new Set(userIdsToFetch)];
      const users = await User.find({ _id: { $in: uniqueUserIds } }).select('name email').lean();
      const userMap = new Map(users.map(u => [u._id.toString(), { name: u.name, email: u.email }]));
      
      // Update projects with user data
      projects.forEach(project => {
        if (project.createdBy && !project.createdBy.name && !project.createdBy.email) {
          // Not populated yet, try to populate
          let userId = null;
          if (typeof project.createdBy === 'string') {
            userId = project.createdBy;
          } else if (project.createdBy._id) {
            userId = project.createdBy._id.toString();
          } else if (mongoose.Types.ObjectId.isValid(project.createdBy)) {
            userId = project.createdBy.toString();
          }
          
          if (userId) {
            const user = userMap.get(userId);
            if (user) {
              project.createdBy = user;
            } else {
              // User not found, keep the ObjectId or set to null
              project.createdBy = null;
            }
          }
        }
      });
    }

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
      _id: req.params.id
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

// Helper function to parse company size from employees string
const parseCompanySize = (employeesStr) => {
  if (!employeesStr) return null;
  const str = employeesStr.toString().toLowerCase();
  // Extract numbers
  const numbers = str.match(/\d+/g);
  if (!numbers || numbers.length === 0) return null;
  
  // Try to get the largest number (usually the max)
  const maxNum = Math.max(...numbers.map(n => parseInt(n)));
  return maxNum;
};

// Helper function to calculate ICP match score with detailed recommendations
const calculateMatchScore = (contact, icpDefinition) => {
  let score = 0;
  let maxScore = 0;
  const recommendationReasons = [];
  const matchedCriteria = {
    industries: [],
    jobTitles: [],
    companySize: false,
    geographies: [],
    keywords: []
  };

  // Industry match (30 points)
  if (icpDefinition?.targetIndustries && icpDefinition.targetIndustries.length > 0) {
    maxScore += 30;
    const contactIndustry = (contact.industry || '').toLowerCase();
    const matchedIndustries = icpDefinition.targetIndustries.filter(ind => 
      contactIndustry.includes(ind.toLowerCase()) || ind.toLowerCase().includes(contactIndustry)
    );
    if (matchedIndustries.length > 0) {
      score += 30;
      matchedCriteria.industries = matchedIndustries;
      recommendationReasons.push({
        type: 'industry',
        weight: 30,
        matched: matchedIndustries,
        message: `Matches ${matchedIndustries.length} target industr${matchedIndustries.length === 1 ? 'y' : 'ies'}: ${matchedIndustries.join(', ')}`
      });
    }
  }

  // Job title match (25 points)
  if (icpDefinition?.targetJobTitles && icpDefinition.targetJobTitles.length > 0) {
    maxScore += 25;
    const contactTitle = (contact.title || '').toLowerCase();
    const matchedTitles = icpDefinition.targetJobTitles.filter(jt => 
      contactTitle.includes(jt.toLowerCase()) || jt.toLowerCase().includes(contactTitle)
    );
    if (matchedTitles.length > 0) {
      score += 25;
      matchedCriteria.jobTitles = matchedTitles;
      recommendationReasons.push({
        type: 'jobTitle',
        weight: 25,
        matched: matchedTitles,
        message: `Matches target job title${matchedTitles.length === 1 ? '' : 's'}: ${matchedTitles.join(', ')}`
      });
    }
  }

  // Company size match (20 points)
  if (icpDefinition?.companySizeMin !== undefined && icpDefinition?.companySizeMax !== undefined) {
    maxScore += 20;
    const companySize = parseCompanySize(contact.employees);
    if (companySize && companySize >= icpDefinition.companySizeMin && companySize <= icpDefinition.companySizeMax) {
      score += 20;
      matchedCriteria.companySize = true;
      recommendationReasons.push({
        type: 'companySize',
        weight: 20,
        matched: [companySize],
        message: `Company size (${companySize.toLocaleString()} employees) matches target range (${icpDefinition.companySizeMin.toLocaleString()}-${icpDefinition.companySizeMax.toLocaleString()})`
      });
    }
  }

  // Geography match (15 points)
  if (icpDefinition?.geographies && icpDefinition.geographies.length > 0) {
    maxScore += 15;
    const contactLocation = [
      contact.city, contact.state, contact.country,
      contact.companyCity, contact.companyState, contact.companyCountry
    ].filter(Boolean).join(' ').toLowerCase();
    
    const matchedGeos = icpDefinition.geographies.filter(geo => 
      contactLocation.includes(geo.toLowerCase())
    );
    if (matchedGeos.length > 0) {
      score += 15;
      matchedCriteria.geographies = matchedGeos;
      recommendationReasons.push({
        type: 'geography',
        weight: 15,
        matched: matchedGeos,
        message: `Located in target geograph${matchedGeos.length === 1 ? 'y' : 'ies'}: ${matchedGeos.join(', ')}`
      });
    }
  }

  // Keywords match (10 points)
  if (icpDefinition?.keywords && icpDefinition.keywords.length > 0) {
    maxScore += 10;
    const contactKeywords = (contact.keywords || '').toLowerCase();
    const matchedKeywords = icpDefinition.keywords.filter(kw => 
      contactKeywords.includes(kw.toLowerCase())
    );
    if (matchedKeywords.length > 0) {
      const keywordScore = Math.min(10, (matchedKeywords.length / icpDefinition.keywords.length) * 10);
      score += keywordScore;
      matchedCriteria.keywords = matchedKeywords;
      recommendationReasons.push({
        type: 'keywords',
        weight: 10,
        matched: matchedKeywords,
        message: `Matches ${matchedKeywords.length} of ${icpDefinition.keywords.length} target keyword${matchedKeywords.length === 1 ? '' : 's'}: ${matchedKeywords.join(', ')}`
      });
    }
  }

  // Sort recommendation reasons by weight (highest first)
  recommendationReasons.sort((a, b) => b.weight - a.weight);

  return { 
    score, 
    maxScore, 
    percentage: maxScore > 0 ? (score / maxScore) * 100 : 0,
    recommendationReasons,
    matchedCriteria
  };
};

// Get imported contacts for a project (only contacts already linked to project)
router.get('/:id/project-contacts', authenticate, async (req, res) => {
  try {
    const project = await Project.findOne({
      _id: req.params.id
    }).lean();

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    // Get imported contacts for this project
    const importedProjectContacts = await ProjectContact.find({ projectId: project._id })
      .populate('contactId', 'name title company email firstPhone category industry keywords city state country companyCity companyState companyCountry personLinkedinUrl companyLinkedinUrl website employees')
      .lean();

    // Format contacts
    const contacts = importedProjectContacts
      .filter(pc => pc.contactId && pc.contactId._id)
      .map(pc => {
        const contact = { ...pc.contactId };
        contact._id = pc.contactId._id;
        contact.projectContactId = pc._id;
        contact.stage = pc.stage || 'New';
        contact.assignedTo = pc.assignedTo || '';
        contact.priority = pc.priority || 'Medium';
        contact.isImported = true;
        contact.matchType = 'imported';
        return contact;
      });

    res.json({
      success: true,
      data: contacts
    });
  } catch (error) {
    console.error('Error fetching project contacts:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch project contacts'
    });
  }
});

// Get similar contacts for a project
router.get('/:id/similar-contacts', authenticate, async (req, res) => {
  try {
    const project = await Project.findOne({
      _id: req.params.id
    }).lean();

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    const icpDefinition = project.icpDefinition || {};

    // Check if ICP is defined - must have at least one meaningful criteria
    // Exclude default company size values (0-1000) as they're not meaningful
    const hasMeaningfulCompanySize = icpDefinition.companySizeMin !== undefined && 
                                     icpDefinition.companySizeMax !== undefined &&
                                     !(icpDefinition.companySizeMin === 0 && icpDefinition.companySizeMax === 1000);
    
    const hasICP = (
      (icpDefinition.targetIndustries && Array.isArray(icpDefinition.targetIndustries) && icpDefinition.targetIndustries.length > 0) ||
      (icpDefinition.targetJobTitles && Array.isArray(icpDefinition.targetJobTitles) && icpDefinition.targetJobTitles.length > 0) ||
      (icpDefinition.geographies && Array.isArray(icpDefinition.geographies) && icpDefinition.geographies.length > 0) ||
      (icpDefinition.keywords && Array.isArray(icpDefinition.keywords) && icpDefinition.keywords.length > 0) ||
      hasMeaningfulCompanySize
    );

    if (!hasICP) {
      // Return only imported contacts if no ICP is defined
      const importedProjectContacts = await ProjectContact.find({ projectId: project._id })
        .populate('contactId', 'name title company email firstPhone category industry keywords city state country companyCity companyState companyCountry personLinkedinUrl companyLinkedinUrl website employees')
        .lean();

      const contacts = importedProjectContacts
        .filter(pc => pc.contactId && pc.contactId._id)
        .map(pc => {
          const contact = { ...pc.contactId };
          contact._id = pc.contactId._id;
          contact.projectContactId = pc._id;
          contact.stage = pc.stage || 'New';
          contact.assignedTo = pc.assignedTo || '';
          contact.priority = pc.priority || 'Medium';
          contact.isImported = true;
          contact.matchType = 'imported';
          return contact;
        });

      return res.json({
        success: true,
        data: contacts,
        count: contacts.length,
        hasICP: false,
        message: 'No ICP defined for this project. Please add an ICP definition to get suggestions.',
        matchStats: {
          exact: 0,
          good: 0,
          similar: 0,
          loose: 0,
          imported: contacts.length
        }
      });
    }

    // Build query to find similar contacts based on ICP criteria
    let contactFilter = {};
    const orConditions = [];

    // Match by ICP target industries (only if defined in ICP, no fallback)
    if (icpDefinition.targetIndustries && icpDefinition.targetIndustries.length > 0) {
      const industryRegex = icpDefinition.targetIndustries.map(ind => 
        new RegExp(ind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      );
      orConditions.push({ industry: { $in: industryRegex } });
    }

    // Match by ICP target job titles
    if (icpDefinition.targetJobTitles && icpDefinition.targetJobTitles.length > 0) {
      const titleRegex = icpDefinition.targetJobTitles.map(jt => 
        new RegExp(jt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      );
      orConditions.push({ title: { $in: titleRegex } });
    }

    // Match by ICP geographies (only if defined in ICP, no fallback)
    if (icpDefinition.geographies && icpDefinition.geographies.length > 0) {
      const geoConditions = [];
      icpDefinition.geographies.forEach(geo => {
        const geoRegex = new RegExp(geo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        geoConditions.push(
          { city: geoRegex },
          { state: geoRegex },
          { country: geoRegex },
          { companyCity: geoRegex },
          { companyState: geoRegex },
          { companyCountry: geoRegex }
        );
      });
      orConditions.push({ $or: geoConditions });
    }

    // Match by ICP keywords
    if (icpDefinition.keywords && icpDefinition.keywords.length > 0) {
      const keywordRegex = icpDefinition.keywords.map(kw => 
        new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      );
      orConditions.push({ keywords: { $in: keywordRegex } });
    }

    // Combine all OR conditions
    if (orConditions.length > 0) {
      contactFilter.$or = orConditions;
    }

    // If no ICP criteria found, return only imported contacts (don't show suggestions)
    if (orConditions.length === 0) {
      const importedProjectContacts = await ProjectContact.find({ projectId: project._id })
        .populate('contactId', 'name title company email firstPhone category industry keywords city state country companyCity companyState companyCountry personLinkedinUrl companyLinkedinUrl website employees')
        .lean();

      const contacts = importedProjectContacts
        .filter(pc => pc.contactId && pc.contactId._id)
        .map(pc => {
          const contact = { ...pc.contactId };
          contact._id = pc.contactId._id;
          contact.projectContactId = pc._id;
          contact.stage = pc.stage || 'New';
          contact.assignedTo = pc.assignedTo || '';
          contact.priority = pc.priority || 'Medium';
          contact.isImported = true;
          contact.matchType = 'imported';
          return contact;
        });

      return res.json({
        success: true,
        data: contacts,
        count: contacts.length,
        hasICP: false,
        message: 'No ICP criteria found. Please add ICP definition to get suggestions.',
        matchStats: {
          exact: 0,
          good: 0,
          similar: 0,
          loose: 0,
          imported: contacts.length
        }
      });
    }

    // Exclude the project's contact person if they exist in the database
    if (project.contactPerson?.email) {
      contactFilter.email = { $ne: project.contactPerson.email };
    }

    // Apply exclusion criteria
    if (icpDefinition.exclusionCriteria && icpDefinition.exclusionCriteria.length > 0) {
      const exclusionConditions = [];
      icpDefinition.exclusionCriteria.forEach(exclusion => {
        const exclusionRegex = new RegExp(exclusion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        exclusionConditions.push(
          { industry: exclusionRegex },
          { company: exclusionRegex },
          { keywords: exclusionRegex }
        );
      });
      if (exclusionConditions.length > 0) {
        contactFilter.$nor = exclusionConditions;
      }
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

    // Limit contacts to improve performance - fetch only top matches
    const limit = parseInt(req.query.limit) || 500; // Default to 500, allow override
    
    // Get similar contacts from databank (excluding already imported ones)
    // Use lean() for better performance and limit results
    const similarContacts = await Contact.find(contactFilter)
      .select('name title company email firstPhone category industry keywords city state country companyCity companyState companyCountry personLinkedinUrl companyLinkedinUrl website employees')
      .limit(limit)
      .lean();

    // Start with imported contacts (these are priority and always shown)
    const allContacts = importedProjectContacts
      .filter(pc => pc.contactId && pc.contactId._id)
      .map(pc => {
        const contact = { ...pc.contactId };
        contact._id = pc.contactId._id;
        contact.projectContactId = pc._id;
        contact.stage = pc.stage || 'New';
        contact.assignedTo = pc.assignedTo || '';
        contact.priority = pc.priority || 'Medium';
        contact.isImported = true;
        contact.matchType = 'imported';
        contact.matchScore = 100; // Imported contacts have highest priority
        return contact;
      });

    // Calculate match scores and add similar contacts from databank
    // Use batch processing to avoid blocking
    const scoredContacts = [];
    const batchSize = 100;
    
    for (let i = 0; i < similarContacts.length; i += batchSize) {
      const batch = similarContacts.slice(i, i + batchSize);
      
      for (const contact of batch) {
        const contactId = contact._id.toString();
        if (!importedContactIds.has(contactId)) {
          // Calculate ICP match score with detailed recommendations
          const matchResult = calculateMatchScore(contact, icpDefinition);
          const matchPercentage = matchResult.percentage;
          
          // Determine match type
          let matchType = 'similar';
          if (matchPercentage >= 80) {
            matchType = 'exact';
          } else if (matchPercentage >= 50) {
            matchType = 'good';
          } else if (matchPercentage >= 30) {
            matchType = 'similar';
          } else {
            matchType = 'loose';
          }

          contact.matchScore = Math.round(matchPercentage);
          contact.matchType = matchType;
          contact.isImported = false;
          contact.recommendationReasons = matchResult.recommendationReasons;
          contact.matchedCriteria = matchResult.matchedCriteria;
          
          // Check if this contact has project contact data (shouldn't happen, but just in case)
          if (importedContactMap.has(contactId)) {
            const projectContact = importedContactMap.get(contactId);
            contact.stage = projectContact.stage;
            contact.assignedTo = projectContact.assignedTo;
            contact.priority = projectContact.priority;
            contact.projectContactId = projectContact.projectContactId;
          } else {
            contact.stage = 'New';
            contact.assignedTo = '';
            contact.priority = 'Medium';
          }

          scoredContacts.push(contact);
        }
      }
      
      // Yield to event loop every batch to prevent blocking
      if (i + batchSize < similarContacts.length) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    // Sort by match score (exact matches first, then by score descending)
    // Only sort if we have contacts to sort
    if (scoredContacts.length > 0) {
      scoredContacts.sort((a, b) => {
        // Then by match type priority
        const typeOrder = { 'exact': 0, 'good': 1, 'similar': 2, 'loose': 3, 'imported': -1 };
        const typeDiff = (typeOrder[a.matchType] || 99) - (typeOrder[b.matchType] || 99);
        if (typeDiff !== 0) return typeDiff;
        
        // Then by match score
        return b.matchScore - a.matchScore;
      });
    }

    // Combine imported and scored contacts
    allContacts.push(...scoredContacts);

    res.json({
      success: true,
      data: allContacts,
      count: allContacts.length,
      hasICP: true,
      matchStats: {
        exact: scoredContacts.filter(c => c.matchType === 'exact').length,
        good: scoredContacts.filter(c => c.matchType === 'good').length,
        similar: scoredContacts.filter(c => c.matchType === 'similar').length,
        loose: scoredContacts.filter(c => c.matchType === 'loose').length,
        imported: allContacts.filter(c => c.isImported).length
      }
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

    // Verify project exists
    const project = await Project.findOne({
      _id: projectId
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

          // Get values with case-insensitive matching for all fields
          const name = normalizedRow['name'] || '';
          const email = normalizedRow['email'] || '';
          const company = normalizedRow['company'] || '';
          const title = normalizedRow['title'] || '';
          const firstPhone = normalizedRow['first phone'] || normalizedRow['firstphone'] || normalizedRow['phone'] || '';
          const employees = normalizedRow['employees'] || '';
          const category = normalizedRow['category'] || '';
          const industry = normalizedRow['industry'] || '';
          const keywords = normalizedRow['keywords'] || '';
          const personLinkedinUrl = normalizedRow['person linkedin url'] || normalizedRow['personlinkedinurl'] || 
                                   normalizedRow['linkedin'] || normalizedRow['linkedinurl'] || 
                                   normalizedRow['linkedin url'] || normalizedRow['linkedin profile'] || 
                                   normalizedRow['linkedinprofile'] || '';
          const website = normalizedRow['website'] || '';
          const companyLinkedinUrl = normalizedRow['company linkedin url'] || normalizedRow['companylinkedinurl'] || '';
          const facebookUrl = normalizedRow['facebook url'] || normalizedRow['facebookurl'] || '';
          const twitterUrl = normalizedRow['twitter url'] || normalizedRow['twitterurl'] || '';
          const city = normalizedRow['city'] || '';
          const state = normalizedRow['state'] || '';
          const country = normalizedRow['country'] || '';
          const companyAddress = normalizedRow['company address'] || normalizedRow['companyaddress'] || '';
          const companyCity = normalizedRow['company city'] || normalizedRow['companycity'] || '';
          const companyState = normalizedRow['company state'] || normalizedRow['companystate'] || '';
          const companyCountry = normalizedRow['company country'] || normalizedRow['companycountry'] || '';
          const companyPhone = normalizedRow['company phone'] || normalizedRow['companyphone'] || '';
          const seoDescription = normalizedRow['seo description'] || normalizedRow['seodescription'] || '';
          const technologies = normalizedRow['technologies'] || '';
          const annualRevenue = normalizedRow['annual revenue'] || normalizedRow['annualrevenue'] || '';

          // Skip completely empty rows
          const hasAnyData = name || email || company || title || firstPhone || employees || category || 
                           industry || keywords || personLinkedinUrl || website || companyLinkedinUrl || 
                           facebookUrl || twitterUrl || city || state || country || companyAddress || 
                           companyCity || companyState || companyCountry || companyPhone || seoDescription || 
                           technologies || annualRevenue;
          if (!hasAnyData) {
            return; // Skip empty rows silently
          }

          // Generate default values for required fields (no validation)
          const trimmedName = name ? name.toString().trim() : `Contact ${rowNumber}`;
          let trimmedEmail = email ? email.toString().trim().toLowerCase() : `contact${rowNumber}@unknown.com`;
          const trimmedCompany = company ? company.toString().trim() : 'Unknown Company';

          // Create contact object with all fields (accept any data, no validation)
          contacts.push({
            name: trimmedName,
            email: trimmedEmail,
            company: trimmedCompany,
            title: title ? title.toString().trim() : '',
            firstPhone: firstPhone ? firstPhone.toString().trim() : '',
            employees: employees ? employees.toString().trim() : '',
            category: category ? category.toString().trim() : '',
            industry: industry ? industry.toString().trim() : '',
            keywords: keywords ? keywords.toString().trim() : '',
            personLinkedinUrl: personLinkedinUrl ? personLinkedinUrl.toString().trim() : '',
            website: website ? website.toString().trim() : '',
            companyLinkedinUrl: companyLinkedinUrl ? companyLinkedinUrl.toString().trim() : '',
            facebookUrl: facebookUrl ? facebookUrl.toString().trim() : '',
            twitterUrl: twitterUrl ? twitterUrl.toString().trim() : '',
            city: city ? city.toString().trim() : '',
            state: state ? state.toString().trim() : '',
            country: country ? country.toString().trim() : '',
            companyAddress: companyAddress ? companyAddress.toString().trim() : '',
            companyCity: companyCity ? companyCity.toString().trim() : '',
            companyState: companyState ? companyState.toString().trim() : '',
            companyCountry: companyCountry ? companyCountry.toString().trim() : '',
            companyPhone: companyPhone ? companyPhone.toString().trim() : '',
            seoDescription: seoDescription ? seoDescription.toString().trim() : '',
            technologies: technologies ? technologies.toString().trim() : '',
            annualRevenue: annualRevenue ? annualRevenue.toString().trim() : ''
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

            // Get values with case-insensitive matching for all fields
            const name = normalizedRow['name'] || '';
            const email = normalizedRow['email'] || '';
            const company = normalizedRow['company'] || '';
            const title = normalizedRow['title'] || '';
            const firstPhone = normalizedRow['first phone'] || normalizedRow['firstphone'] || normalizedRow['phone'] || '';
            const employees = normalizedRow['employees'] || '';
            const category = normalizedRow['category'] || '';
            const industry = normalizedRow['industry'] || '';
            const keywords = normalizedRow['keywords'] || '';
            const personLinkedinUrl = normalizedRow['person linkedin url'] || normalizedRow['personlinkedinurl'] || 
                                     normalizedRow['linkedin'] || normalizedRow['linkedinurl'] || 
                                     normalizedRow['linkedin url'] || normalizedRow['linkedin profile'] || 
                                     normalizedRow['linkedinprofile'] || '';
            const website = normalizedRow['website'] || '';
            const companyLinkedinUrl = normalizedRow['company linkedin url'] || normalizedRow['companylinkedinurl'] || '';
            const facebookUrl = normalizedRow['facebook url'] || normalizedRow['facebookurl'] || '';
            const twitterUrl = normalizedRow['twitter url'] || normalizedRow['twitterurl'] || '';
            const city = normalizedRow['city'] || '';
            const state = normalizedRow['state'] || '';
            const country = normalizedRow['country'] || '';
            const companyAddress = normalizedRow['company address'] || normalizedRow['companyaddress'] || '';
            const companyCity = normalizedRow['company city'] || normalizedRow['companycity'] || '';
            const companyState = normalizedRow['company state'] || normalizedRow['companystate'] || '';
            const companyCountry = normalizedRow['company country'] || normalizedRow['companycountry'] || '';
            const companyPhone = normalizedRow['company phone'] || normalizedRow['companyphone'] || '';
            const seoDescription = normalizedRow['seo description'] || normalizedRow['seodescription'] || '';
            const technologies = normalizedRow['technologies'] || '';
            const annualRevenue = normalizedRow['annual revenue'] || normalizedRow['annualrevenue'] || '';

            // Skip completely empty rows
            const hasAnyData = name || email || company || title || firstPhone || employees || category || 
                             industry || keywords || personLinkedinUrl || website || companyLinkedinUrl || 
                             facebookUrl || twitterUrl || city || state || country || companyAddress || 
                             companyCity || companyState || companyCountry || companyPhone || seoDescription || 
                             technologies || annualRevenue;
            if (!hasAnyData) {
              return; // Skip empty rows silently
            }

            // Generate default values for required fields (no validation)
            const trimmedName = name ? name.trim() : `Contact ${rowNumber}`;
            let trimmedEmail = email ? email.trim().toLowerCase() : `contact${rowNumber}@unknown.com`;
            const trimmedCompany = company ? company.trim() : 'Unknown Company';

            // Create contact object with all fields (accept any data, no validation)
            contacts.push({
              name: trimmedName,
              email: trimmedEmail,
              company: trimmedCompany,
              title: title ? title.trim() : '',
              firstPhone: firstPhone ? firstPhone.trim() : '',
              employees: employees ? employees.trim() : '',
              category: category ? category.trim() : '',
              industry: industry ? industry.trim() : '',
              keywords: keywords ? keywords.trim() : '',
              personLinkedinUrl: personLinkedinUrl ? personLinkedinUrl.trim() : '',
              website: website ? website.trim() : '',
              companyLinkedinUrl: companyLinkedinUrl ? companyLinkedinUrl.trim() : '',
              facebookUrl: facebookUrl ? facebookUrl.trim() : '',
              twitterUrl: twitterUrl ? twitterUrl.trim() : '',
              city: city ? city.trim() : '',
              state: state ? state.trim() : '',
              country: country ? country.trim() : '',
              companyAddress: companyAddress ? companyAddress.trim() : '',
              companyCity: companyCity ? companyCity.trim() : '',
              companyState: companyState ? companyState.trim() : '',
              companyCountry: companyCountry ? companyCountry.trim() : '',
              companyPhone: companyPhone ? companyPhone.trim() : '',
              seoDescription: seoDescription ? seoDescription.trim() : '',
              technologies: technologies ? technologies.trim() : '',
              annualRevenue: annualRevenue ? annualRevenue.trim() : ''
            });
          })
          .on('end', resolve)
          .on('error', reject);
      });
    }

    if (contacts.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No contacts found in file. Please ensure the file contains data.'
      });
    }

    // Handle duplicate emails in the CSV by making them unique
    const emailSet = new Set();
    let duplicatesInCSV = 0;
    const uniqueContacts = contacts.map((contact, index) => {
      let email = contact.email;
      let counter = 1;
      const isDuplicate = emailSet.has(email);
      
      // If email already exists, make it unique by appending a number
      while (emailSet.has(email)) {
        if (counter === 1) {
          duplicatesInCSV++; // Count the duplicate
        }
        const baseEmail = contact.email.includes('@') 
          ? contact.email.split('@')[0] 
          : `contact${index}`;
        const domain = contact.email.includes('@') 
          ? contact.email.split('@')[1] 
          : 'unknown.com';
        email = `${baseEmail}${counter}@${domain}`;
        counter++;
      }
      
      emailSet.add(email);
      return {
        ...contact,
        email: email
      };
    });

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
            if (contact.title && contact.title.trim() !== '' && (!existingContact.title || existingContact.title.trim() === '')) {
              updateData.title = contact.title;
            }
            if (contact.firstPhone && contact.firstPhone.trim() !== '' && (!existingContact.firstPhone || existingContact.firstPhone.trim() === '')) {
              updateData.firstPhone = contact.firstPhone;
            }
            if (contact.employees && contact.employees.trim() !== '' && (!existingContact.employees || existingContact.employees.trim() === '')) {
              updateData.employees = contact.employees;
            }
            if (contact.category && contact.category.trim() !== '' && (!existingContact.category || existingContact.category.trim() === '')) {
              updateData.category = contact.category;
            }
            if (contact.industry && contact.industry.trim() !== '' && (!existingContact.industry || existingContact.industry.trim() === '')) {
              updateData.industry = contact.industry;
            }
            if (contact.keywords && contact.keywords.trim() !== '' && (!existingContact.keywords || existingContact.keywords.trim() === '')) {
              updateData.keywords = contact.keywords;
            }
            if (contact.personLinkedinUrl && contact.personLinkedinUrl.trim() !== '' && (!existingContact.personLinkedinUrl || existingContact.personLinkedinUrl.trim() === '')) {
              updateData.personLinkedinUrl = contact.personLinkedinUrl;
            }
            if (contact.website && contact.website.trim() !== '' && (!existingContact.website || existingContact.website.trim() === '')) {
              updateData.website = contact.website;
            }
            if (contact.companyLinkedinUrl && contact.companyLinkedinUrl.trim() !== '' && (!existingContact.companyLinkedinUrl || existingContact.companyLinkedinUrl.trim() === '')) {
              updateData.companyLinkedinUrl = contact.companyLinkedinUrl;
            }
            if (contact.facebookUrl && contact.facebookUrl.trim() !== '' && (!existingContact.facebookUrl || existingContact.facebookUrl.trim() === '')) {
              updateData.facebookUrl = contact.facebookUrl;
            }
            if (contact.twitterUrl && contact.twitterUrl.trim() !== '' && (!existingContact.twitterUrl || existingContact.twitterUrl.trim() === '')) {
              updateData.twitterUrl = contact.twitterUrl;
            }
            if (contact.city && contact.city.trim() !== '' && (!existingContact.city || existingContact.city.trim() === '')) {
              updateData.city = contact.city;
            }
            if (contact.state && contact.state.trim() !== '' && (!existingContact.state || existingContact.state.trim() === '')) {
              updateData.state = contact.state;
            }
            if (contact.country && contact.country.trim() !== '' && (!existingContact.country || existingContact.country.trim() === '')) {
              updateData.country = contact.country;
            }
            if (contact.companyAddress && contact.companyAddress.trim() !== '' && (!existingContact.companyAddress || existingContact.companyAddress.trim() === '')) {
              updateData.companyAddress = contact.companyAddress;
            }
            if (contact.companyCity && contact.companyCity.trim() !== '' && (!existingContact.companyCity || existingContact.companyCity.trim() === '')) {
              updateData.companyCity = contact.companyCity;
            }
            if (contact.companyState && contact.companyState.trim() !== '' && (!existingContact.companyState || existingContact.companyState.trim() === '')) {
              updateData.companyState = contact.companyState;
            }
            if (contact.companyCountry && contact.companyCountry.trim() !== '' && (!existingContact.companyCountry || existingContact.companyCountry.trim() === '')) {
              updateData.companyCountry = contact.companyCountry;
            }
            if (contact.companyPhone && contact.companyPhone.trim() !== '' && (!existingContact.companyPhone || existingContact.companyPhone.trim() === '')) {
              updateData.companyPhone = contact.companyPhone;
            }
            if (contact.seoDescription && contact.seoDescription.trim() !== '' && (!existingContact.seoDescription || existingContact.seoDescription.trim() === '')) {
              updateData.seoDescription = contact.seoDescription;
            }
            if (contact.technologies && contact.technologies.trim() !== '' && (!existingContact.technologies || existingContact.technologies.trim() === '')) {
              updateData.technologies = contact.technologies;
            }
            if (contact.annualRevenue && contact.annualRevenue.trim() !== '' && (!existingContact.annualRevenue || existingContact.annualRevenue.trim() === '')) {
              updateData.annualRevenue = contact.annualRevenue;
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

// Update project-contact stage
router.put('/:projectId/project-contacts/:contactId', authenticate, async (req, res) => {
  try {
    const { projectId, contactId } = req.params;
    const { stage, assignedTo, priority } = req.body;

    // Find the project-contact link
    const projectContact = await ProjectContact.findOne({
      projectId: projectId,
      contactId: contactId
    });

    if (!projectContact) {
      // If doesn't exist, create it
      const newProjectContact = new ProjectContact({
        projectId: projectId,
        contactId: contactId,
        stage: stage || 'New',
        assignedTo: assignedTo || '',
        priority: priority || 'Medium',
        createdBy: req.user._id
      });
      await newProjectContact.save();
      return res.json({
        success: true,
        data: newProjectContact
      });
    }

    // Update existing project-contact
    if (stage) projectContact.stage = stage;
    if (assignedTo !== undefined) projectContact.assignedTo = assignedTo;
    if (priority) projectContact.priority = priority;

    await projectContact.save();

    res.json({
      success: true,
      data: projectContact
    });
  } catch (error) {
    console.error('Error updating project-contact:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to update project-contact'
    });
  }
});

// Delete project contacts (bulk remove prospects from project)
router.delete('/:projectId/project-contacts', authenticate, async (req, res) => {
  try {
    const { projectId } = req.params;
    const { contactIds } = req.body; // Array of contact IDs to remove

    if (!contactIds || !Array.isArray(contactIds) || contactIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Contact IDs array is required'
      });
    }

    // Verify project exists
    const project = await Project.findOne({ _id: projectId });
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    // Convert contact IDs to ObjectIds
    const contactObjectIds = contactIds.map(id => new mongoose.Types.ObjectId(id));

    // Delete project-contact links
    const result = await ProjectContact.deleteMany({
      projectId: projectId,
      contactId: { $in: contactObjectIds }
    });

    res.json({
      success: true,
      message: `Successfully removed ${result.deletedCount} prospect(s) from project`,
      data: {
        deletedCount: result.deletedCount
      }
    });
  } catch (error) {
    console.error('Error removing prospects from project:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to remove prospects from project'
    });
  }
});

module.exports = router;

