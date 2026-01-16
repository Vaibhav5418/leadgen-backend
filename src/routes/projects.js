const express = require('express');
const router = express.Router();
const multer = require('multer');
const csv = require('csv-parser');
const XLSX = require('xlsx');
const { Readable } = require('stream');
const mongoose = require('mongoose');
const Project = require('../models/Project');
const Contact = require('../models/Contact');
const ProspectContact = require('../models/ProspectContact');
const ProjectContact = require('../models/ProjectContact');
const Activity = require('../models/Activity');
const authenticate = require('../middleware/auth');

// Get the actual MongoDB collection name for ProspectContact
// Mongoose automatically pluralizes and lowercases: 'ProspectContact' -> 'prospectcontacts'
const PROSPECT_CONTACT_COLLECTION = 'prospectcontacts';

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

// Toggle project active status
// IMPORTANT: This route must come before /:id to avoid route conflicts
router.patch('/:id/status', authenticate, async (req, res) => {
  try {
    const projectId = req.params.id;
    const { isActive } = req.body;

    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid project ID format'
      });
    }

    // Validate isActive is a boolean
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'isActive must be a boolean value'
      });
    }

    const project = await Project.findById(projectId);

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    // Update status: active if isActive is true, draft if false
    project.status = isActive ? 'active' : 'draft';
    await project.save();

    res.json({
      success: true,
      data: project,
      message: `Project ${isActive ? 'activated' : 'deactivated'} successfully`
    });
  } catch (error) {
    console.error('Error updating project status:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update project status'
    });
  }
});

// Get comprehensive project analytics and dashboard data
// IMPORTANT: This route must come before /:id to avoid route conflicts
router.get('/analytics', authenticate, async (req, res) => {
  try {
    const Activity = require('../models/Activity');
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    // Get all projects with basic stats
    const projects = await Project.find().lean();
    const projectIds = projects.map(p => p._id);
    
    // Parallel queries for performance
    const [
      totalProjects,
      activeProjects,
      draftProjects,
      completedProjects,
      totalProspects,
      totalActivities,
      activitiesByType,
      activitiesByDate,
      stageDistribution,
      channelUsage,
      teamPerformance,
      projectHealth,
      topProjects,
      conversionMetrics,
      activityTrends,
      recentActivities
    ] = await Promise.all([
      // Basic counts
      Project.countDocuments(),
      Project.countDocuments({ status: 'active' }),
      Project.countDocuments({ status: 'draft' }),
      Project.countDocuments({ status: 'completed' }),
      
      // Prospect counts - only from existing projects
      ProjectContact.countDocuments({ projectId: { $in: projectIds } }),
      
      // Activity counts - only from existing projects
      Activity.countDocuments({ projectId: { $in: projectIds } }),
      
      // Activities by type
      Activity.aggregate([
        { $match: { projectId: { $in: projectIds } } },
        { $group: { _id: '$type', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      
      // Activities by date (last 30 days)
      Activity.aggregate([
        { 
          $match: { 
            projectId: { $in: projectIds },
            createdAt: { $gte: thirtyDaysAgo }
          } 
        },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            count: { $sum: 1 }
          }
        },
        { $sort: { _id: 1 } }
      ]),
      
      // Stage distribution - only from existing projects
      ProjectContact.aggregate([
        { $match: { projectId: { $in: projectIds } } },
        { $group: { _id: '$stage', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      
      // Channel usage across projects
      Project.aggregate([
        {
          $project: {
            linkedIn: { $cond: [{ $eq: ['$channels.linkedInOutreach', true] }, 1, 0] },
            email: { $cond: [{ $eq: ['$channels.coldEmail', true] }, 1, 0] },
            calling: { $cond: [{ $eq: ['$channels.coldCalling', true] }, 1, 0] }
          }
        },
        {
          $group: {
            _id: null,
            linkedIn: { $sum: '$linkedIn' },
            email: { $sum: '$email' },
            calling: { $sum: '$calling' }
          }
        }
      ]),
      
      // Team performance (activities per team member)
      Activity.aggregate([
        { $match: { projectId: { $in: projectIds } } },
        {
          $lookup: {
            from: 'users',
            localField: 'createdBy',
            foreignField: '_id',
            as: 'user'
          }
        },
        { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: '$createdBy',
            name: { $first: '$user.name' },
            email: { $first: '$user.email' },
            activityCount: { $sum: 1 },
            calls: { $sum: { $cond: [{ $eq: ['$type', 'call'] }, 1, 0] } },
            emails: { $sum: { $cond: [{ $eq: ['$type', 'email'] }, 1, 0] } },
            linkedin: { $sum: { $cond: [{ $eq: ['$type', 'linkedin'] }, 1, 0] } }
          }
        },
        { $sort: { activityCount: -1 } },
        { $limit: 10 }
      ]),
      
      // Project health metrics
      Project.aggregate([
        {
          $lookup: {
            from: 'projectcontacts',
            localField: '_id',
            foreignField: 'projectId',
            as: 'contacts'
          }
        },
        {
          $lookup: {
            from: 'activities',
            localField: '_id',
            foreignField: 'projectId',
            as: 'activities'
          }
        },
        {
          $project: {
            _id: 1,
            companyName: 1,
            status: 1,
            contactCount: { $size: '$contacts' },
            activityCount: { $size: '$activities' },
            recentActivity: {
              $size: {
                $filter: {
                  input: '$activities',
                  as: 'activity',
                  cond: { $gte: ['$$activity.createdAt', sevenDaysAgo] }
                }
              }
            },
            wonCount: {
              $size: {
                $filter: {
                  input: '$contacts',
                  as: 'contact',
                  cond: { $eq: ['$$contact.stage', 'WON'] }
                }
              }
            },
            lostCount: {
              $size: {
                $filter: {
                  input: '$contacts',
                  as: 'contact',
                  cond: { $eq: ['$$contact.stage', 'Lost'] }
                }
              }
            }
          }
        },
        {
          $addFields: {
            healthScore: {
              $add: [
                { $multiply: [{ $min: [{ $divide: ['$contactCount', 100] }, 1] }, 30] },
                { $multiply: [{ $min: [{ $divide: ['$activityCount', 50] }, 1] }, 30] },
                { $multiply: [{ $min: [{ $divide: ['$recentActivity', 10] }, 1] }, 20] },
                { $multiply: [{ $min: [{ $divide: ['$wonCount', 10] }, 1] }, 20] }
              ]
            }
          }
        },
        { $sort: { healthScore: -1 } },
        { $limit: 20 }
      ]),
      
      // Top performing projects
      Project.aggregate([
        {
          $lookup: {
            from: 'projectcontacts',
            localField: '_id',
            foreignField: 'projectId',
            as: 'contacts'
          }
        },
        {
          $lookup: {
            from: 'activities',
            localField: '_id',
            foreignField: 'projectId',
            as: 'activities'
          }
        },
        {
          $project: {
            _id: 1,
            companyName: 1,
            status: 1,
            contactCount: { $size: '$contacts' },
            activityCount: { $size: '$activities' },
            wonCount: {
              $size: {
                $filter: {
                  input: '$contacts',
                  as: 'contact',
                  cond: { $eq: ['$$contact.stage', 'WON'] }
                }
              }
            },
            meetingCount: {
              $size: {
                $filter: {
                  input: '$contacts',
                  as: 'contact',
                  cond: { $in: ['$$contact.stage', ['Meeting Scheduled', 'Meeting Completed', 'In-Person Meeting']] }
                }
              }
            }
          }
        },
        { $sort: { wonCount: -1, meetingCount: -1 } },
        { $limit: 10 }
      ]),
      
      // Conversion metrics - only from existing projects
      ProjectContact.aggregate([
        { $match: { projectId: { $in: projectIds } } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            won: { $sum: { $cond: [{ $eq: ['$stage', 'WON'] }, 1, 0] } },
            lost: { $sum: { $cond: [{ $eq: ['$stage', 'Lost'] }, 1, 0] } },
            meetings: {
              $sum: {
                $cond: [
                  { $in: ['$stage', ['Meeting Scheduled', 'Meeting Completed', 'In-Person Meeting']] },
                  1,
                  0
                ]
              }
            },
            sql: { $sum: { $cond: [{ $eq: ['$stage', 'SQL'] }, 1, 0] } },
            cip: { $sum: { $cond: [{ $eq: ['$stage', 'CIP'] }, 1, 0] } }
          }
        }
      ]),
      
      // Activity trends (last 7 days)
      Activity.aggregate([
        {
          $match: {
            projectId: { $in: projectIds },
            createdAt: { $gte: sevenDaysAgo }
          }
        },
        {
          $group: {
            _id: {
              date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
              type: '$type'
            },
            count: { $sum: 1 }
          }
        },
        { $sort: { '_id.date': 1 } }
      ]),
      
      // Recent activities
      Activity.aggregate([
        { $match: { projectId: { $in: projectIds } } },
        {
          $lookup: {
            from: 'projects',
            localField: 'projectId',
            foreignField: '_id',
            as: 'project'
          }
        },
        { $unwind: { path: '$project', preserveNullAndEmptyArrays: true } },
        { $sort: { createdAt: -1 } },
        { $limit: 10 },
        {
          $project: {
            type: 1,
            outcome: 1,
            createdAt: 1,
            projectName: '$project.companyName'
          }
        }
      ])
    ]);
    
    // Process channel usage
    const channelData = channelUsage[0] || { linkedIn: 0, email: 0, calling: 0 };
    
    // Process conversion metrics
    const conversionData = conversionMetrics[0] || {
      total: 0,
      won: 0,
      lost: 0,
      meetings: 0,
      sql: 0,
      cip: 0
    };
    
    const winRate = conversionData.total > 0 
      ? ((conversionData.won / conversionData.total) * 100).toFixed(1)
      : 0;
    const meetingRate = conversionData.total > 0
      ? ((conversionData.meetings / conversionData.total) * 100).toFixed(1)
      : 0;
    
    // Process activity trends
    const trendData = {};
    activityTrends.forEach(item => {
      const date = item._id.date;
      if (!trendData[date]) {
        trendData[date] = { call: 0, email: 0, linkedin: 0 };
      }
      trendData[date][item._id.type] = item.count;
    });
    
    const trendLabels = Object.keys(trendData).sort();
    const trendCallData = trendLabels.map(date => trendData[date].call || 0);
    const trendEmailData = trendLabels.map(date => trendData[date].email || 0);
    const trendLinkedInData = trendLabels.map(date => trendData[date].linkedin || 0);
    
    // Process activities by date
    const activityDateMap = {};
    activitiesByDate.forEach(item => {
      activityDateMap[item._id] = item.count;
    });
    
    // Calculate monthly project growth
    const monthlyGrowth = await Project.aggregate([
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } },
      { $limit: 12 }
    ]);
    
    res.json({
      success: true,
      data: {
        overview: {
          totalProjects,
          activeProjects,
          draftProjects,
          completedProjects,
          totalProspects,
          totalActivities
        },
        activities: {
          byType: activitiesByType.map(item => ({
            type: item._id,
            count: item.count
          })),
          byDate: activitiesByDate,
          trends: {
            labels: trendLabels,
            call: trendCallData,
            email: trendEmailData,
            linkedin: trendLinkedInData
          }
        },
        pipeline: {
          stageDistribution: stageDistribution.map(item => ({
            stage: item._id,
            count: item.count
          })),
          conversion: {
            winRate: parseFloat(winRate),
            meetingRate: parseFloat(meetingRate),
            total: conversionData.total,
            won: conversionData.won,
            lost: conversionData.lost,
            meetings: conversionData.meetings,
            sql: conversionData.sql,
            cip: conversionData.cip
          }
        },
        channels: {
          linkedIn: channelData.linkedIn || 0,
          email: channelData.email || 0,
          calling: channelData.calling || 0
        },
        team: {
          performance: teamPerformance.map(member => ({
            id: member._id?.toString(),
            name: member.name || 'Unknown',
            email: member.email || '',
            totalActivities: member.activityCount,
            calls: member.calls,
            emails: member.emails,
            linkedin: member.linkedin
          }))
        },
        projects: {
          health: projectHealth.map(project => ({
            id: project._id.toString(),
            companyName: project.companyName,
            status: project.status,
            contactCount: project.contactCount,
            activityCount: project.activityCount,
            recentActivity: project.recentActivity,
            wonCount: project.wonCount,
            lostCount: project.lostCount,
            healthScore: Math.round(project.healthScore)
          })),
          topPerformers: topProjects.map(project => ({
            id: project._id.toString(),
            companyName: project.companyName,
            status: project.status,
            contactCount: project.contactCount,
            activityCount: project.activityCount,
            wonCount: project.wonCount,
            meetingCount: project.meetingCount
          }))
        },
        growth: {
          monthly: monthlyGrowth.map(item => ({
            month: item._id,
            count: item.count
          }))
        },
        recent: {
          activities: recentActivities
        }
      }
    });
  } catch (error) {
    console.error('Error fetching project analytics:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch project analytics'
    });
  }
});

// Get comprehensive prospect analytics and dashboard data
// IMPORTANT: This route must come before /:id to avoid route conflicts
router.get('/prospect-analytics', authenticate, async (req, res) => {
  try {
    const Activity = require('../models/Activity');
    const { projectId } = req.query;
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    // Build filter for project-specific or all projects
    let projectFilter = {};
    let projectIds = [];
    
    if (projectId && mongoose.Types.ObjectId.isValid(projectId)) {
      projectFilter = { projectId: new mongoose.Types.ObjectId(projectId) };
      projectIds = [new mongoose.Types.ObjectId(projectId)];
    } else {
      const projects = await Project.find().lean();
      projectIds = projects.map(p => p._id);
      projectFilter = { projectId: { $in: projectIds } };
    }
    
    // Parallel queries for performance
    const [
      totalProspects,
      prospectsByStage,
      prospectsByPriority,
      activitiesByType,
      activitiesByDate,
      teamPerformance,
      stageDistribution,
      callFunnel,
      emailFunnel,
      linkedinFunnel,
      recentActivities,
      activityTrends,
      conversionMetrics,
      topPerformers
    ] = await Promise.all([
      // Total prospects
      ProjectContact.countDocuments(projectFilter),
      
      // Prospects by stage
      ProjectContact.aggregate([
        { $match: projectFilter },
        { $group: { _id: '$stage', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      
      // Prospects by priority
      ProjectContact.aggregate([
        { $match: projectFilter },
        { $group: { _id: '$priority', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      
      // Activities by type
      Activity.aggregate([
        { $match: projectFilter },
        { $group: { _id: '$type', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      
      // Activities by date (last 30 days)
      Activity.aggregate([
        { 
          $match: { 
            ...projectFilter,
            createdAt: { $gte: thirtyDaysAgo }
          } 
        },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            count: { $sum: 1 }
          }
        },
        { $sort: { _id: 1 } }
      ]),
      
      // Team performance
      Activity.aggregate([
        { $match: projectFilter },
        {
          $lookup: {
            from: 'users',
            localField: 'createdBy',
            foreignField: '_id',
            as: 'user'
          }
        },
        { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: '$createdBy',
            name: { $first: '$user.name' },
            email: { $first: '$user.email' },
            activityCount: { $sum: 1 },
            calls: { $sum: { $cond: [{ $eq: ['$type', 'call'] }, 1, 0] } },
            emails: { $sum: { $cond: [{ $eq: ['$type', 'email'] }, 1, 0] } },
            linkedin: { $sum: { $cond: [{ $eq: ['$type', 'linkedin'] }, 1, 0] } }
          }
        },
        { $sort: { activityCount: -1 } },
        { $limit: 10 }
      ]),
      
      // Stage distribution with details
      // Check both ProspectContact and Contact collections for legacy data
      ProjectContact.aggregate([
        { $match: projectFilter },
        {
          $lookup: {
            from: PROSPECT_CONTACT_COLLECTION,
            localField: 'contactId',
            foreignField: '_id',
            as: 'prospectContact'
          }
        },
        {
          $lookup: {
            from: 'contacts', // Legacy Contact collection
            localField: 'contactId',
            foreignField: '_id',
            as: 'legacyContact'
          }
        },
        {
          $project: {
            stage: 1,
            priority: 1,
            // Prefer ProspectContact, fallback to Contact (just for validation)
            contact: {
              $cond: {
                if: { $gt: [{ $size: '$prospectContact' }, 0] },
                then: { $arrayElemAt: ['$prospectContact', 0] },
                else: { $arrayElemAt: ['$legacyContact', 0] }
              }
            }
          }
        },
        {
          $group: {
            _id: '$stage',
            count: { $sum: 1 },
            avgPriority: {
              $avg: {
                $cond: [
                  { $eq: ['$priority', 'High'] }, 3,
                  { $cond: [{ $eq: ['$priority', 'Medium'] }, 2, 1] }
                ]
              }
            }
          }
        },
        { $sort: { count: -1 } }
      ]),
      
      // Cold Calling Funnel
      Activity.aggregate([
        {
          $match: {
            ...projectFilter,
            type: 'call'
          }
        },
        {
          $group: {
            _id: '$contactId',
            callDate: { $max: '$callDate' },
            callStatus: { $last: '$callStatus' },
            callNumber: { $max: '$callNumber' },
            nextAction: { $last: '$nextAction' },
            nextActionDate: { $max: '$nextActionDate' },
            conversationNotes: { $last: '$conversationNotes' }
          }
        }
      ]),
      
      // Email Funnel
      Activity.aggregate([
        {
          $match: {
            ...projectFilter,
            type: 'email'
          }
        },
        {
          $group: {
            _id: '$contactId',
            emailDate: { $max: '$emailDate' },
            status: { $last: '$status' },
            outcome: { $last: '$outcome' }
          }
        }
      ]),
      
      // LinkedIn Funnel - get most recent activity per contact
      Activity.aggregate([
        {
          $match: {
            ...projectFilter,
            type: 'linkedin'
          }
        },
        {
          // Sort by date to ensure most recent activity first
          $sort: {
            linkedinDate: -1,
            createdAt: -1
          }
        },
        {
          $group: {
            _id: '$contactId',
            linkedinDate: { $first: '$linkedinDate' },
            status: { $first: '$status' },
            lnRequestSent: { $first: '$lnRequestSent' },
            connected: { $first: '$connected' },
            createdAt: { $first: '$createdAt' }
          }
        }
      ]),
      
      // Recent activities
      // Check both ProspectContact and Contact collections for legacy data
      Activity.aggregate([
        { $match: projectFilter },
        {
          $lookup: {
            from: PROSPECT_CONTACT_COLLECTION,
            localField: 'contactId',
            foreignField: '_id',
            as: 'prospectContact'
          }
        },
        {
          $lookup: {
            from: 'contacts', // Legacy Contact collection
            localField: 'contactId',
            foreignField: '_id',
            as: 'legacyContact'
          }
        },
        {
          $project: {
            type: 1,
            outcome: 1,
            status: 1,
            createdAt: 1,
            // Prefer ProspectContact, fallback to Contact
            contact: {
              $cond: {
                if: { $gt: [{ $size: '$prospectContact' }, 0] },
                then: { $arrayElemAt: ['$prospectContact', 0] },
                else: { $arrayElemAt: ['$legacyContact', 0] }
              }
            }
          }
        },
        { $sort: { createdAt: -1 } },
        { $limit: 10 },
        {
          $project: {
            type: 1,
            outcome: 1,
            status: 1,
            createdAt: 1,
            contactName: '$contact.name'
          }
        }
      ]),
      
      // Activity trends (last 7 days)
      Activity.aggregate([
        {
          $match: {
            ...projectFilter,
            createdAt: { $gte: sevenDaysAgo }
          }
        },
        {
          $group: {
            _id: {
              date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
              type: '$type'
            },
            count: { $sum: 1 }
          }
        },
        { $sort: { '_id.date': 1 } }
      ]),
      
      // Conversion metrics
      ProjectContact.aggregate([
        { $match: projectFilter },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            won: { $sum: { $cond: [{ $eq: ['$stage', 'WON'] }, 1, 0] } },
            lost: { $sum: { $cond: [{ $eq: ['$stage', 'Lost'] }, 1, 0] } },
            meetings: {
              $sum: {
                $cond: [
                  { $in: ['$stage', ['Meeting Scheduled', 'Meeting Completed', 'In-Person Meeting']] },
                  1,
                  0
                ]
              }
            },
            sql: { $sum: { $cond: [{ $eq: ['$stage', 'SQL'] }, 1, 0] } },
            cip: { $sum: { $cond: [{ $eq: ['$stage', 'CIP'] }, 1, 0] } }
          }
        }
      ]),
      
      // Top performing prospects (by activity count)
      // Check both ProspectContact and Contact collections for legacy data
      Activity.aggregate([
        { $match: projectFilter },
        {
          $lookup: {
            from: PROSPECT_CONTACT_COLLECTION,
            localField: 'contactId',
            foreignField: '_id',
            as: 'prospectContact'
          }
        },
        {
          $lookup: {
            from: 'contacts', // Legacy Contact collection
            localField: 'contactId',
            foreignField: '_id',
            as: 'legacyContact'
          }
        },
        {
          $project: {
            contactId: 1,
            createdAt: 1,
            // Prefer ProspectContact, fallback to Contact
            contact: {
              $cond: {
                if: { $gt: [{ $size: '$prospectContact' }, 0] },
                then: { $arrayElemAt: ['$prospectContact', 0] },
                else: { $arrayElemAt: ['$legacyContact', 0] }
              }
            }
          }
        },
        {
          $match: {
            contact: { $ne: null }
          }
        },
        {
          $group: {
            _id: '$contactId',
            name: { $first: '$contact.name' },
            company: { $first: '$contact.company' },
            activityCount: { $sum: 1 },
            lastActivity: { $max: '$createdAt' }
          }
        },
        { $sort: { activityCount: -1 } },
        { $limit: 10 }
      ])
    ]);
    
    // Calculate Cold Calling Funnel - Updated 10-stage structure
    const callsAttemptedSet = new Set();
    const callsConnectedSet = new Set();
    const decisionMakerReachedSet = new Set();
    const interestedSet = new Set();
    const detailsSharedSet = new Set();
    const demoBookedSet = new Set();
    const demoCompletedSet = new Set();
    const sqlSet = new Set();
    const wonSet = new Set();

    callFunnel.forEach(c => {
      const contactId = c._id?.toString();
      if (!contactId) return;

      // Calls Attempted
      if (c.callDate) {
        callsAttemptedSet.add(contactId);
      }

      // Calls Connected - if callStatus indicates a connection
      const connectedStatuses = ['Interested', 'Not Interested', 'Call Back', 'Future', 'Details Shared', 'Demo Booked', 'Demo Completed', 'Existing'];
      if (c.callStatus && connectedStatuses.includes(c.callStatus)) {
        callsConnectedSet.add(contactId);
      }

      // Decision Maker Reached
      const decisionMakerStatuses = ['Interested', 'Details Shared', 'Demo Booked', 'Demo Completed'];
      if (c.callStatus && decisionMakerStatuses.includes(c.callStatus)) {
        decisionMakerReachedSet.add(contactId);
      }

      // Interested
      if (c.callStatus === 'Interested') {
        interestedSet.add(contactId);
      }

      // Details Shared
      if (c.callStatus === 'Details Shared') {
        detailsSharedSet.add(contactId);
      }

      // Demo Booked
      if (c.callStatus === 'Demo Booked') {
        demoBookedSet.add(contactId);
      }

      // Demo Completed
      if (c.callStatus === 'Demo Completed') {
        demoCompletedSet.add(contactId);
      }

      // SQL
      if (c.callStatus === 'Demo Completed' || 
          (c.callStatus === 'Interested' && c.conversationNotes && c.conversationNotes.length > 50)) {
        sqlSet.add(contactId);
      }
    });

    // Get WON from ProjectContact stage
    const wonCount = await ProjectContact.countDocuments({
      ...projectFilter,
      stage: 'WON'
    });

    const callFunnelData = {
      prospectData: totalProspects,
      // New 10-stage structure
      callsAttempted: callsAttemptedSet.size,
      callsConnected: callsConnectedSet.size,
      decisionMakerReached: decisionMakerReachedSet.size,
      interested: interestedSet.size,
      detailsShared: detailsSharedSet.size,
      demoBooked: demoBookedSet.size,
      demoCompleted: demoCompletedSet.size,
      sql: sqlSet.size,
      won: wonCount,
      // Legacy fields for backward compatibility
      callSent: callsAttemptedSet.size,
      accepted: callsConnectedSet.size,
      followups: 0, // Removed in new structure
      cip: 0, // Removed in new structure
      meetingProposed: 0, // Removed in new structure
      scheduled: demoBookedSet.size,
      completed: demoCompletedSet.size
    };
    
    // Calculate Email Funnel
    const emailFunnelData = {
      prospectData: totalProspects,
      emailSent: emailFunnel.filter(e => e.emailDate).length,
      accepted: emailFunnel.filter(e => ['Interested', 'Meeting Proposed'].includes(e.status)).length,
      followups: emailFunnel.filter(e => e.outcome && e.outcome.toLowerCase().includes('follow')).length,
      cip: emailFunnel.filter(e => e.status === 'CIP').length,
      meetingProposed: emailFunnel.filter(e => e.status === 'Meeting Proposed').length,
      scheduled: emailFunnel.filter(e => e.status === 'Meeting Scheduled').length,
      completed: emailFunnel.filter(e => e.status === 'Meeting Completed').length,
      sql: emailFunnel.filter(e => e.status === 'SQL' || e.status === 'Meeting Completed').length
    };
    
    // Calculate LinkedIn Funnel - prioritize most recent status
    // Use Sets to track unique contacts at each stage, with hierarchical logic
    const linkedinConnectionSentSet = new Set();
    const linkedinAcceptedSet = new Set();
    const linkedinCipSet = new Set();
    const linkedinMeetingProposedSet = new Set();
    const linkedinScheduledSet = new Set();
    const linkedinCompletedSet = new Set();
    const linkedinSqlSet = new Set();
    
    linkedinFunnel.forEach(l => {
      const contactId = l._id?.toString();
      if (!contactId) return;
      
      // Connection Request Sent
      if (l.lnRequestSent === 'Yes' || l.lnRequestSent === true) {
        linkedinConnectionSentSet.add(contactId);
      }
      
      // Determine the contact's current stage based on most recent status
      const currentStatus = l.status;
      
      // If status is CIP or higher, don't count in 'accepted' anymore
      // Accepted stage: connection accepted but status is empty or not CIP/higher
      if ((l.connected === 'Yes' || l.connected === true) && 
          (!currentStatus || currentStatus === '' || 
           (!['CIP', 'Meeting Proposed', 'Meeting Scheduled', 'Meeting Completed', 'SQL'].includes(currentStatus)))) {
        linkedinAcceptedSet.add(contactId);
      }
      
      // CIP - only if status is explicitly CIP
      if (currentStatus === 'CIP') {
        linkedinCipSet.add(contactId);
        // Remove from accepted if in CIP
        linkedinAcceptedSet.delete(contactId);
      }
      
      // Meeting Proposed
      if (currentStatus === 'Meeting Proposed') {
        linkedinMeetingProposedSet.add(contactId);
        linkedinAcceptedSet.delete(contactId);
        linkedinCipSet.delete(contactId);
      }
      
      // Meeting Scheduled
      if (currentStatus === 'Meeting Scheduled') {
        linkedinScheduledSet.add(contactId);
        linkedinAcceptedSet.delete(contactId);
        linkedinCipSet.delete(contactId);
        linkedinMeetingProposedSet.delete(contactId);
      }
      
      // Meeting Completed
      if (currentStatus === 'Meeting Completed') {
        linkedinCompletedSet.add(contactId);
        linkedinAcceptedSet.delete(contactId);
        linkedinCipSet.delete(contactId);
        linkedinMeetingProposedSet.delete(contactId);
        linkedinScheduledSet.delete(contactId);
      }
      
      // SQL
      if (currentStatus === 'SQL' || currentStatus === 'Meeting Completed') {
        linkedinSqlSet.add(contactId);
      }
    });
    
    const linkedinFunnelData = {
      prospectData: totalProspects,
      connectionSent: linkedinConnectionSentSet.size,
      accepted: linkedinAcceptedSet.size,
      followups: linkedinFunnel.filter(l => l.status && l.status !== 'CIP' && l.status !== '').length,
      cip: linkedinCipSet.size,
      meetingProposed: linkedinMeetingProposedSet.size,
      scheduled: linkedinScheduledSet.size,
      completed: linkedinCompletedSet.size,
      sql: linkedinSqlSet.size
    };
    
    // Process conversion metrics
    const conversionData = conversionMetrics[0] || {
      total: 0,
      won: 0,
      lost: 0,
      meetings: 0,
      sql: 0,
      cip: 0
    };
    
    const winRate = conversionData.total > 0 
      ? ((conversionData.won / conversionData.total) * 100).toFixed(1)
      : 0;
    const meetingRate = conversionData.total > 0
      ? ((conversionData.meetings / conversionData.total) * 100).toFixed(1)
      : 0;
    
    // Process activity trends
    const trendData = {};
    activityTrends.forEach(item => {
      const date = item._id.date;
      if (!trendData[date]) {
        trendData[date] = { call: 0, email: 0, linkedin: 0 };
      }
      trendData[date][item._id.type] = item.count;
    });
    
    const trendLabels = Object.keys(trendData).sort();
    const trendCallData = trendLabels.map(date => trendData[date].call || 0);
    const trendEmailData = trendLabels.map(date => trendData[date].email || 0);
    const trendLinkedInData = trendLabels.map(date => trendData[date].linkedin || 0);
    
    // Get project info if specific project
    let projectInfo = null;
    if (projectId && mongoose.Types.ObjectId.isValid(projectId)) {
      const project = await Project.findById(projectId).lean();
      if (project) {
        projectInfo = {
          id: project._id.toString(),
          companyName: project.companyName,
          status: project.status
        };
      }
    }
    
    res.json({
      success: true,
      data: {
        project: projectInfo,
        overview: {
          totalProspects,
          totalActivities: activitiesByType.reduce((sum, a) => sum + a.count, 0)
        },
        prospects: {
          byStage: prospectsByStage.map(item => ({
            stage: item._id,
            count: item.count
          })),
          byPriority: prospectsByPriority.map(item => ({
            priority: item._id,
            count: item.count
          })),
          stageDistribution: stageDistribution.map(item => ({
            stage: item._id,
            count: item.count,
            avgPriority: item.avgPriority ? parseFloat(item.avgPriority.toFixed(2)) : 0
          }))
        },
        activities: {
          byType: activitiesByType.map(item => ({
            type: item._id,
            count: item.count
          })),
          byDate: activitiesByDate,
          trends: {
            labels: trendLabels,
            call: trendCallData,
            email: trendEmailData,
            linkedin: trendLinkedInData
          }
        },
        funnels: {
          coldCalling: callFunnelData,
          email: emailFunnelData,
          linkedin: linkedinFunnelData
        },
        pipeline: {
          conversion: {
            winRate: parseFloat(winRate),
            meetingRate: parseFloat(meetingRate),
            total: conversionData.total,
            won: conversionData.won,
            lost: conversionData.lost,
            meetings: conversionData.meetings,
            sql: conversionData.sql,
            cip: conversionData.cip
          }
        },
        team: {
          performance: teamPerformance.map(member => ({
            id: member._id?.toString(),
            name: member.name || 'Unknown',
            email: member.email || '',
            totalActivities: member.activityCount,
            calls: member.calls,
            emails: member.emails,
            linkedin: member.linkedin
          }))
        },
        topPerformers: topPerformers.map(prospect => ({
          id: prospect._id?.toString(),
          name: prospect.name || 'Unknown',
          company: prospect.company || '',
          activityCount: prospect.activityCount,
          lastActivity: prospect.lastActivity
        })),
        recent: {
          activities: recentActivities
        }
      }
    });
  } catch (error) {
    console.error('Error fetching prospect analytics:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch prospect analytics'
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

    // Use aggregation for better performance - single query instead of populate + manual fetch
    const User = require('../models/User');
    const projects = await Project.aggregate([
      { $match: filter },
      {
        $lookup: {
          from: 'users',
          localField: 'createdBy',
          foreignField: '_id',
          as: 'createdByUser'
        }
      },
      {
        $unwind: {
          path: '$createdByUser',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $lookup: {
          from: 'projectcontacts',
          let: { projectId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: ['$projectId', '$$projectId']
                }
              }
            },
            {
              $count: 'count'
            }
          ],
          as: 'prospectCountArray'
        }
      },
      {
        $lookup: {
          from: 'projectcontacts',
          let: { projectId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$projectId', '$$projectId'] },
                    { $in: ['$stage', ['SQL', 'WON']] }
                  ]
                }
              }
            },
            {
              $count: 'count'
            }
          ],
          as: 'leadsCountArray'
        }
      },
      {
        $project: {
          companyName: 1,
          website: 1,
          city: 1,
          country: 1,
          industry: 1,
          companySize: 1,
          companyDescription: 1,
          contactPerson: 1,
          campaignDetails: 1,
          channels: 1,
          icpDefinition: 1,
          assignedTo: 1,
          teamAllocation: 1,
          status: 1,
          createdAt: 1,
          updatedAt: 1,
          totalProspects: {
            $let: {
              vars: {
                countDoc: { $arrayElemAt: ['$prospectCountArray', 0] }
              },
              in: {
                $ifNull: ['$$countDoc.count', 0]
              }
            }
          },
          leadsGenerated: {
            $let: {
              vars: {
                countDoc: { $arrayElemAt: ['$leadsCountArray', 0] }
              },
              in: {
                $ifNull: ['$$countDoc.count', 0]
              }
            }
          },
          createdBy: {
            $cond: {
              if: { $ne: ['$createdByUser', null] },
              then: {
                name: '$createdByUser.name',
                email: '$createdByUser.email'
              },
              else: null
            }
          }
        }
      },
      { $sort: { createdAt: -1 } }
    ]);

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
    const projectId = req.params.id;

    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid project ID format'
      });
    }

    const project = await Project.findOne({
      _id: projectId
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
    const projectId = req.params.id;
    const page = parseInt(req.query.page) || 1;
    // Increased limit to 10000 to handle large prospect lists
    // If no limit is specified, fetch all prospects (set to a high number)
    const limit = parseInt(req.query.limit) || 10000;
    const skip = (page - 1) * limit;

    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid project ID format'
      });
    }

    // Use aggregation for better performance with large datasets
    const projectObjectId = new mongoose.Types.ObjectId(projectId);

    // Check if project exists (lightweight check)
    const projectExists = await Project.exists({ _id: projectObjectId });
    if (!projectExists) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    // Use aggregation pipeline for better performance
    // This avoids the N+1 query problem of populate()
    // We check both ProspectContact and Contact collections to handle legacy data
    const pipeline = [
      // Match project contacts
      {
        $match: { projectId: projectObjectId }
      },
      // Lookup prospect contacts first (new collection)
      {
        $lookup: {
          from: PROSPECT_CONTACT_COLLECTION, // MongoDB collection name (dynamically retrieved)
          localField: 'contactId',
          foreignField: '_id',
          as: 'prospectContact'
        }
      },
      // Also lookup in Contact collection (legacy collection)
      {
        $lookup: {
          from: 'contacts', // Legacy Contact collection
          localField: 'contactId',
          foreignField: '_id',
          as: 'legacyContact'
        }
      },
      // Combine both lookups - prefer ProspectContact, fallback to Contact
      {
        $project: {
          contact: {
            $cond: {
              if: { $gt: [{ $size: '$prospectContact' }, 0] },
              then: { $arrayElemAt: ['$prospectContact', 0] },
              else: { $arrayElemAt: ['$legacyContact', 0] }
            }
          },
          stage: 1,
          assignedTo: 1,
          priority: 1,
          projectContactId: '$_id',
          createdAt: 1
        }
      },
      // Filter out entries where neither contact was found
      {
        $match: {
          contact: { $ne: null }
        }
      },
      // Filter out default/test prospects (no email AND no phone)
      // These are typically test/sample data that should not be shown
      // Keep prospects that have at least email OR phone
      {
        $match: {
          $or: [
            { 'contact.email': { $exists: true, $ne: '', $ne: null } },
            { 'contact.firstPhone': { $exists: true, $ne: '', $ne: null } }
          ]
        }
      },
      // Project only needed fields
      {
        $project: {
          _id: '$contact._id',
          name: '$contact.name',
          title: '$contact.title',
          company: '$contact.company',
          email: '$contact.email',
          firstPhone: '$contact.firstPhone',
          category: '$contact.category',
          industry: '$contact.industry',
          keywords: '$contact.keywords',
          city: '$contact.city',
          state: '$contact.state',
          country: '$contact.country',
          companyCity: '$contact.companyCity',
          companyState: '$contact.companyState',
          companyCountry: '$contact.companyCountry',
          personLinkedinUrl: '$contact.personLinkedinUrl',
          companyLinkedinUrl: '$contact.companyLinkedinUrl',
          website: '$contact.website',
          employees: '$contact.employees',
          projectContactId: '$projectContactId',
          stage: { $ifNull: ['$stage', 'New'] },
          assignedTo: { $ifNull: ['$assignedTo', ''] },
          priority: { $ifNull: ['$priority', 'Medium'] },
          isImported: { $literal: true },
          matchType: { $literal: 'imported' }
        }
      },
      // Sort by creation date (newest first)
      {
        $sort: { _id: -1 }
      }
    ];

    // Get total count for pagination (checking both collections)
    const countPipeline = [
      { $match: { projectId: projectObjectId } },
      {
        $lookup: {
          from: 'prospectcontacts',
          localField: 'contactId',
          foreignField: '_id',
          as: 'prospectContact'
        }
      },
      {
        $lookup: {
          from: 'contacts',
          localField: 'contactId',
          foreignField: '_id',
          as: 'legacyContact'
        }
      },
      {
        $project: {
          contact: {
            $cond: {
              if: { $gt: [{ $size: '$prospectContact' }, 0] },
              then: { $arrayElemAt: ['$prospectContact', 0] },
              else: { $arrayElemAt: ['$legacyContact', 0] }
            }
          }
        }
      },
      {
        $match: {
          contact: { $ne: null },
          // Filter out default/test prospects (no email AND no phone)
          $or: [
            { 'contact.email': { $exists: true, $ne: '', $ne: null } },
            { 'contact.firstPhone': { $exists: true, $ne: '', $ne: null } }
          ]
        }
      },
      { $count: 'total' }
    ];

    // Execute queries in parallel to get ProjectContact-based prospects
    // Note: We don't apply pagination here - we'll do it after combining with activity-based prospects
    const [contactsResult, countResult] = await Promise.all([
      ProjectContact.aggregate([
        ...pipeline
        // Pagination removed - will be applied after combining results
      ]),
      ProjectContact.aggregate(countPipeline)
    ]);

    // Also get prospects that have activities for this project but no ProjectContact entry
    const activitiesWithContacts = await Activity.aggregate([
      {
        $match: {
          projectId: projectObjectId,
          contactId: { $ne: null, $exists: true }
        }
      },
      {
        $group: {
          _id: '$contactId'
        }
      }
    ]);

    const activityContactIds = activitiesWithContacts.map(a => a._id).filter(id => id != null);
    
    // Get contactIds that already have ProjectContact entries
    const existingProjectContacts = await ProjectContact.find(
      { projectId: projectObjectId },
      { contactId: 1 }
    ).lean();
    const existingContactIds = new Set(
      existingProjectContacts
        .map(pc => pc.contactId)
        .filter(id => id != null)
        .map(id => id.toString())
    );

    // Find contactIds with activities but no ProjectContact entry
    const missingContactIds = activityContactIds.filter(
      contactId => {
        if (!contactId) return false;
        const contactIdStr = contactId.toString();
        return !existingContactIds.has(contactIdStr);
      }
    );

    // Fetch prospects that have activities but no ProjectContact entry
    // Check both ProspectContact and Contact collections
    let additionalProspects = [];
    if (missingContactIds.length > 0) {
      const missingObjectIds = missingContactIds.map(id => new mongoose.Types.ObjectId(id));
      
      // Try to find in ProspectContact first
      const prospectContacts = await ProspectContact.find(
        { _id: { $in: missingObjectIds } }
      ).lean();
      
      // Find which IDs were found in ProspectContact
      const foundInProspectContact = new Set(
        prospectContacts.map(pc => pc._id.toString())
      );
      
      // Find remaining IDs that weren't in ProspectContact, check Contact collection
      const remainingIds = missingObjectIds.filter(
        id => !foundInProspectContact.has(id.toString())
      );
      
      let legacyContacts = [];
      if (remainingIds.length > 0) {
        legacyContacts = await Contact.find(
          { _id: { $in: remainingIds } }
        ).lean();
      }
      
      // Combine both results
      const allAdditionalContacts = [...prospectContacts, ...legacyContacts];
      
      // Format additional prospects to match the structure of contactsResult
      additionalProspects = allAdditionalContacts.map(contact => ({
        _id: contact._id,
        name: contact.name,
        title: contact.title,
        company: contact.company,
        email: contact.email,
        firstPhone: contact.firstPhone,
        category: contact.category,
        industry: contact.industry,
        keywords: contact.keywords,
        city: contact.city,
        state: contact.state,
        country: contact.country,
        companyCity: contact.companyCity,
        companyState: contact.companyState,
        companyCountry: contact.companyCountry,
        personLinkedinUrl: contact.personLinkedinUrl,
        companyLinkedinUrl: contact.companyLinkedinUrl,
        website: contact.website,
        employees: contact.employees,
        projectContactId: null, // No ProjectContact entry
        stage: 'New', // Default stage
        assignedTo: '', // Default assignedTo
        priority: 'Medium', // Default priority
        isImported: false,
        matchType: 'activity'
      }));
    }

    // Combine results and remove duplicates (in case a prospect appears in both)
    const allContactsMap = new Map();
    
    // Add ProjectContact-based prospects
    contactsResult.forEach(contact => {
      allContactsMap.set(contact._id.toString(), contact);
    });
    
    // Add activity-based prospects (only if not already present)
    additionalProspects.forEach(contact => {
      if (!allContactsMap.has(contact._id.toString())) {
        allContactsMap.set(contact._id.toString(), contact);
      }
    });

    // Convert map to array and sort
    const allContacts = Array.from(allContactsMap.values()).sort((a, b) => {
      // Sort by _id descending (newest first)
      // Handle both ObjectId and string _id
      const aId = a._id instanceof mongoose.Types.ObjectId ? a._id : new mongoose.Types.ObjectId(a._id);
      const bId = b._id instanceof mongoose.Types.ObjectId ? b._id : new mongoose.Types.ObjectId(b._id);
      return bId.getTimestamp() - aId.getTimestamp();
    });

    // Apply pagination to combined results
    const paginatedContacts = allContacts.slice(skip, skip + limit);
    // Total includes both ProjectContact entries and activity-based prospects
    const total = allContacts.length;
    const totalPages = Math.ceil(total / limit);

    res.json({
      success: true,
      data: paginatedContacts,
      pagination: {
        page,
        limit,
        total,
        totalPages
      }
    });
  } catch (error) {
    console.error('Error fetching project contacts:', error);
    
    // Provide more specific error messages
    if (error.code === 'ECONNRESET' || error.message.includes('connection')) {
      return res.status(503).json({
        success: false,
        error: 'Database connection was interrupted. Please try again.'
      });
    }
    
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch project contacts'
    });
  }
});

// Get similar contacts for a project
router.get('/:id/similar-contacts', authenticate, async (req, res) => {
  try {
    const projectId = req.params.id;

    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid project ID format'
      });
    }

    const project = await Project.findOne({
      _id: projectId
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
      // Return only imported contacts if no ICP is defined (use aggregation for better performance)
      const projectObjectId = new mongoose.Types.ObjectId(projectId);
      const importedProjectContacts = await ProjectContact.aggregate([
        { $match: { projectId: projectObjectId } },
        {
          $lookup: {
            from: PROSPECT_CONTACT_COLLECTION,
            localField: 'contactId',
            foreignField: '_id',
            as: 'contact'
          }
        },
        { $unwind: { path: '$contact', preserveNullAndEmptyArrays: false } },
        {
          $project: {
            _id: '$contact._id',
            name: '$contact.name',
            title: '$contact.title',
            company: '$contact.company',
            email: '$contact.email',
            firstPhone: '$contact.firstPhone',
            category: '$contact.category',
            industry: '$contact.industry',
            keywords: '$contact.keywords',
            city: '$contact.city',
            state: '$contact.state',
            country: '$contact.country',
            companyCity: '$contact.companyCity',
            companyState: '$contact.companyState',
            companyCountry: '$contact.companyCountry',
            personLinkedinUrl: '$contact.personLinkedinUrl',
            companyLinkedinUrl: '$contact.companyLinkedinUrl',
            website: '$contact.website',
            employees: '$contact.employees',
            projectContactId: '$_id',
            stage: { $ifNull: ['$stage', 'New'] },
            assignedTo: { $ifNull: ['$assignedTo', ''] },
            priority: { $ifNull: ['$priority', 'Medium'] },
            isImported: { $literal: true },
            matchType: { $literal: 'imported' }
          }
        }
      ]);

      // Contacts are already formatted by aggregation pipeline
      const contacts = importedProjectContacts;

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
      // Use aggregation for better performance
      const projectObjectId = new mongoose.Types.ObjectId(projectId);
      const importedProjectContacts = await ProjectContact.aggregate([
        { $match: { projectId: projectObjectId } },
        {
          $lookup: {
            from: PROSPECT_CONTACT_COLLECTION,
            localField: 'contactId',
            foreignField: '_id',
            as: 'contact'
          }
        },
        { $unwind: { path: '$contact', preserveNullAndEmptyArrays: false } },
        {
          $project: {
            _id: '$contact._id',
            name: '$contact.name',
            title: '$contact.title',
            company: '$contact.company',
            email: '$contact.email',
            firstPhone: '$contact.firstPhone',
            category: '$contact.category',
            industry: '$contact.industry',
            keywords: '$contact.keywords',
            city: '$contact.city',
            state: '$contact.state',
            country: '$contact.country',
            companyCity: '$contact.companyCity',
            companyState: '$contact.companyState',
            companyCountry: '$contact.companyCountry',
            personLinkedinUrl: '$contact.personLinkedinUrl',
            companyLinkedinUrl: '$contact.companyLinkedinUrl',
            website: '$contact.website',
            employees: '$contact.employees',
            projectContactId: '$_id',
            stage: { $ifNull: ['$stage', 'New'] },
            assignedTo: { $ifNull: ['$assignedTo', ''] },
            priority: { $ifNull: ['$priority', 'Medium'] },
            isImported: { $literal: true },
            matchType: { $literal: 'imported' }
          }
        }
      ]);

      // Contacts are already formatted by aggregation pipeline
      const contacts = importedProjectContacts;

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
      if (pc._id) {
        const contactId = pc._id.toString();
        importedContactIds.add(contactId);
        importedContactMap.set(contactId, {
          stage: pc.stage,
          assignedTo: pc.assignedTo,
          priority: pc.priority,
          projectContactId: pc.projectContactId
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
    // Contacts are already formatted by aggregation pipeline
    const allContacts = importedProjectContacts.map(pc => ({
      ...pc,
      isImported: true,
      matchType: 'imported',
      matchScore: 100 // Imported contacts have highest priority
    }));

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
    const projectId = req.params.id;

    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid project ID format'
      });
    }

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
      _id: projectId,
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

// Delete project contacts (bulk remove prospects from project)
// IMPORTANT: This route must come BEFORE the generic /:id route to avoid route matching conflicts
router.delete('/:projectId/project-contacts', authenticate, async (req, res) => {
  try {
    const { projectId } = req.params;
    const { contactIds } = req.body; // Array of contact IDs to remove

    // Validate projectId ObjectId
    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid project ID format'
      });
    }

    if (!contactIds || !Array.isArray(contactIds) || contactIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Contact IDs array is required'
      });
    }

    // Validate all contact IDs are valid ObjectIds
    const invalidContactIds = contactIds.filter(id => !mongoose.Types.ObjectId.isValid(id));
    if (invalidContactIds.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Invalid contact ID(s): ${invalidContactIds.join(', ')}`
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
    const projectContactResult = await ProjectContact.deleteMany({
      projectId: projectId,
      contactId: { $in: contactObjectIds }
    });

    // Also delete prospects from ProspectContact collection (database)
    const prospectContactResult = await ProspectContact.deleteMany({
      _id: { $in: contactObjectIds }
    });

    // Also delete related activities for these contacts in this project
    const activityResult = await Activity.deleteMany({
      projectId: projectId,
      contactId: { $in: contactObjectIds }
    });

    const totalDeleted = projectContactResult.deletedCount;

    res.json({
      success: true,
      message: `Successfully deleted ${totalDeleted} prospect(s) from project and database`,
      data: {
        deletedCount: totalDeleted,
        projectContactsDeleted: projectContactResult.deletedCount,
        prospectsDeleted: prospectContactResult.deletedCount,
        activitiesDeleted: activityResult.deletedCount
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

// Delete a project
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const projectId = req.params.id;

    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid project ID format'
      });
    }

    const project = await Project.findOneAndDelete({
      _id: projectId,
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

// Helper function to normalize column names (removes spaces, special chars, converts to lowercase)
function normalizeColumnName(name) {
  if (!name) return '';
  return name.trim().toLowerCase()
    .replace(/#/g, '') // Remove # symbol
    .replace(/\*/g, '') // Remove * symbol
    .replace(/\s+/g, '') // Remove all spaces
    .replace(/[_-]/g, '') // Remove underscores and hyphens
    .replace(/\./g, '') // Remove dots
    .replace(/[^\w]/g, ''); // Remove any other non-word characters
}

// Map normalized column names to our schema fields (with multiple variations)
const columnMapping = {
  // Name variations
  'name': 'name',
  'fullname': 'name',
  'contactname': 'name',
  'personname': 'name',
  'fullname': 'name',
  'contact': 'name',
  'person': 'name',
  'firstnamelastname': 'name',
  'first name last name': 'name',
  
  // First Name (separate field)
  'firstname': 'firstname',
  'first name': 'firstname',
  
  // Last Name (separate field)
  'lastname': 'lastname',
  'last name': 'lastname',
  
  // Title variations
  'title': 'title',
  'jobtitle': 'title',
  'job title': 'title',
  'position': 'title',
  'designation': 'title',
  '*designation': 'title',
  'role': 'title',
  'job': 'title',
  'jobposition': 'title',
  'job position': 'title',
  'jobrole': 'title',
  'job role': 'title',
  'positiontitle': 'title',
  'position title': 'title',
  
  // Company variations
  'company': 'company',
  'companyname': 'company',
  'company name': 'company',
  'organization': 'company',
  'org': 'company',
  'firm': 'company',
  'business': 'company',
  'corporation': 'company',
  'corp': 'company',
  'companyname': 'company',
  'organizationname': 'company',
  'organization name': 'company',
  
  // Email variations
  'email': 'email',
  'emailaddress': 'email',
  'email address': 'email',
  'mail': 'email',
  'e-mail': 'email',
  'emailid': 'email',
  'email id': 'email',
  'e mail': 'email',
  'emailaddress': 'email',
  
  // Phone variations
  'firstphone': 'firstPhone',
  'first phone': 'firstPhone',
  'firstphone#': 'firstPhone', // For "First Phone #" header
  'first phone #': 'firstPhone',
  'phone': 'firstPhone',
  'phonenumber': 'firstPhone',
  'phone number': 'firstPhone',
  'contactnumber': 'firstPhone',
  'contact number': 'firstPhone',
  'mobilenumber': 'firstPhone',
  'mobile number': 'firstPhone',
  'mobile': 'firstPhone',
  'telephone': 'firstPhone',
  'tel': 'firstPhone',
  'cell': 'firstPhone',
  'cellphone': 'firstPhone',
  'cell phone': 'firstPhone',
  
  // Employees variations
  'employees': 'employees',
  'noofemployees': 'employees',
  'numberofemployees': 'employees',
  'employee': 'employees',
  'emp': 'employees',
  'employeecount': 'employees',
  'companysize': 'employees',
  '# employees': 'employees',
  '#employees': 'employees',
  'employees': 'employees',
  'no of employees': 'employees',
  'number of employees': 'employees',
  
  // Category
  'category': 'category',
  'cat': 'category',
  'type': 'category',
  'campaign': 'category', // Some CSVs use Campaign? column
  
  // Industry
  'industry': 'industry',
  'sector': 'industry',
  'businesssector': 'industry',
  'business sector': 'industry',
  
  // Keywords
  'keywords': 'keywords',
  'keyword': 'keywords',
  'tags': 'keywords',
  'tag': 'keywords',
  
  // LinkedIn URLs - comprehensive variations
  'personlinkedinurl': 'personLinkedinUrl',
  'personlinkedin': 'personLinkedinUrl',
  'personlin': 'personLinkedinUrl', // For "Person Lin" header
  'linkedinurl': 'personLinkedinUrl',
  'linkedin': 'personLinkedinUrl',
  'linkedinprofile': 'personLinkedinUrl',
  'personlinkedinprofile': 'personLinkedinUrl',
  'linkedinprofileurl': 'personLinkedinUrl',
  'person linkedin url': 'personLinkedinUrl',
  'person linkedin': 'personLinkedinUrl',
  'linkedin url': 'personLinkedinUrl',
  'linkedin profile': 'personLinkedinUrl',
  'person linkedin profile': 'personLinkedinUrl',
  'person linkedinprofile': 'personLinkedinUrl',
  'personlinkedin url': 'personLinkedinUrl',
  'person linkedinurl': 'personLinkedinUrl',
  'linkedinprofile url': 'personLinkedinUrl',
  'linkedin profile url': 'personLinkedinUrl',
  'person linkedin profile url': 'personLinkedinUrl',
  // Case variations
  'linkedin': 'personLinkedinUrl',
  'linkedinurl': 'personLinkedinUrl',
  'linkedin url': 'personLinkedinUrl',
  'linkedinprofile': 'personLinkedinUrl',
  'personlinkedin': 'personLinkedinUrl',
  'person linkedin': 'personLinkedinUrl',
  'personlinkedinurl': 'personLinkedinUrl',
  'person linkedin url': 'personLinkedinUrl',
  
  // Website
  'website': 'website',
  'web': 'website',
  'url': 'website',
  'websiteurl': 'website',
  'site': 'website',
  'webaddress': 'website',
  
  // Company LinkedIn
  'companylinkedinurl': 'companyLinkedinUrl',
  'companylinkedin': 'companyLinkedinUrl',
  'companylinkedinprofile': 'companyLinkedinUrl',
  'companylinkedinurl': 'companyLinkedinUrl',
  
  // Social Media
  'facebookurl': 'facebookUrl',
  'facebook': 'facebookUrl',
  'fb': 'facebookUrl',
  'fburl': 'facebookUrl',
  'twitterurl': 'twitterUrl',
  'twitter': 'twitterUrl',
  'x': 'twitterUrl',
  'twitterurl': 'twitterUrl',
  
  // Location
  'city': 'city',
  'personcity': 'city',
  'location': 'city',
  'state': 'state',
  'personstate': 'state',
  'province': 'state',
  'region': 'state',
  'country': 'country',
  'personcountry': 'country',
  'nation': 'country',
  
  // Company Address
  'companyaddress': 'companyAddress',
  'address': 'companyAddress',
  'companyaddr': 'companyAddress',
  'companyaddress': 'companyAddress',
  'companycity': 'companyCity',
  'companystate': 'companyState',
  'companycountry': 'companyCountry',
  'companyphone': 'companyPhone',
  'companyphonenumber': 'companyPhone',
  'companytel': 'companyPhone',
  'companytelephone': 'companyPhone',
  
  // Additional fields
  'seodescription': 'seoDescription',
  'seodescr': 'seoDescription', // For "SEO Descr" header
  'description': 'seoDescription',
  'about': 'seoDescription',
  'companydescription': 'seoDescription',
  'bio': 'seoDescription',
  'technologies': 'technologies',
  'tech': 'technologies',
  'technology': 'technologies',
  'techstack': 'technologies',
  'annualrevenue': 'annualRevenue',
  'revenue': 'annualRevenue',
  'annualrevenue': 'annualRevenue',
  'yearlyrevenue': 'annualRevenue'
};

// Function to find the best matching field for a column name
function findMatchingField(columnName) {
  if (!columnName || typeof columnName !== 'string') {
    return null;
  }
  
  const normalized = normalizeColumnName(columnName);
  const lowerColumn = columnName.toLowerCase().trim();
  
  // Direct match with normalized key
  if (columnMapping[normalized]) {
    return columnMapping[normalized];
  }
  
  // Direct match with lowercase key (handles case variations)
  if (columnMapping[lowerColumn]) {
    return columnMapping[lowerColumn];
  }
  
  // Remove common separators and try again
  const noSeparators = lowerColumn.replace(/[_\-\s\.]/g, '');
  if (columnMapping[noSeparators]) {
    return columnMapping[noSeparators];
  }
  
  // Partial match - check if normalized column contains any key or vice versa
  // Prioritize longer matches first
  const sortedKeys = Object.keys(columnMapping).sort((a, b) => b.length - a.length);
  for (const key of sortedKeys) {
    const keyLower = key.toLowerCase();
    const normalizedLower = normalized.toLowerCase();
    
    // Check if column contains key or key contains column (with minimum length)
    if ((normalizedLower.includes(keyLower) || keyLower.includes(normalizedLower)) && 
        (key.length >= 3 || normalized.length >= 3)) {
      return columnMapping[key];
    }
    
    // Also check without separators
    const keyNoSep = keyLower.replace(/[_\-\s\.]/g, '');
    const colNoSep = normalizedLower.replace(/[_\-\s\.]/g, '');
    if ((colNoSep.includes(keyNoSep) || keyNoSep.includes(colNoSep)) && 
        (keyNoSep.length >= 3 || colNoSep.length >= 3)) {
      return columnMapping[key];
    }
  }
  
  // Special handling for LinkedIn variations (case-insensitive, with/without spaces)
  const linkedinPatterns = [
    /linkedin/i,
    /linked\s*in/i,
    /lin\s*url/i,
    /linkedin\s*profile/i,
    /linkedin\s*url/i
  ];
  
  const isLinkedInField = linkedinPatterns.some(pattern => pattern.test(columnName));
  if (isLinkedInField) {
    // Check if it's person or company LinkedIn
    const isPersonLinkedIn = /person/i.test(columnName) || !/company/i.test(columnName);
    if (isPersonLinkedIn) {
      return 'personLinkedinUrl';
    } else {
      return 'companyLinkedinUrl';
    }
  }
  
  return null;
}

// Helper function to extract field value from normalized row using flexible matching
function extractFieldValue(normalizedRow, fieldName, additionalVariations = [], originalRow = null) {
  // First, try to find matching field using column mapping by checking all keys in normalizedRow
  // Prioritize longer keys first (more specific matches)
  const sortedKeys = Object.keys(normalizedRow).sort((a, b) => b.length - a.length);
  for (const key of sortedKeys) {
    const value = normalizedRow[key];
    // Allow empty strings but skip undefined and null
    if (value === undefined || value === null) continue;
    const matchedField = findMatchingField(key);
    if (matchedField === fieldName) {
      // Return the value as string, preserving empty strings
      const strValue = value !== undefined && value !== null ? String(value) : '';
      if (strValue.trim()) return strValue;
    }
  }
  
  // Also check original row keys if provided (for exact matches and case variations)
  if (originalRow) {
    const sortedOriginalKeys = Object.keys(originalRow).sort((a, b) => b.length - a.length);
    for (const key of sortedOriginalKeys) {
      const value = originalRow[key];
      // Allow empty strings but skip undefined and null
      if (value === undefined || value === null) continue;
      const matchedField = findMatchingField(key);
      if (matchedField === fieldName) {
        // Return the value as string, preserving empty strings
        const strValue = value !== undefined && value !== null ? String(value) : '';
        if (strValue.trim()) return strValue;
      }
    }
  }
  
  // Also try direct normalized variations (with all possible normalizations)
  const allVariations = [fieldName, ...additionalVariations];
  for (const variation of allVariations) {
    // Try multiple normalization approaches
    const normalized = normalizeColumnName(variation);
    if (normalizedRow[normalized] !== undefined && normalizedRow[normalized] !== null) {
      const strValue = String(normalizedRow[normalized]);
      if (strValue.trim()) return strValue;
    }
    
    // Try lowercase version
    const lowerVariation = variation.toLowerCase().trim();
    if (normalizedRow[lowerVariation] !== undefined && normalizedRow[lowerVariation] !== null) {
      const strValue = String(normalizedRow[lowerVariation]);
      if (strValue.trim()) return strValue;
    }
    
    // Try without separators
    const noSepVariation = lowerVariation.replace(/[_\-\s\.]/g, '');
    if (normalizedRow[noSepVariation] !== undefined && normalizedRow[noSepVariation] !== null) {
      const strValue = String(normalizedRow[noSepVariation]);
      if (strValue.trim()) return strValue;
    }
    
    // Try with spaces replaced by nothing (for "Person Linkedin Url" -> "personlinkedinurl")
    const noSpaces = lowerVariation.replace(/\s+/g, '');
    if (normalizedRow[noSpaces] !== undefined && normalizedRow[noSpaces] !== null) {
      const strValue = String(normalizedRow[noSpaces]);
      if (strValue.trim()) return strValue;
    }
  }
  
  // For LinkedIn URL specifically, do additional fuzzy matching
  if (fieldName === 'personLinkedinUrl' && originalRow) {
    for (const [key, value] of Object.entries(originalRow)) {
      if (!value || String(value).trim() === '') continue;
      const keyLower = key.toLowerCase().trim();
      // Check if key contains linkedin-related terms (case-insensitive)
      if ((keyLower.includes('linkedin') || keyLower.includes('linked in') || keyLower.includes('lin')) && 
          (keyLower.includes('person') || keyLower.includes('profile') || keyLower.includes('url') || !keyLower.includes('company'))) {
        const strValue = String(value).trim();
        if (strValue) return strValue;
      }
    }
  }
  
  return '';
}

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

    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid project ID format'
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
        const workbook = XLSX.read(req.file.buffer, { 
          type: 'buffer',
          cellDates: false,
          cellNF: false,
          cellText: false,
          raw: true, // Keep raw values to preserve data types
          codepage: 65001 // UTF-8
        });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        
        // Read Excel data - use default header behavior (first row as headers, returns objects)
        // This ensures all data is read correctly and headers are properly detected
        const rows = XLSX.utils.sheet_to_json(worksheet, {
          defval: null, // Use null for empty cells (we'll convert to empty string)
          raw: false, // Convert all values to formatted strings
          blankrows: true // Include all rows, even blank ones
        });
        
        // Process rows to ensure all data is preserved and properly formatted
        const processedRows = rows.map((row) => {
          const processedRow = {};
          // Process each key-value pair to preserve all data
          Object.keys(row).forEach(key => {
            const value = row[key];
            // Convert null/undefined to empty string, but preserve all other values
            if (value === null || value === undefined) {
              processedRow[key] = '';
            } else {
              // Convert to string and preserve the actual value
              processedRow[key] = String(value);
            }
          });
          return processedRow;
        });
        
        // Fix concatenated headers (e.g., "Full NameFirst NameLast Name" -> split into separate fields)
        // This handles cases where Excel headers are merged or concatenated
        const fixedRows = processedRows.map((row) => {
          const fixedRow = {};
          Object.keys(row).forEach(key => {
            const value = row[key];
            // Check if header might be concatenated (contains multiple field names)
            // Try to split common concatenated patterns
            if (key.toLowerCase().includes('fullname') && key.toLowerCase().includes('firstname') && key.toLowerCase().includes('lastname')) {
              // This is "Full NameFirst NameLast Name" - try to extract full name
              // For now, store under multiple keys
              fixedRow[key] = value; // Keep original
              fixedRow['Full Name'] = value; // Also store as "Full Name"
              fixedRow['fullname'] = value; // Normalized version
            } else if (key.toLowerCase().includes('designati')) {
              // Handle "*designati" or "*designation"
              fixedRow[key] = value;
              fixedRow['*designation'] = value;
              fixedRow['designation'] = value;
              fixedRow['title'] = value; // Also map to title
            } else if (key.toLowerCase().includes('employeeon') || key.toLowerCase().includes('employeelinkedin')) {
              // Handle "Employeeon" or "Employees on LinkedIn"
              fixedRow[key] = value;
              fixedRow['employees'] = value;
              fixedRow['Employees on LinkedIn'] = value;
            } else {
              fixedRow[key] = value;
            }
          });
          return fixedRow;
        });
        
        // Log for debugging - show what was read
        if (fixedRows.length > 0) {
          console.log(`Excel file parsed: ${fixedRows.length} rows found`);
          console.log(`First row column names:`, Object.keys(fixedRows[0]));
          console.log(`All column names:`, Object.keys(fixedRows[0]));
          if (fixedRows.length > 1) {
            console.log(`Sample data from row 2:`, Object.keys(fixedRows[1]).slice(0, 10).reduce((acc, key) => {
              acc[key] = fixedRows[1][key];
              return acc;
            }, {}));
          }
        }
        
        fixedRows.forEach((row, index) => {
          try {
            const rowNumber = index + 1;
            
            // Normalize column names (case-insensitive and remove spaces/special chars)
            // Store all possible variations for flexible matching
            const normalizedRow = {};
            Object.keys(row).forEach(key => {
              const value = row[key];
              // Allow empty strings, only skip undefined and null
              if (value === undefined || value === null) return;
              
              // Convert value to string for consistent handling
              const stringValue = value.toString();
              
              // Store with fully normalized key (no spaces, no special chars, lowercase)
              const fullyNormalized = normalizeColumnName(key);
              normalizedRow[fullyNormalized] = stringValue;
              
              // Store with spaces removed but lowercase
              const spaceRemoved = key.toLowerCase().trim().replace(/\s+/g, '');
              if (spaceRemoved && spaceRemoved !== fullyNormalized) {
                normalizedRow[spaceRemoved] = stringValue;
              }
              
              // Store original lowercase trimmed version
              const lowerTrimmed = key.toLowerCase().trim();
              if (lowerTrimmed && lowerTrimmed !== fullyNormalized && lowerTrimmed !== spaceRemoved) {
                normalizedRow[lowerTrimmed] = stringValue;
              }
              
              // Also store original key (for exact matches)
              normalizedRow[key] = stringValue;
              
              // Handle concatenated headers (e.g., "Full NameFirst NameLast Name")
              // Try to extract individual field names from concatenated headers
              const keyLower = key.toLowerCase();
              
              // IMPORTANT: Check for separate First Name and Last Name columns FIRST
              // This ensures we don't override them with concatenated header logic
              if (keyLower === 'first name' || keyLower === 'firstname' || 
                  (keyLower.includes('first') && keyLower.includes('name') && !keyLower.includes('full') && !keyLower.includes('last'))) {
                // This is a separate First Name column
                normalizedRow['firstname'] = stringValue;
                normalizedRow['first name'] = stringValue;
                // Don't set as fullname - keep it separate
              }
              
              if (keyLower === 'last name' || keyLower === 'lastname' || 
                  (keyLower.includes('last') && keyLower.includes('name') && !keyLower.includes('full') && !keyLower.includes('first'))) {
                // This is a separate Last Name column
                normalizedRow['lastname'] = stringValue;
                normalizedRow['last name'] = stringValue;
                // Don't set as fullname - keep it separate
              }
              
              // Check for concatenated "Full NameFirst NameLast Name" pattern
              // Only treat as concatenated if it contains ALL three terms
              if ((keyLower.includes('fullname') || keyLower.includes('full name')) && 
                  (keyLower.includes('firstname') || keyLower.includes('first name')) && 
                  (keyLower.includes('lastname') || keyLower.includes('last name'))) {
                // This is a concatenated header - the value should be the full name
                normalizedRow['fullname'] = stringValue;
                normalizedRow['name'] = stringValue;
                normalizedRow['full name'] = stringValue;
              } else if ((keyLower.includes('fullname') || keyLower.includes('full name')) && 
                         !keyLower.includes('first') && !keyLower.includes('last')) {
                // This is just "Full Name" without concatenation
                normalizedRow['fullname'] = stringValue;
                normalizedRow['name'] = stringValue;
              }
              if (keyLower.includes('designati') || keyLower.includes('designation')) {
                normalizedRow['designation'] = stringValue;
                normalizedRow['title'] = stringValue;
                normalizedRow['*designation'] = stringValue;
              }
              if ((keyLower.includes('employee') || keyLower.includes('emp')) && !keyLower.includes('phone')) {
                normalizedRow['employees'] = stringValue;
              }
            });

            // Get values using flexible field matching (pass original row for additional matching)
            // IMPORTANT: Extract First Name and Last Name FIRST before checking for Full Name
            // This ensures we get separate First/Last names when they exist as separate columns
            const firstName = extractFieldValue(normalizedRow, 'firstname', ['firstname', 'first name'], row);
            const lastName = extractFieldValue(normalizedRow, 'lastname', ['lastname', 'last name'], row);
            
            // Try to get Full Name field
            const fullName = extractFieldValue(normalizedRow, 'name', ['fullname', 'contactname', 'personname', 'full name', 'contact name', 'person name', 'name'], row);
            
            let name = '';
            // Priority logic:
            // 1. If we have both First Name and Last Name as separate columns, combine them
            // 2. Otherwise, use Full Name if available
            // 3. Otherwise, use First Name or Last Name alone if available
            if (firstName && firstName.trim() && lastName && lastName.trim()) {
              // We have both First and Last Name - combine them
              name = `${firstName.trim()} ${lastName.trim()}`.trim();
            } else if (firstName && firstName.trim()) {
              // Only First Name available
              name = firstName.trim();
            } else if (lastName && lastName.trim()) {
              // Only Last Name available
              name = lastName.trim();
            } else if (fullName && fullName.trim()) {
              // Use Full Name if available
              name = fullName.trim();
            } else if ((firstName && firstName.trim()) || (lastName && lastName.trim())) {
              // Fallback: combine whatever we have
              const first = firstName && firstName.trim() ? firstName.trim() : '';
              const last = lastName && lastName.trim() ? lastName.trim() : '';
              name = [first, last].filter(Boolean).join(' ').trim();
            }
            
            // If still no name, try to find it in any column that might contain a name
            if (!name || !name.trim()) {
              // Check original row for any field that might be a name
              for (const [key, value] of Object.entries(row)) {
                const keyLower = key.toLowerCase().trim();
                if ((keyLower.includes('name') || keyLower.includes('contact') || keyLower.includes('person')) && 
                    value && String(value).trim()) {
                  name = String(value).trim();
                  break;
                }
              }
            }
            
            const email = extractFieldValue(normalizedRow, 'email', ['emailaddress', 'email address', 'e-mail', 'mail'], row);
            const company = extractFieldValue(normalizedRow, 'company', ['companyname', 'company name', 'organization', 'org', 'firm'], row);
            const title = extractFieldValue(normalizedRow, 'title', ['jobtitle', 'job title', 'position', 'designation', '*designation', 'role'], row);
            const firstPhone = extractFieldValue(normalizedRow, 'firstPhone', ['firstphone', 'first phone', 'first phone #', 'firstphone#', 'phone', 'phonenumber', 'phone number', 'contactnumber', 'contact number', 'mobilenumber', 'mobile number', 'mobile', 'telephone', 'tel', 'cell', 'cellphone'], row);
            const employees = extractFieldValue(normalizedRow, 'employees', ['noofemployees', 'no of employees', 'numberofemployees', 'number of employees', 'employee', 'emp', 'employeecount', 'employee count', 'companysize', 'company size'], row);
            const category = extractFieldValue(normalizedRow, 'category', ['cat', 'type'], row);
            const industry = extractFieldValue(normalizedRow, 'industry', ['sector', 'businesssector', 'business sector'], row);
            const keywords = extractFieldValue(normalizedRow, 'keywords', ['keyword', 'tags', 'tag'], row);
            // Try to find LinkedIn URL - be very flexible since it might be in any column
            let personLinkedinUrl = extractFieldValue(normalizedRow, 'personLinkedinUrl', [
              'personlinkedinurl', 'person linkedin url', 'personlinkedin', 'person linkedin', 
              'person lin', 'personlin', 'linkedinurl', 'linkedin url', 'linkedin', 
              'linkedinprofile', 'linkedin profile', 'personlinkedinprofile', 'person linkedin profile',
              'LinkedIn', 'LinkedIn URL', 'LinkedIn Url', 'Person LinkedIn', 'Person LinkedIn URL',
              'Person LinkedIn Url', 'LinkedIn Profile', 'Person LinkedIn Profile', 'LinkedInProfile',
              'PersonLinkedIn', 'PersonLinkedInURL', 'PersonLinkedInUrl', 'linkedin', 'LinkedInURL',
              'person linkedinurl', 'personlinkedin url', 'linkedin profile url', 'person linkedin profile url',
              'linkedinprofileurl', 'personlinkedinprofileurl', 'person linkedinprofileurl'
            ], row);
            
            // If not found, search all columns for LinkedIn URLs (fuzzy search)
            if (!personLinkedinUrl || !personLinkedinUrl.trim()) {
              for (const [key, value] of Object.entries(row)) {
                if (!value || String(value).trim() === '') continue;
                const keyLower = key.toLowerCase();
                const valueStr = String(value).trim();
                
                // Check if column name suggests LinkedIn
                if ((keyLower.includes('linkedin') || keyLower.includes('linked in') || keyLower.includes('lin')) && 
                    !keyLower.includes('company')) {
                  // Check if value looks like a URL
                  if (valueStr.includes('linkedin.com') || valueStr.includes('linked.in') || valueStr.startsWith('http')) {
                    personLinkedinUrl = valueStr;
                    break;
                  }
                }
                
                // Also check if value itself is a LinkedIn URL (even if column name doesn't suggest it)
                if (valueStr.includes('linkedin.com/in/') || valueStr.includes('linkedin.com/company/')) {
                  // Only use if it's a person profile (not company)
                  if (valueStr.includes('/in/')) {
                    personLinkedinUrl = valueStr;
                    break;
                  }
                }
              }
            }
            const website = extractFieldValue(normalizedRow, 'website', ['web', 'url', 'websiteurl', 'website url', 'site', 'webaddress', 'web address'], row);
            const companyLinkedinUrl = extractFieldValue(normalizedRow, 'companyLinkedinUrl', ['companylinkedinurl', 'company linkedin url', 'companylinkedin', 'company linkedin', 'companylinkedinprofile', 'company linkedin profile'], row);
            const facebookUrl = extractFieldValue(normalizedRow, 'facebookUrl', ['facebookurl', 'facebook url', 'facebook', 'fb', 'fburl', 'fb url'], row);
            const twitterUrl = extractFieldValue(normalizedRow, 'twitterUrl', ['twitterurl', 'twitter url', 'twitter', 'x'], row);
            const city = extractFieldValue(normalizedRow, 'city', ['personcity', 'person city', 'location'], row);
            const state = extractFieldValue(normalizedRow, 'state', ['personstate', 'person state', 'province', 'region'], row);
            const country = extractFieldValue(normalizedRow, 'country', ['personcountry', 'person country', 'nation'], row);
            const companyAddress = extractFieldValue(normalizedRow, 'companyAddress', ['companyaddress', 'company address', 'address', 'companyaddr', 'company addr'], row);
            const companyCity = extractFieldValue(normalizedRow, 'companyCity', ['companycity', 'company city'], row);
            const companyState = extractFieldValue(normalizedRow, 'companyState', ['companystate', 'company state'], row);
            const companyCountry = extractFieldValue(normalizedRow, 'companyCountry', ['companycountry', 'company country'], row);
            const companyPhone = extractFieldValue(normalizedRow, 'companyPhone', ['companyphone', 'company phone', 'companyphonenumber', 'company phone number', 'companytel', 'company tel', 'companytelephone', 'company telephone'], row);
            const seoDescription = extractFieldValue(normalizedRow, 'seoDescription', ['seodescription', 'seo description', 'seo descr', 'seodescr', 'description', 'about', 'companydescription', 'company description', 'bio'], row);
            const technologies = extractFieldValue(normalizedRow, 'technologies', ['tech', 'technology', 'techstack', 'tech stack'], row);
            const annualRevenue = extractFieldValue(normalizedRow, 'annualRevenue', ['annualrevenue', 'annual revenue', 'revenue', 'yearlyrevenue', 'yearly revenue'], row);

            // Check if row has any data at all (from original row object)
            const rowHasData = Object.values(row).some(val => val !== undefined && val !== null && String(val).trim() !== '');
            
            // Skip completely empty rows (check if ALL fields are empty)
            // But be more lenient - if we have at least name, email, or company, process it
            const hasAnyData = (name && name.toString().trim()) || (email && email.toString().trim()) || (company && company.toString().trim()) || 
                             (title && title.toString().trim()) || (firstPhone && firstPhone.toString().trim()) || 
                             (employees && employees.toString().trim()) || (category && category.toString().trim()) || 
                             (industry && industry.toString().trim()) || (keywords && keywords.toString().trim()) || 
                             (personLinkedinUrl && personLinkedinUrl.toString().trim()) || (website && website.toString().trim()) || 
                             (companyLinkedinUrl && companyLinkedinUrl.toString().trim()) || (facebookUrl && facebookUrl.toString().trim()) || 
                             (twitterUrl && twitterUrl.toString().trim()) || (city && city.toString().trim()) || (state && state.toString().trim()) || 
                             (country && country.toString().trim()) || (companyAddress && companyAddress.toString().trim()) || 
                             (companyCity && companyCity.toString().trim()) || (companyState && companyState.toString().trim()) || 
                             (companyCountry && companyCountry.toString().trim()) || (companyPhone && companyPhone.toString().trim()) || 
                             (seoDescription && seoDescription.toString().trim()) || (technologies && technologies.toString().trim()) || 
                             (annualRevenue && annualRevenue.toString().trim());
            
            // If row has data but we couldn't map it, log for debugging
            if (rowHasData && !hasAnyData) {
              console.warn(`Excel Row ${rowNumber + 1} has data but couldn't map fields. Keys:`, Object.keys(row));
              errors.push(`Row ${rowNumber + 1}: Data present but no mappable fields found`);
            }
            
            if (!hasAnyData) {
              return; // Skip empty rows silently
            }

            // Validate required fields - ONLY use actual data from the file, no defaults
            const trimmedPersonLinkedinUrl = (personLinkedinUrl && personLinkedinUrl.toString().trim()) ? personLinkedinUrl.toString().trim() : '';
            if (!trimmedPersonLinkedinUrl) {
              // Log available columns for debugging (only for first few errors to avoid spam)
              if (errors.length < 3) {
                console.log('=== EXCEL ROW DEBUG ===');
                console.log('Row number:', rowNumber + 1);
                console.log('Available Excel columns:', Object.keys(row));
                console.log('Full row data:', row);
                console.log('Normalized row keys:', Object.keys(normalizedRow));
                console.log('Extracted values:', {
                  name: name || '(empty)',
                  email: email || '(empty)',
                  company: company || '(empty)',
                  personLinkedinUrl: personLinkedinUrl || '(empty)'
                });
                console.log('======================');
              }
              errors.push(`Row ${rowNumber + 1}: Person Linkedin Url is required`);
              return; // Skip this row
            }

            // ONLY use actual data from the file - NO default values
            // If a field is missing in the Excel file, it should remain empty, not be filled with defaults
            const trimmedName = (name && name.toString().trim()) ? name.toString().trim() : '';
            const trimmedEmail = (email && email.toString().trim()) ? email.toString().trim().toLowerCase() : '';
            const trimmedCompany = (company && company.toString().trim()) ? company.toString().trim() : '';
            
            // Validate that we have at least name or company (required fields)
            if (!trimmedName && !trimmedCompany) {
              errors.push(`Row ${rowNumber + 1}: Name or Company is required`);
              return; // Skip this row
            }

            // Create contact object with all fields
            contacts.push({
              name: trimmedName,
              email: trimmedEmail,
              company: trimmedCompany,
              title: (title && title.toString().trim()) ? title.toString().trim() : '',
              firstPhone: (firstPhone && firstPhone.toString().trim()) ? firstPhone.toString().trim() : '',
              employees: (employees && employees.toString().trim()) ? employees.toString().trim() : '',
              category: (category && category.toString().trim()) ? category.toString().trim() : '',
              industry: (industry && industry.toString().trim()) ? industry.toString().trim() : '',
              keywords: (keywords && keywords.toString().trim()) ? keywords.toString().trim() : '',
              personLinkedinUrl: trimmedPersonLinkedinUrl,
              website: (website && website.toString().trim()) ? website.toString().trim() : '',
              companyLinkedinUrl: (companyLinkedinUrl && companyLinkedinUrl.toString().trim()) ? companyLinkedinUrl.toString().trim() : '',
              facebookUrl: (facebookUrl && facebookUrl.toString().trim()) ? facebookUrl.toString().trim() : '',
              twitterUrl: (twitterUrl && twitterUrl.toString().trim()) ? twitterUrl.toString().trim() : '',
              city: (city && city.toString().trim()) ? city.toString().trim() : '',
              state: (state && state.toString().trim()) ? state.toString().trim() : '',
              country: (country && country.toString().trim()) ? country.toString().trim() : '',
              companyAddress: (companyAddress && companyAddress.toString().trim()) ? companyAddress.toString().trim() : '',
              companyCity: (companyCity && companyCity.toString().trim()) ? companyCity.toString().trim() : '',
              companyState: (companyState && companyState.toString().trim()) ? companyState.toString().trim() : '',
              companyCountry: (companyCountry && companyCountry.toString().trim()) ? companyCountry.toString().trim() : '',
              companyPhone: (companyPhone && companyPhone.toString().trim()) ? companyPhone.toString().trim() : '',
              seoDescription: (seoDescription && seoDescription.toString().trim()) ? seoDescription.toString().trim() : '',
              technologies: (technologies && technologies.toString().trim()) ? technologies.toString().trim() : '',
              annualRevenue: (annualRevenue && annualRevenue.toString().trim()) ? annualRevenue.toString().trim() : ''
            });
          } catch (rowError) {
            errors.push(`Row ${index + 2}: Error processing row - ${rowError.message}`);
            console.error(`Error processing Excel row ${index + 2}:`, rowError);
          }
        });
      } catch (excelError) {
        console.error('Error parsing Excel file:', excelError);
        return res.status(400).json({
          success: false,
          error: 'Failed to parse Excel file. Please ensure it is a valid XLSX or XLS file.'
        });
      }
    } else {
      // Parse CSV file with proper UTF-8 encoding handling
      // Remove BOM if present and ensure UTF-8 encoding
      let csvContent = req.file.buffer.toString('utf8');
      // Remove UTF-8 BOM if present
      if (csvContent.charCodeAt(0) === 0xFEFF) {
        csvContent = csvContent.slice(1);
      }
      
      // Detect delimiter (comma, tab, or semicolon)
      const lines = csvContent.split('\n').filter(line => line.trim());
      const firstLine = lines[0] || '';
      const commaCount = (firstLine.match(/,/g) || []).length;
      const tabCount = (firstLine.match(/\t/g) || []).length;
      const semicolonCount = (firstLine.match(/;/g) || []).length;
      
      let delimiter = ',';
      if (tabCount > commaCount && tabCount > semicolonCount && tabCount > 0) {
        delimiter = '\t';
      } else if (semicolonCount > commaCount && semicolonCount > tabCount && semicolonCount > 0) {
        delimiter = ';';
      }
      
      console.log(`CSV delimiter detected: ${delimiter === '\t' ? 'TAB' : delimiter === ';' ? 'SEMICOLON' : 'COMMA'}`);
      console.log(`CSV first line preview: ${firstLine.substring(0, 200)}`);
      console.log(`CSV total lines: ${lines.length}`);
      console.log(`Delimiter counts - Comma: ${commaCount}, Tab: ${tabCount}, Semicolon: ${semicolonCount}`);
      
      // Parse headers manually from first line
      // Handle quoted fields properly
      const headerLine = firstLine;
      const parseCSVLine = (line, sep) => {
        const result = [];
        let current = '';
        let inQuotes = false;
        
        for (let i = 0; i < line.length; i++) {
          const char = line[i];
          const nextChar = line[i + 1];
          
          if (char === '"') {
            if (inQuotes && nextChar === '"') {
              // Escaped quote
              current += '"';
              i++; // Skip next quote
            } else {
              // Toggle quote state
              inQuotes = !inQuotes;
            }
          } else if (char === sep && !inQuotes) {
            // Field separator found outside quotes
            result.push(current.trim());
            current = '';
          } else {
            current += char;
          }
        }
        // Add last field
        result.push(current.trim());
        return result;
      };
      
      let headers = parseCSVLine(headerLine, delimiter).map(h => 
        h.replace(/^\uFEFF/, '').replace(/^"|"$/g, '').trim()
      );
      console.log('CSV Headers parsed:', headers);
      console.log('CSV Header count:', headers.length);
      
      // Parse CSV manually line by line for better control
      const allLines = csvContent.split('\n').filter(line => line.trim());
      
      if (allLines.length < 2) {
        return res.status(400).json({
          success: false,
          error: 'CSV file must have at least a header row and one data row'
        });
      }
      
      // Check if first data row contains header-like values (common column names)
      // This handles cases where the actual headers are in the first data row or embedded in a cell
      const firstDataRow = allLines[1];
      let startRowIndex = 1;
      
      if (firstDataRow) {
        const firstDataValues = parseCSVLine(firstDataRow, delimiter);
        const firstDataRowText = firstDataValues.join(',').toLowerCase();
        
        // Check if first data row contains expected header names
        const expectedHeaders = ['company', 'email', 'person linkedin url', 'name', 'title', 'designation', 'first phone', 'employees'];
        const containsHeaders = expectedHeaders.some(header => 
          firstDataRowText.includes(header.toLowerCase())
        );
        
        // Check if any cell in the first data row contains multiple expected headers (comma-separated in one cell)
        // This handles cases where headers are embedded in a single cell
        let potentialHeaders = null;
        for (const value of firstDataValues) {
          if (value && typeof value === 'string' && value.trim()) {
            const trimmedValue = value.trim();
            const lowerValue = trimmedValue.toLowerCase();
            
            // Check if this value contains multiple expected headers (comma-separated)
            const headerMatches = expectedHeaders.filter(h => lowerValue.includes(h.toLowerCase()));
            if (headerMatches.length >= 3) {
              // This cell likely contains the actual headers as a comma-separated string
              // Split by comma and clean up
              potentialHeaders = trimmedValue.split(',').map(h => {
                // Remove quotes and trim
                return h.replace(/^["']|["']$/g, '').trim();
              }).filter(h => h.length > 0);
              
              // Verify these look like headers (should have at least 5-6 expected column names)
              const potentialHeadersLower = potentialHeaders.map(h => h.toLowerCase());
              const matchedExpected = expectedHeaders.filter(h => 
                potentialHeadersLower.some(ph => ph.includes(h) || h.includes(ph))
              );
              
              if (matchedExpected.length >= 3 && potentialHeaders.length >= 5) {
                console.log('Detected headers embedded in first data row cell:', potentialHeaders);
                headers = potentialHeaders.map(h => h.replace(/^\uFEFF/, '').replace(/^"|"$/g, '').trim());
                console.log('Using extracted headers:', headers);
                startRowIndex = 2; // Skip the row that contained headers
                break;
              }
            }
          }
        }
        
        // If we didn't find headers in a cell, check if the first data row itself looks like headers
        if (!potentialHeaders && containsHeaders && firstDataValues.length > 5) {
          // Check if first data row values look like header names (not data)
          const looksLikeHeaders = firstDataValues.some(val => {
            if (!val || typeof val !== 'string') return false;
            const lowerVal = val.toLowerCase().trim();
            return expectedHeaders.some(h => lowerVal.includes(h) || h.includes(lowerVal));
          });
          
          if (looksLikeHeaders) {
            // Use first data row as headers
            headers = firstDataValues.map(h => h.replace(/^\uFEFF/, '').replace(/^"|"$/g, '').trim());
            console.log('Using first data row as headers:', headers);
            startRowIndex = 2;
          }
        }
      }
      
      // Process each data row (skip header row(s))
      for (let i = startRowIndex; i < allLines.length; i++) {
        try {
          const line = allLines[i];
          if (!line || !line.trim()) continue;
          
          const rowNumber = i + 1; // For error reporting (1-indexed, accounting for header row)
          
          // Parse the line using our custom parser
          const values = parseCSVLine(line, delimiter);
          
          // Create mapped row object using headers
          const mappedRow = {};
          headers.forEach((header, index) => {
            if (index < values.length) {
              const value = values[index].replace(/^"|"$/g, '').trim();
              if (value !== undefined && value !== null && value !== '') {
                mappedRow[header] = value;
              }
            }
          });
          
          // Log first data row for debugging
          if (i === 1) {
            console.log('CSV First data row keys:', Object.keys(mappedRow));
            console.log('CSV First data row sample:', JSON.stringify(mappedRow).substring(0, 500));
            console.log('CSV First data row values:', Object.values(mappedRow).slice(0, 5));
          }
          
          // Normalize column names (case-insensitive and remove spaces/special chars)
          // Store all possible variations for flexible matching
          const normalizedRow = {};
          Object.keys(mappedRow).forEach(key => {
            const value = mappedRow[key];
            // Allow empty strings, only skip undefined and null
            if (value === undefined || value === null) return;
            
            // Convert value to string for consistent handling
            const stringValue = value.toString();
            
            // Store with fully normalized key (no spaces, no special chars, lowercase)
            const fullyNormalized = normalizeColumnName(key);
            normalizedRow[fullyNormalized] = stringValue;
            
            // Store with spaces removed but lowercase
            const spaceRemoved = key.toLowerCase().trim().replace(/\s+/g, '');
            if (spaceRemoved && spaceRemoved !== fullyNormalized) {
              normalizedRow[spaceRemoved] = stringValue;
            }
            
            // Store original lowercase trimmed version
            const lowerTrimmed = key.toLowerCase().trim();
            if (lowerTrimmed && lowerTrimmed !== fullyNormalized && lowerTrimmed !== spaceRemoved) {
              normalizedRow[lowerTrimmed] = stringValue;
            }
            
            // Also store original key (for exact matches)
            normalizedRow[key] = stringValue;
          });

          // Get values using flexible field matching (pass original row for additional matching)
          // IMPORTANT: Extract First Name and Last Name FIRST before checking for Full Name
          // This ensures we get separate First/Last names when they exist as separate columns
          const firstName = extractFieldValue(normalizedRow, 'firstname', ['firstname', 'first name'], mappedRow);
          const lastName = extractFieldValue(normalizedRow, 'lastname', ['lastname', 'last name'], mappedRow);
          
          // Try to get Full Name field
          const fullName = extractFieldValue(normalizedRow, 'name', ['fullname', 'contactname', 'personname', 'full name', 'contact name', 'person name', 'name'], mappedRow);
          
          let name = '';
          // Priority logic:
          // 1. If we have both First Name and Last Name as separate columns, combine them
          // 2. Otherwise, use Full Name if available
          // 3. Otherwise, use First Name or Last Name alone if available
          if (firstName && firstName.trim() && lastName && lastName.trim()) {
            // We have both First and Last Name - combine them
            name = `${firstName.trim()} ${lastName.trim()}`.trim();
          } else if (firstName && firstName.trim()) {
            // Only First Name available
            name = firstName.trim();
          } else if (lastName && lastName.trim()) {
            // Only Last Name available
            name = lastName.trim();
          } else if (fullName && fullName.trim()) {
            // Use Full Name if available
            name = fullName.trim();
          } else if ((firstName && firstName.trim()) || (lastName && lastName.trim())) {
            // Fallback: combine whatever we have
            const first = firstName && firstName.trim() ? firstName.trim() : '';
            const last = lastName && lastName.trim() ? lastName.trim() : '';
            name = [first, last].filter(Boolean).join(' ').trim();
          }
          
          // If still no name, try to find it in any column that might contain a name
          if (!name || !name.trim()) {
            // Check mapped row for any field that might be a name
            for (const [key, value] of Object.entries(mappedRow)) {
              const keyLower = key.toLowerCase().trim();
              if ((keyLower.includes('name') || keyLower.includes('contact') || keyLower.includes('person')) && 
                  value && String(value).trim()) {
                name = String(value).trim();
                break;
              }
            }
          }
          
          const email = extractFieldValue(normalizedRow, 'email', ['emailaddress', 'email address', 'e-mail', 'mail'], mappedRow);
          const company = extractFieldValue(normalizedRow, 'company', ['companyname', 'company name', 'organization', 'org', 'firm'], mappedRow);
          const title = extractFieldValue(normalizedRow, 'title', ['jobtitle', 'job title', 'position', 'designation', '*designation', 'role'], mappedRow);
          const firstPhone = extractFieldValue(normalizedRow, 'firstPhone', ['firstphone', 'first phone', 'first phone #', 'firstphone#', 'phone', 'phonenumber', 'phone number', 'contactnumber', 'contact number', 'mobilenumber', 'mobile number', 'mobile', 'telephone', 'tel', 'cell', 'cellphone'], mappedRow);
          const employees = extractFieldValue(normalizedRow, 'employees', ['noofemployees', 'no of employees', 'numberofemployees', 'number of employees', 'employee', 'emp', 'employeecount', 'employee count', 'companysize', 'company size'], mappedRow);
          const category = extractFieldValue(normalizedRow, 'category', ['cat', 'type'], mappedRow);
          const industry = extractFieldValue(normalizedRow, 'industry', ['sector', 'businesssector', 'business sector'], mappedRow);
          const keywords = extractFieldValue(normalizedRow, 'keywords', ['keyword', 'tags', 'tag'], mappedRow);
          const personLinkedinUrl = extractFieldValue(normalizedRow, 'personLinkedinUrl', [
            'personlinkedinurl', 'person linkedin url', 'personlinkedin', 'person linkedin', 
            'person lin', 'personlin', 'linkedinurl', 'linkedin url', 'linkedin', 
            'linkedinprofile', 'linkedin profile', 'personlinkedinprofile', 'person linkedin profile',
            'LinkedIn', 'LinkedIn URL', 'LinkedIn Url', 'Person LinkedIn', 'Person LinkedIn URL',
            'Person LinkedIn Url', 'LinkedIn Profile', 'Person LinkedIn Profile', 'LinkedInProfile',
            'PersonLinkedIn', 'PersonLinkedInURL', 'PersonLinkedInUrl', 'linkedin', 'LinkedInURL'
          ], mappedRow);
          const website = extractFieldValue(normalizedRow, 'website', ['web', 'url', 'websiteurl', 'website url', 'site', 'webaddress', 'web address'], mappedRow);
          const companyLinkedinUrl = extractFieldValue(normalizedRow, 'companyLinkedinUrl', ['companylinkedinurl', 'company linkedin url', 'companylinkedin', 'company linkedin', 'companylinkedinprofile', 'company linkedin profile'], mappedRow);
          const facebookUrl = extractFieldValue(normalizedRow, 'facebookUrl', ['facebookurl', 'facebook url', 'facebook', 'fb', 'fburl', 'fb url'], mappedRow);
          const twitterUrl = extractFieldValue(normalizedRow, 'twitterUrl', ['twitterurl', 'twitter url', 'twitter', 'x'], mappedRow);
          const city = extractFieldValue(normalizedRow, 'city', ['personcity', 'person city', 'location'], mappedRow);
          const state = extractFieldValue(normalizedRow, 'state', ['personstate', 'person state', 'province', 'region'], mappedRow);
          const country = extractFieldValue(normalizedRow, 'country', ['personcountry', 'person country', 'nation'], mappedRow);
          const companyAddress = extractFieldValue(normalizedRow, 'companyAddress', ['companyaddress', 'company address', 'address', 'companyaddr', 'company addr'], mappedRow);
          const companyCity = extractFieldValue(normalizedRow, 'companyCity', ['companycity', 'company city'], mappedRow);
          const companyState = extractFieldValue(normalizedRow, 'companyState', ['companystate', 'company state'], mappedRow);
          const companyCountry = extractFieldValue(normalizedRow, 'companyCountry', ['companycountry', 'company country'], mappedRow);
          const companyPhone = extractFieldValue(normalizedRow, 'companyPhone', ['companyphone', 'company phone', 'companyphonenumber', 'company phone number', 'companytel', 'company tel', 'companytelephone', 'company telephone'], mappedRow);
          const seoDescription = extractFieldValue(normalizedRow, 'seoDescription', ['seodescription', 'seo description', 'seo descr', 'seodescr', 'description', 'about', 'companydescription', 'company description', 'bio'], mappedRow);
          const technologies = extractFieldValue(normalizedRow, 'technologies', ['tech', 'technology', 'techstack', 'tech stack'], mappedRow);
          const annualRevenue = extractFieldValue(normalizedRow, 'annualRevenue', ['annualrevenue', 'annual revenue', 'revenue', 'yearlyrevenue', 'yearly revenue'], mappedRow);

          // Check if row has any data at all (from mapped row object)
          const rowHasData = Object.values(mappedRow).some(val => val !== undefined && val !== null && String(val).trim() !== '');
          
          // Skip completely empty rows (check if ALL fields are empty)
          // But be more lenient - if we have at least name, email, or company, process it
          const hasAnyData = (name && name.trim()) || (email && email.trim()) || (company && company.trim()) || 
                           (title && title.trim()) || (firstPhone && firstPhone.trim()) || 
                           (employees && employees.trim()) || (category && category.trim()) || 
                           (industry && industry.trim()) || (keywords && keywords.trim()) || 
                           (personLinkedinUrl && personLinkedinUrl.trim()) || (website && website.trim()) || 
                           (companyLinkedinUrl && companyLinkedinUrl.trim()) || (facebookUrl && facebookUrl.trim()) || 
                           (twitterUrl && twitterUrl.trim()) || (city && city.trim()) || (state && state.trim()) || 
                           (country && country.trim()) || (companyAddress && companyAddress.trim()) || 
                           (companyCity && companyCity.trim()) || (companyState && companyState.trim()) || 
                           (companyCountry && companyCountry.trim()) || (companyPhone && companyPhone.trim()) || 
                           (seoDescription && seoDescription.trim()) || (technologies && technologies.trim()) || 
                           (annualRevenue && annualRevenue.trim());
          
          // If row has data but we couldn't map it, log for debugging
          if (rowHasData && !hasAnyData) {
            console.warn(`Row ${rowNumber} has data but couldn't map fields. Keys:`, Object.keys(mappedRow));
            errors.push(`Row ${rowNumber}: Data present but no mappable fields found`);
          }
          
          if (!hasAnyData) {
            continue; // Skip empty rows
          }

          // Validate required fields
          const trimmedPersonLinkedinUrl = (personLinkedinUrl && personLinkedinUrl.trim()) ? personLinkedinUrl.trim() : '';
          if (!trimmedPersonLinkedinUrl) {
            errors.push(`Row ${rowNumber}: Person Linkedin Url is required`);
            continue; // Skip this row
          }

          // ONLY use actual data from the file - NO default values
          // If a field is missing in the CSV file, it should remain empty, not be filled with defaults
          const trimmedName = (name && name.toString().trim()) ? name.toString().trim() : '';
          const trimmedEmail = (email && email.toString().trim()) ? email.toString().trim().toLowerCase() : '';
          const trimmedCompany = (company && company.toString().trim()) ? company.toString().trim() : '';
          
          // Validate that we have at least name or company (required fields)
          if (!trimmedName && !trimmedCompany) {
            errors.push(`Row ${i + 1}: Name or Company is required`);
            continue; // Skip this row
          }

          // Create contact object with all fields
          contacts.push({
            name: trimmedName,
            email: trimmedEmail,
            company: trimmedCompany,
            title: (title && title.trim()) ? title.trim() : '',
            firstPhone: (firstPhone && firstPhone.trim()) ? firstPhone.trim() : '',
            employees: (employees && employees.trim()) ? employees.trim() : '',
            category: (category && category.trim()) ? category.trim() : '',
            industry: (industry && industry.trim()) ? industry.trim() : '',
            keywords: (keywords && keywords.trim()) ? keywords.trim() : '',
            personLinkedinUrl: trimmedPersonLinkedinUrl,
            website: (website && website.trim()) ? website.trim() : '',
            companyLinkedinUrl: (companyLinkedinUrl && companyLinkedinUrl.trim()) ? companyLinkedinUrl.trim() : '',
            facebookUrl: (facebookUrl && facebookUrl.trim()) ? facebookUrl.trim() : '',
            twitterUrl: (twitterUrl && twitterUrl.trim()) ? twitterUrl.trim() : '',
            city: (city && city.trim()) ? city.trim() : '',
            state: (state && state.trim()) ? state.trim() : '',
            country: (country && country.trim()) ? country.trim() : '',
            companyAddress: (companyAddress && companyAddress.trim()) ? companyAddress.trim() : '',
            companyCity: (companyCity && companyCity.trim()) ? companyCity.trim() : '',
            companyState: (companyState && companyState.trim()) ? companyState.trim() : '',
            companyCountry: (companyCountry && companyCountry.trim()) ? companyCountry.trim() : '',
            companyPhone: (companyPhone && companyPhone.trim()) ? companyPhone.trim() : '',
            seoDescription: (seoDescription && seoDescription.trim()) ? seoDescription.trim() : '',
            technologies: (technologies && technologies.trim()) ? technologies.trim() : '',
            annualRevenue: (annualRevenue && annualRevenue.trim()) ? annualRevenue.trim() : ''
          });
        } catch (rowError) {
          console.error(`Error processing CSV row ${i}:`, rowError);
          errors.push(`Row ${i + 1}: ${rowError.message || 'Error processing row'}`);
        }
      }
      
      console.log(`CSV parsing completed. Processed ${allLines.length - 1} rows, created ${contacts.length} contacts.`);
    }

    // Log debugging information - show what was actually imported
    console.log(`=== BULK IMPORT SUMMARY ===`);
    console.log(`Parsed ${contacts.length} contacts from file`);
    if (contacts.length > 0) {
      console.log(`Sample of first 3 contacts being imported:`);
      contacts.slice(0, 3).forEach((contact, idx) => {
        console.log(`Contact ${idx + 1}:`, {
          name: contact.name || '(empty)',
          email: contact.email || '(empty)',
          company: contact.company || '(empty)',
          title: contact.title || '(empty)',
          personLinkedinUrl: contact.personLinkedinUrl ? 'Present' : '(empty)'
        });
      });
    }
    if (errors.length > 0) {
      console.log(`Encountered ${errors.length} errors during parsing:`, errors.slice(0, 5));
    }
    console.log(`==========================`);
    
    if (contacts.length === 0) {
      // Provide more helpful error message
      const errorMessage = errors.length > 0 
        ? `No contacts found in file. Errors: ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? '...' : ''}`
        : 'No contacts found in file. Please ensure the file contains data and has proper column headers (Name, Email, Company, etc.).';
      
      return res.status(400).json({
        success: false,
        error: errorMessage,
        debug: {
          fileType: isExcel ? 'Excel' : 'CSV',
          errors: errors.slice(0, 10),
          totalErrors: errors.length
        }
      });
    }

    // Check for duplicates ONLY in ProspectContact collection (NOT Contact collection)
    const contactsToImport = contacts.map((contact) => {
      // Ensure email is properly formatted (if it exists)
      if (contact.email && contact.email.trim() && contact.email.includes('@')) {
        return {
          ...contact,
          email: contact.email.trim().toLowerCase()
        };
      } else {
        // No email - keep it empty
        return {
          ...contact,
          email: contact.email || ''
        };
      }
    });

    // Check for duplicates in ProspectContact collection only
    const newContacts = [];
    const existingContacts = [];
    const duplicateEmails = new Set();
    const duplicateNameCompany = new Set();

    for (const contact of contactsToImport) {
      let isDuplicate = false;
      let duplicateReason = '';

      // Normalize values for comparison
      const normalizedEmail = contact.email ? contact.email.trim().toLowerCase() : '';
      const normalizedName = contact.name ? contact.name.trim().toLowerCase() : '';
      const normalizedCompany = contact.company ? contact.company.trim().toLowerCase() : '';

      // Primary check: Email (if available)
      if (normalizedEmail) {
        const existingByEmail = await ProspectContact.findOne({
          email: { $regex: new RegExp(`^${normalizedEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
        });
        
        if (existingByEmail) {
          isDuplicate = true;
          duplicateReason = `Email "${contact.email}" already exists in ProspectContact collection`;
          duplicateEmails.add(normalizedEmail);
        }
      }

      // Secondary check: Name + Company combination (if email not found and both name and company exist)
      if (!isDuplicate && normalizedName && normalizedCompany) {
        const existingByNameCompany = await ProspectContact.findOne({
          name: { $regex: new RegExp(`^${normalizedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
          company: { $regex: new RegExp(`^${normalizedCompany.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
        });
        
        if (existingByNameCompany) {
          isDuplicate = true;
          duplicateReason = `Name "${contact.name}" and company "${contact.company}" combination already exists in ProspectContact collection`;
          duplicateNameCompany.add(`${normalizedName}|${normalizedCompany}`);
        }
      }

      if (isDuplicate) {
        existingContacts.push({
          ...contact,
          duplicateReason
        });
      } else {
        newContacts.push(contact);
      }
    }

    console.log(`Duplicate check completed: ${newContacts.length} new contacts, ${existingContacts.length} duplicates found in ProspectContact collection`);

    // Create new contacts in database (only non-duplicates)
    let createdContacts = [];
    if (newContacts.length > 0) {
      try {
        // Insert only new contacts (duplicates already filtered out)
        createdContacts = await ProspectContact.insertMany(newContacts, { ordered: false });
        console.log(`✓ Created ${createdContacts.length} new prospect contacts in ProspectContact collection`);
      } catch (insertError) {
        // Handle partial inserts (some might succeed)
        if (insertError.writeErrors) {
          console.error('Some contacts failed to insert:', insertError.writeErrors.length);
          // Get successfully inserted contacts
          const insertedIds = insertError.insertedIds || {};
          createdContacts = Object.values(insertedIds).map(id => ({ _id: id }));
          
          // Log errors but continue - some inserts may have failed due to unique constraints
          console.log(`Note: Some contacts had insertion errors, continuing with successfully inserted contacts`);
        } else {
          throw insertError;
        }
      }
    }

    // Handle existing contacts (duplicates found in ProspectContact)
    // Get the existing contact IDs from ProspectContact collection
    const existingContactIds = [];
    for (const existingContact of existingContacts) {
      const normalizedEmail = existingContact.email ? existingContact.email.trim().toLowerCase() : '';
      const normalizedName = existingContact.name ? existingContact.name.trim().toLowerCase() : '';
      const normalizedCompany = existingContact.company ? existingContact.company.trim().toLowerCase() : '';

      let foundContact = null;
      
      // Find by email first
      if (normalizedEmail) {
        foundContact = await ProspectContact.findOne({
          email: { $regex: new RegExp(`^${normalizedEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
        });
      }
      
      // If not found by email, try name + company
      if (!foundContact && normalizedName && normalizedCompany) {
        foundContact = await ProspectContact.findOne({
          name: { $regex: new RegExp(`^${normalizedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
          company: { $regex: new RegExp(`^${normalizedCompany.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
        });
      }
      
      if (foundContact) {
        existingContactIds.push(foundContact._id);
      }
    }

    // Combine new and existing contact IDs
    const allContactIds = [
      ...createdContacts.map(c => c._id).filter(id => id),
      ...existingContactIds
    ];

    // Check for existing project-contact links to avoid duplicate ProjectContact entries
    const existingProjectContacts = await ProjectContact.find({
      projectId: project._id,
      contactId: { $in: allContactIds }
    }).select('contactId').lean();

    const existingProjectContactSet = new Set(
      existingProjectContacts.map(pc => pc.contactId.toString())
    );

    // Create project-contact links for ALL contacts (both new and existing)
    const projectContacts = [];
    let skipped = 0;

    // Link new contacts
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

    // Link existing contacts (duplicates from ProspectContact)
    for (const contactId of existingContactIds) {
      if (!existingProjectContactSet.has(contactId.toString())) {
        projectContacts.push({
          projectId: project._id,
          contactId: contactId,
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
    const totalSkipped = skipped;

    const newContactsCount = createdContacts.length;
    const existingContactsCount = existingContacts.length;
    
    console.log(`\n=== Bulk Import Summary ===`);
    console.log(`✓ ProspectContact Collection: ${newContactsCount} new prospect contacts created`);
    console.log(`✓ Duplicates found in ProspectContact: ${existingContactsCount} (not created, but linked to project)`);
    console.log(`✓ ProjectContact Collection: ${projectContactsCreated} project-contact links created`);
    console.log(`✓ Total imported to project: ${imported} prospects`);
    console.log(`✓ Skipped: ${totalSkipped} (already linked to this project)`);
    console.log(`✓ Errors: ${errors.length}`);
    console.log(`===========================\n`);

    res.json({
      success: true,
      data: {
        imported,
        skipped: totalSkipped,
        errors: errors.length,
        total: contacts.length,
        duplicatesInFile: 0, // Duplicates are now allowed
        alreadyInProject: skipped,
        newContactsInDatabank: newContactsCount,
        existingContactsInDatabank: existingContactsCount,
        projectContactsCreated: projectContactsCreated
      },
      message: `Successfully imported ${imported} prospects. ${newContactsCount > 0 ? `${newContactsCount} new prospect contacts created in ProspectContact collection.` : ''} ${existingContactsCount > 0 ? `${existingContactsCount} duplicates found in ProspectContact (linked to project).` : ''} ${projectContactsCreated > 0 ? `${projectContactsCreated} ProjectContact links created.` : ''} ${totalSkipped > 0 ? `${totalSkipped} already linked to this project.` : ''}`
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

    // Validate ObjectIds
    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid project ID'
      });
    }

    if (!mongoose.Types.ObjectId.isValid(contactId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid contact ID'
      });
    }

    // Verify project exists
    const project = await Project.findById(projectId);
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    // Verify prospect contact exists
    const contact = await ProspectContact.findById(contactId);
    if (!contact) {
      return res.status(404).json({
        success: false,
        error: 'Prospect contact not found'
      });
    }

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

module.exports = router;

