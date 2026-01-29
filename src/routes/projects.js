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
const User = require('../models/User');
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

// ----------------------------
// Aggregation helpers (MongoDB-compatible)
// ----------------------------
// NOTE: We intentionally avoid newer operators like $regexReplace, since some deployments use older MongoDB versions.
const _STRIP_SEPARATORS = [' ', '-', '(', ')', '+', '.', '/', '\\'];

function buildStripSeparatorsExpr(stringExpr) {
  return _STRIP_SEPARATORS.reduce((expr, sep) => {
    return {
      $reduce: {
        input: { $split: [expr, sep] },
        initialValue: '',
        in: { $concat: ['$$value', '$$this'] }
      }
    };
  }, stringExpr);
}

function buildNormalizedPhoneExpr(phoneExpr) {
  // phoneExpr should evaluate to a string (e.g., { $ifNull: ['$contact.firstPhone', ''] })
  return buildStripSeparatorsExpr({ $trim: { input: phoneExpr } });
}

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
      teamMembers
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
      teamMembers: Array.isArray(teamMembers) ? teamMembers.filter(email => email && email.trim()) : [],
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
    const user = req.user;
    const isAdmin = user.isAdmin || (user.email && user.email.toLowerCase() === 'akshay@kology.co');
    // Simple TTL cache to keep dashboard loads fast
    // Keyed per-user to avoid leaking data across accounts.
    const cacheKey = `projects_analytics:${user._id?.toString?.() || user._id}:${isAdmin ? 'admin' : 'user'}`;
    const nowMs = Date.now();
    if (!global.__projectsAnalyticsCache) global.__projectsAnalyticsCache = new Map();
    const cacheEntry = global.__projectsAnalyticsCache.get(cacheKey);
    const CACHE_TTL_MS = 60 * 1000; // 60s
    if (cacheEntry && (nowMs - cacheEntry.ts) < CACHE_TTL_MS) {
      return res.json(cacheEntry.payload);
    }
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    // Get projects filtered by user unless admin (for Project Management page)
    // Include projects where user is creator OR team member
    let projectFilter = {};
    if (!isAdmin) {
      projectFilter.$or = [
        { createdBy: user._id },
        { teamMembers: { $in: [user.email.toLowerCase()] } }
      ];
    }
    const projects = await Project.find(projectFilter).lean();
    const projectIds = projects.map(p => p._id);
    
    // Build activity filter - include activities from team member projects
    // For team members, show all activities in their assigned projects
    const activityFilter = { projectId: { $in: projectIds } };
    const userEmailLower = (user.email || '').toLowerCase();
    // Projects where the current user is a team member (not necessarily creator)
    const teamMemberProjectIds = !isAdmin
      ? projects
          .filter(p => Array.isArray(p.teamMembers) && p.teamMembers.some(e => String(e).toLowerCase() === userEmailLower))
          .map(p => p._id)
      : [];
    if (!isAdmin) {
      // If user has team member projects, show all activities in those projects
      // Otherwise, only show activities created by the user
      if (teamMemberProjectIds.length > 0) {
        // Show all activities in team member projects OR activities created by user in their own projects
        activityFilter.$or = [
          { projectId: { $in: teamMemberProjectIds } },
          { createdBy: user._id, projectId: { $in: projectIds } }
        ];
      } else {
      activityFilter.createdBy = user._id;
      }
    }

    // Overview totals: admin = all activities in their projects; non-admin = only activities they created or in projects assigned to them (activityFilter above).
    
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
      // Basic counts - use projectFilter
      Project.countDocuments(projectFilter),
      Project.countDocuments({ ...projectFilter, status: 'active' }),
      Project.countDocuments({ ...projectFilter, status: 'draft' }),
      Project.countDocuments({ ...projectFilter, status: 'completed' }),
      
      // Prospect counts must match Prospect Management (after the same filters + dedupe).
      // We compute unique-per-project identifiers and then sum per-project counts.
      ProjectContact.aggregate([
        { $match: { projectId: { $in: projectIds }, contactId: { $ne: null, $exists: true } } },
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
            from: 'contacts',
            localField: 'contactId',
            foreignField: '_id',
            as: 'legacyContact'
          }
        },
        {
          $project: {
            projectId: 1,
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
            $or: [
              { 'contact.email': { $exists: true, $ne: '', $ne: null } },
              { 'contact.firstPhone': { $exists: true, $ne: '', $ne: null } }
            ]
          }
        },
        {
          $addFields: {
            _email: { $toLower: { $trim: { input: { $ifNull: ['$contact.email', ''] } } } },
            _name: { $toLower: { $trim: { input: { $ifNull: ['$contact.name', ''] } } } },
            _phone: {
              // MongoDB compatibility: avoid $regexReplace (not available on older versions).
              // Strip common separators via $split + $reduce.
              $let: {
                vars: {
                  p0: { $trim: { input: { $ifNull: ['$contact.firstPhone', ''] } } }
                },
                in: {
                  $let: {
                    vars: {
                      p1: {
                        $reduce: {
                          input: { $split: ['$$p0', ' '] },
                          initialValue: '',
                          in: { $concat: ['$$value', '$$this'] }
                        }
                      }
                    },
                    in: {
                      $let: {
                        vars: {
                          p2: {
                            $reduce: {
                              input: { $split: ['$$p1', '-'] },
                              initialValue: '',
                              in: { $concat: ['$$value', '$$this'] }
                            }
                          }
                        },
                        in: {
                          $let: {
                            vars: {
                              p3: {
                                $reduce: {
                                  input: { $split: ['$$p2', '('] },
                                  initialValue: '',
                                  in: { $concat: ['$$value', '$$this'] }
                                }
                              }
                            },
                            in: {
                              $let: {
                                vars: {
                                  p4: {
                                    $reduce: {
                                      input: { $split: ['$$p3', ')'] },
                                      initialValue: '',
                                      in: { $concat: ['$$value', '$$this'] }
                                    }
                                  }
                                },
                                in: {
                                  $let: {
                                    vars: {
                                      p5: {
                                        $reduce: {
                                          input: { $split: ['$$p4', '+'] },
                                          initialValue: '',
                                          in: { $concat: ['$$value', '$$this'] }
                                        }
                                      }
                                    },
                                    in: '$$p5'
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        {
          $addFields: {
            _identifier: {
              // Deduplicate ONLY when name + phone + email all match.
              $cond: [
                {
                  $and: [
                    { $gt: [{ $strLenCP: '$_name' }, 0] },
                    { $gt: [{ $strLenCP: '$_phone' }, 0] },
                    { $gt: [{ $strLenCP: '$_email' }, 0] }
                  ]
                },
                { $concat: ['npe:', '$_name', '|', '$_phone', '|', '$_email'] },
                ''
              ]
            }
          }
        },
        {
          $group: {
            _id: {
              projectId: '$projectId',
              key: {
                $cond: [
                  { $gt: [{ $strLenCP: '$_identifier' }, 0] },
                  '$_identifier',
                  { $concat: ['id:', { $toString: '$contact._id' }] }
                ]
              }
            }
          }
        },
        { $group: { _id: '$_id.projectId', count: { $sum: 1 } } },
        { $group: { _id: null, total: { $sum: '$count' } } }
      ]).then(r => (r && r[0] ? r[0].total : 0)),
      
      // Activity counts: admin = all in projects; non-admin = only their activities or activities in projects assigned to them
      Activity.countDocuments(activityFilter),
      
      // Activities by type - same filter (admin sees all, non-admin sees filtered)
      Activity.aggregate([
        { $match: activityFilter },
        { $group: { _id: '$type', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      
      // Activities by date (last 30 days) - same filter
      Activity.aggregate([
        { 
          $match: { 
            ...activityFilter,
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
      
      // Stage distribution (PIPELINE)
      // PERFORMANCE: avoid per-contact $lookup into activities (very slow on large datasets).
      // We compute latest activity stage per (projectId, contactId) once, then add "New" for contacts with no activities.
      (() => {
        const activityStagePipeline = [
          { $match: { ...activityFilter, projectId: { $in: projectIds }, contactId: { $ne: null, $exists: true } } },
          {
            $addFields: {
              _derivedStageRaw: {
                $cond: [
                  { $eq: ['$type', 'call'] },
                  { $ifNull: ['$callStatus', '$status'] },
                  '$status'
                ]
              }
            }
          },
          {
            $addFields: {
              derivedStage: {
                $let: {
                  vars: { s: { $ifNull: ['$_derivedStageRaw', ''] } },
                  in: {
                    $switch: {
                      branches: [
                        { case: { $in: ['$$s', ['CIP', 'SQL', 'WON', 'Lost', 'No Reply', 'Not Interested', 'Meeting Proposed', 'Meeting Scheduled', 'Meeting Completed', 'In-Person Meeting', 'Tech Discussion', 'Low Potential - Open', 'Potential Future']] }, then: '$$s' },
                        { case: { $in: ['$$s', ['Interested', 'Out of Office']] }, then: 'CIP' },
                        { case: { $in: ['$$s', ['Bounce', 'Opt-Out']] }, then: 'Lost' },
                        { case: { $eq: ['$$s', 'Wrong Person'] }, then: 'Lost' },
                        { case: { $in: ['$$s', ['Details Shared', 'Existing']] }, then: 'CIP' },
                        { case: { $eq: ['$$s', 'Demo Booked'] }, then: 'Meeting Scheduled' },
                        { case: { $eq: ['$$s', 'Demo Completed'] }, then: 'Meeting Completed' },
                        { case: { $eq: ['$$s', 'Future'] }, then: 'Potential Future' },
                        { case: { $eq: ['$$s', 'Call Back'] }, then: 'CIP' },
                        { case: { $in: ['$$s', ['Ring', 'Busy', 'Hang Up', 'Switch Off', 'Invalid']] }, then: 'No Reply' }
                      ],
                      default: { $cond: [{ $ne: ['$$s', ''] }, '$$s', 'New'] }
                    }
                  }
                }
              }
            }
          },
          { $sort: { createdAt: -1 } },
          {
            $group: {
              _id: { projectId: '$projectId', contactId: '$contactId' },
              stage: { $first: '$derivedStage' }
            }
          },
          { $group: { _id: '$stage', count: { $sum: 1 } } }
        ];

        const activityPairsCountPipeline = [
          { $match: { ...activityFilter, projectId: { $in: projectIds }, contactId: { $ne: null, $exists: true } } },
          { $group: { _id: { projectId: '$projectId', contactId: '$contactId' } } },
          { $count: 'count' }
        ];

        const totalPairsCountPipeline = [
          { $match: { projectId: { $in: projectIds }, contactId: { $ne: null, $exists: true } } },
          { $group: { _id: { projectId: '$projectId', contactId: '$contactId' } } },
          { $count: 'count' }
        ];

        return Promise.all([
          Activity.aggregate(activityStagePipeline).allowDiskUse(true),
          Activity.aggregate(activityPairsCountPipeline).allowDiskUse(true),
          ProjectContact.aggregate(totalPairsCountPipeline).allowDiskUse(true)
        ]).then(([stageCounts, activityPairsCount, totalPairsCount]) => {
          const activityPairs = activityPairsCount?.[0]?.count || 0;
          const totalPairs = totalPairsCount?.[0]?.count || 0;
          const noActivityPairs = Math.max(0, totalPairs - activityPairs);

          const map = new Map();
          (stageCounts || []).forEach(s => {
            const key = s._id || 'New';
            map.set(key, (map.get(key) || 0) + (s.count || 0));
          });
          map.set('New', (map.get('New') || 0) + noActivityPairs);

          return Array.from(map.entries())
            .map(([stage, count]) => ({ _id: stage, count }))
            .sort((a, b) => b.count - a.count);
        });
      })(),
      
      // Channel usage across projects - use projectFilter
      Project.aggregate([
        { $match: projectFilter },
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
      
      // Team performance (activities per team member) - filter by user unless admin
      Activity.aggregate([
        { $match: activityFilter },
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
      
      // Project health metrics - filter by user unless admin
      (() => {
        const pipeline = [
          { $match: projectFilter },
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
              let: { projectId: '$_id' },
              pipeline: [
                {
                  $match: isAdmin 
                    ? { $expr: { $eq: ['$projectId', '$$projectId'] } }
                    : {
                        $expr: { $eq: ['$projectId', '$$projectId'] },
                        createdBy: user._id
                      }
                }
              ],
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
        ];
        return Project.aggregate(pipeline);
      })(),
      
      // Top performing projects - filter by user unless admin
      (() => {
        const pipeline = [
          { $match: projectFilter },
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
              let: { projectId: '$_id' },
              pipeline: [
                {
                  $match: isAdmin 
                    ? { $expr: { $eq: ['$projectId', '$$projectId'] } }
                    : {
                        $expr: { $eq: ['$projectId', '$$projectId'] },
                        createdBy: user._id
                      }
                }
              ],
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
        ];
        return Project.aggregate(pipeline);
      })(),
      
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
      
      // Activity trends (last 7 days) - filter by user unless admin
      Activity.aggregate([
        {
          $match: {
            ...activityFilter,
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
      
      // Recent activities - filter by user unless admin
      Activity.aggregate([
        { $match: activityFilter },
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
    // Cache successful response
    global.__projectsAnalyticsCache.set(cacheKey, {
      ts: nowMs,
      payload: {
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
    const user = req.user;
    const isAdmin = user.isAdmin || user.email === 'akshay@kology.co';
    const Activity = require('../models/Activity');
    const { projectId } = req.query;
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    // Build filter for project-specific or all projects
    let projectFilter = {};
    let projectIds = [];
    let userProjectFilter = {};
    
    if (!isAdmin) {
      userProjectFilter.createdBy = user._id;
    }
    
    if (projectId && mongoose.Types.ObjectId.isValid(projectId)) {
      // Verify user has access to this project
      if (!isAdmin) {
        const project = await Project.findOne({ _id: projectId, createdBy: user._id });
        if (!project) {
          return res.status(403).json({
            success: false,
            error: 'Access denied to this project'
          });
        }
      }
      projectFilter = { projectId: new mongoose.Types.ObjectId(projectId) };
      projectIds = [new mongoose.Types.ObjectId(projectId)];
    } else {
      const projects = await Project.find(userProjectFilter).lean();
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
      // Total prospects (deduped to match Prospect Management)
      ProjectContact.aggregate([
        { $match: projectFilter },
        { $match: { contactId: { $ne: null, $exists: true } } },
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
            from: 'contacts',
            localField: 'contactId',
            foreignField: '_id',
            as: 'legacyContact'
          }
        },
        {
          $project: {
            projectId: 1,
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
            $or: [
              { 'contact.email': { $exists: true, $ne: '', $ne: null } },
              { 'contact.firstPhone': { $exists: true, $ne: '', $ne: null } }
            ]
          }
        },
        {
          $addFields: {
            _email: { $toLower: { $trim: { input: { $ifNull: ['$contact.email', ''] } } } },
            _name: { $toLower: { $trim: { input: { $ifNull: ['$contact.name', ''] } } } },
            _phone: buildNormalizedPhoneExpr({ $ifNull: ['$contact.firstPhone', ''] })
          }
        },
        {
          $addFields: {
            _dedupeKey: {
              $cond: [
                {
                  $and: [
                    { $gt: [{ $strLenCP: '$_name' }, 0] },
                    { $gt: [{ $strLenCP: '$_phone' }, 0] },
                    { $gt: [{ $strLenCP: '$_email' }, 0] }
                  ]
                },
                { $concat: ['npe:', '$_name', '|', '$_phone', '|', '$_email'] },
                { $concat: ['id:', { $toString: '$contact._id' }] }
              ]
            }
          }
        },
        { $group: { _id: { projectId: '$projectId', key: '$_dedupeKey' } } },
        { $group: { _id: null, total: { $sum: 1 } } }
      ]).allowDiskUse(true).then(r => (r && r[0] ? r[0].total : 0)),

      // Prospects by stage (deduped by (name+phone+email) and latest activity)
      (() => {
        const base = [
          { $match: projectFilter },
          { $match: { contactId: { $ne: null, $exists: true } } },
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
              from: 'contacts',
              localField: 'contactId',
              foreignField: '_id',
              as: 'legacyContact'
            }
          },
          {
            $project: {
              projectId: 1,
              stage: 1,
              priority: 1,
              createdAt: 1,
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
              $or: [
                { 'contact.email': { $exists: true, $ne: '', $ne: null } },
                { 'contact.firstPhone': { $exists: true, $ne: '', $ne: null } }
              ]
            }
          },
          {
            $addFields: {
              _email: { $toLower: { $trim: { input: { $ifNull: ['$contact.email', ''] } } } },
              _name: { $toLower: { $trim: { input: { $ifNull: ['$contact.name', ''] } } } },
              _phone: buildNormalizedPhoneExpr({ $ifNull: ['$contact.firstPhone', ''] })
            }
          },
          {
            $addFields: {
              _dedupeKey: {
                $cond: [
                  {
                    $and: [
                      { $gt: [{ $strLenCP: '$_name' }, 0] },
                      { $gt: [{ $strLenCP: '$_phone' }, 0] },
                      { $gt: [{ $strLenCP: '$_email' }, 0] }
                    ]
                  },
                  { $concat: ['npe:', '$_name', '|', '$_phone', '|', '$_email'] },
                  { $concat: ['id:', { $toString: '$contact._id' }] }
                ]
              }
            }
          },
          {
            $lookup: {
              from: 'activities',
              let: { pid: '$projectId', cid: '$contact._id' },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ['$projectId', '$$pid'] },
                        { $eq: ['$contactId', '$$cid'] }
                      ]
                    }
                  }
                },
                { $sort: { createdAt: -1 } },
                { $limit: 1 },
                { $project: { createdAt: 1 } }
              ],
              as: '_lastActivity'
            }
          },
          { $addFields: { _lastActivityAt: { $arrayElemAt: ['$_lastActivity.createdAt', 0] } } },
          { $sort: { _lastActivityAt: -1, createdAt: -1 } },
          { $group: { _id: { projectId: '$projectId', key: '$_dedupeKey' }, doc: { $first: '$$ROOT' } } },
          { $replaceRoot: { newRoot: '$doc' } }
        ];

        return ProjectContact.aggregate([
          ...base,
          { $group: { _id: '$stage', count: { $sum: 1 } } },
          { $sort: { count: -1 } }
        ]).allowDiskUse(true);
      })(),

      // Prospects by priority (deduped by (name+phone+email) and latest activity)
      (() => {
        const base = [
          { $match: projectFilter },
          { $match: { contactId: { $ne: null, $exists: true } } },
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
              from: 'contacts',
              localField: 'contactId',
              foreignField: '_id',
              as: 'legacyContact'
            }
          },
          {
            $project: {
              projectId: 1,
              stage: 1,
              priority: 1,
              createdAt: 1,
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
              $or: [
                { 'contact.email': { $exists: true, $ne: '', $ne: null } },
                { 'contact.firstPhone': { $exists: true, $ne: '', $ne: null } }
              ]
            }
          },
          {
            $addFields: {
              _email: { $toLower: { $trim: { input: { $ifNull: ['$contact.email', ''] } } } },
              _name: { $toLower: { $trim: { input: { $ifNull: ['$contact.name', ''] } } } },
              _phone: buildNormalizedPhoneExpr({ $ifNull: ['$contact.firstPhone', ''] })
            }
          },
          {
            $addFields: {
              _dedupeKey: {
                $cond: [
                  {
                    $and: [
                      { $gt: [{ $strLenCP: '$_name' }, 0] },
                      { $gt: [{ $strLenCP: '$_phone' }, 0] },
                      { $gt: [{ $strLenCP: '$_email' }, 0] }
                    ]
                  },
                  { $concat: ['npe:', '$_name', '|', '$_phone', '|', '$_email'] },
                  { $concat: ['id:', { $toString: '$contact._id' }] }
                ]
              }
            }
          },
          {
            $lookup: {
              from: 'activities',
              let: { pid: '$projectId', cid: '$contact._id' },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ['$projectId', '$$pid'] },
                        { $eq: ['$contactId', '$$cid'] }
                      ]
                    }
                  }
                },
                { $sort: { createdAt: -1 } },
                { $limit: 1 },
                { $project: { createdAt: 1 } }
              ],
              as: '_lastActivity'
            }
          },
          { $addFields: { _lastActivityAt: { $arrayElemAt: ['$_lastActivity.createdAt', 0] } } },
          { $sort: { _lastActivityAt: -1, createdAt: -1 } },
          { $group: { _id: { projectId: '$projectId', key: '$_dedupeKey' }, doc: { $first: '$$ROOT' } } },
          { $replaceRoot: { newRoot: '$doc' } }
        ];

        return ProjectContact.aggregate([
          ...base,
          { $group: { _id: '$priority', count: { $sum: 1 } } },
          { $sort: { count: -1 } }
        ]).allowDiskUse(true);
      })(),
      
      // Activities by type
      Activity.aggregate([
        { $match: projectFilter },
        { $group: { _id: '$type', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]).allowDiskUse(true),
      
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
      
      // Team performance - Include both team members from projects AND those with activities
      (async () => {
        // Get all projects matching the filter
        const projects = await Project.find(
          projectId && mongoose.Types.ObjectId.isValid(projectId)
            ? { _id: new mongoose.Types.ObjectId(projectId) }
            : projectIds.length > 0 ? { _id: { $in: projectIds } } : {}
        ).select('teamMembers assignedTo').lean();
        
        // Collect all unique team member emails from projects
        const teamMemberEmails = new Set();
        projects.forEach(project => {
          if (project.teamMembers && Array.isArray(project.teamMembers)) {
            project.teamMembers.forEach(email => {
              if (email && email.trim()) {
                teamMemberEmails.add(email.toLowerCase().trim());
              }
            });
          }
          if (project.assignedTo && project.assignedTo.trim()) {
            teamMemberEmails.add(project.assignedTo.toLowerCase().trim());
          }
        });
        
        // Get activity metrics for users who have created activities
        const activityBasedMembers = await Activity.aggregate([
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
          }
        ]);
        
        // Add emails from activity-based members to the set
        activityBasedMembers.forEach(member => {
          if (member.email) {
            teamMemberEmails.add(member.email.toLowerCase().trim());
          }
        });
        
        // Get user details for ALL team members (from projects + activities)
        const allTeamMemberUsers = await User.find({
          email: { $in: Array.from(teamMemberEmails) }
        }).select('_id name email').lean();
        
        // Create a map of activity metrics by user ID
        const activityMap = new Map();
        activityBasedMembers.forEach(member => {
          if (member._id) {
            activityMap.set(member._id.toString(), {
              activityCount: member.activityCount || 0,
              calls: member.calls || 0,
              emails: member.emails || 0,
              linkedin: member.linkedin || 0
            });
          }
        });
        
        // Merge all team members (from projects + activities) with their activity metrics
        const allTeamMembers = allTeamMemberUsers.map(user => {
          const userId = user._id.toString();
          const activities = activityMap.get(userId) || {
            activityCount: 0,
            calls: 0,
            emails: 0,
            linkedin: 0
          };
          
          return {
            _id: user._id,
            name: user.name || 'Unknown',
            email: user.email || '',
            activityCount: activities.activityCount,
            calls: activities.calls,
            emails: activities.emails,
            linkedin: activities.linkedin
          };
        });
        
        // Sort by activity count descending and limit to top 10
        return allTeamMembers
          .sort((a, b) => b.activityCount - a.activityCount)
          .slice(0, 10);
      })(),
      
      // Stage distribution with details (deduped)
      (() => {
        const base = [
          { $match: projectFilter },
          { $match: { contactId: { $ne: null, $exists: true } } },
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
              from: 'contacts',
              localField: 'contactId',
              foreignField: '_id',
              as: 'legacyContact'
            }
          },
          {
            $project: {
              projectId: 1,
              stage: 1,
              priority: 1,
              createdAt: 1,
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
              $or: [
                { 'contact.email': { $exists: true, $ne: '', $ne: null } },
                { 'contact.firstPhone': { $exists: true, $ne: '', $ne: null } }
              ]
            }
          },
          {
            $addFields: {
              _email: { $toLower: { $trim: { input: { $ifNull: ['$contact.email', ''] } } } },
              _name: { $toLower: { $trim: { input: { $ifNull: ['$contact.name', ''] } } } },
              _phone: buildNormalizedPhoneExpr({ $ifNull: ['$contact.firstPhone', ''] })
            }
          },
          {
            $addFields: {
              _dedupeKey: {
                $cond: [
                  {
                    $and: [
                      { $gt: [{ $strLenCP: '$_name' }, 0] },
                      { $gt: [{ $strLenCP: '$_phone' }, 0] },
                      { $gt: [{ $strLenCP: '$_email' }, 0] }
                    ]
                  },
                  { $concat: ['npe:', '$_name', '|', '$_phone', '|', '$_email'] },
                  { $concat: ['id:', { $toString: '$contact._id' }] }
                ]
              }
            }
          },
          {
            $lookup: {
              from: 'activities',
              let: { pid: '$projectId', cid: '$contact._id' },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ['$projectId', '$$pid'] },
                        { $eq: ['$contactId', '$$cid'] }
                      ]
                    }
                  }
                },
                { $sort: { createdAt: -1 } },
                { $limit: 1 },
                { $project: { createdAt: 1 } }
              ],
              as: '_lastActivity'
            }
          },
          { $addFields: { _lastActivityAt: { $arrayElemAt: ['$_lastActivity.createdAt', 0] } } },
          { $sort: { _lastActivityAt: -1, createdAt: -1 } },
          { $group: { _id: { projectId: '$projectId', key: '$_dedupeKey' }, doc: { $first: '$$ROOT' } } },
          { $replaceRoot: { newRoot: '$doc' } }
        ];

        return ProjectContact.aggregate([
          ...base,
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
        ]).allowDiskUse(true);
      })(),
      
      // Cold Calling Funnel - Get all call activities (not just latest) to count contacts that have EVER reached each stage
      Activity.aggregate([
        {
          $match: {
            ...projectFilter,
            type: 'call',
            contactId: { $ne: null, $exists: true }
          }
        },
        {
          $project: {
            contactId: 1,
            callDate: 1,
            callStatus: 1,
            callNumber: 1,
            nextAction: 1,
            nextActionDate: 1,
            conversationNotes: 1,
            createdAt: 1
          }
        },
        {
          $sort: { createdAt: -1 }
        }
      ]).allowDiskUse(true),
      
      // Email Funnel
      Activity.aggregate([
        {
          $match: {
            ...projectFilter,
            type: 'email'
          }
        },
        {
          // Ensure "latest" fields are actually from the most recent activity
          $sort: { emailDate: -1, createdAt: -1 }
        },
        {
          $group: {
            _id: '$contactId',
            emailDate: { $first: '$emailDate' },
            status: { $first: '$status' },
            outcome: { $first: '$outcome' },
            nextActionDate: { $first: '$nextActionDate' },
            createdAt: { $first: '$createdAt' },
            activityCount: { $sum: 1 },
            sentCount: { $sum: { $cond: [{ $ifNull: ['$emailDate', false] }, 1, 0] } }
          }
        }
      ]).allowDiskUse(true),
      
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
            createdAt: { $first: '$createdAt' },
            nextActionDate: { $first: '$nextActionDate' },
            activityCount: { $sum: 1 }
          }
        }
      ]).allowDiskUse(true),
      
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
      
      // Conversion metrics (deduped)
      (() => {
        const base = [
          { $match: projectFilter },
          { $match: { contactId: { $ne: null, $exists: true } } },
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
              from: 'contacts',
              localField: 'contactId',
              foreignField: '_id',
              as: 'legacyContact'
            }
          },
          {
            $project: {
              projectId: 1,
              stage: 1,
              priority: 1,
              createdAt: 1,
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
              $or: [
                { 'contact.email': { $exists: true, $ne: '', $ne: null } },
                { 'contact.firstPhone': { $exists: true, $ne: '', $ne: null } }
              ]
            }
          },
          {
            $addFields: {
              _email: { $toLower: { $trim: { input: { $ifNull: ['$contact.email', ''] } } } },
              _name: { $toLower: { $trim: { input: { $ifNull: ['$contact.name', ''] } } } },
              _phone: buildNormalizedPhoneExpr({ $ifNull: ['$contact.firstPhone', ''] })
            }
          },
          {
            $addFields: {
              _dedupeKey: {
                $cond: [
                  {
                    $and: [
                      { $gt: [{ $strLenCP: '$_name' }, 0] },
                      { $gt: [{ $strLenCP: '$_phone' }, 0] },
                      { $gt: [{ $strLenCP: '$_email' }, 0] }
                    ]
                  },
                  { $concat: ['npe:', '$_name', '|', '$_phone', '|', '$_email'] },
                  { $concat: ['id:', { $toString: '$contact._id' }] }
                ]
              }
            }
          },
          {
            $lookup: {
              from: 'activities',
              let: { pid: '$projectId', cid: '$contact._id' },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ['$projectId', '$$pid'] },
                        { $eq: ['$contactId', '$$cid'] }
                      ]
                    }
                  }
                },
                { $sort: { createdAt: -1 } },
                { $limit: 1 },
                { $project: { createdAt: 1 } }
              ],
              as: '_lastActivity'
            }
          },
          { $addFields: { _lastActivityAt: { $arrayElemAt: ['$_lastActivity.createdAt', 0] } } },
          { $sort: { _lastActivityAt: -1, createdAt: -1 } },
          { $group: { _id: { projectId: '$projectId', key: '$_dedupeKey' }, doc: { $first: '$$ROOT' } } },
          { $replaceRoot: { newRoot: '$doc' } }
        ];

        return ProjectContact.aggregate([
          ...base,
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
        ]).allowDiskUse(true);
      })(),
      
      // Top performing prospects (by activity count), deduped by (name+phone+email)
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
            from: 'contacts',
            localField: 'contactId',
            foreignField: '_id',
            as: 'legacyContact'
          }
        },
        {
          $project: {
            contactId: 1,
            createdAt: 1,
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
            $or: [
              { 'contact.email': { $exists: true, $ne: '', $ne: null } },
              { 'contact.firstPhone': { $exists: true, $ne: '', $ne: null } }
            ]
          }
        },
        {
          $addFields: {
            _email: { $toLower: { $trim: { input: { $ifNull: ['$contact.email', ''] } } } },
            _name: { $toLower: { $trim: { input: { $ifNull: ['$contact.name', ''] } } } },
            _phone: buildNormalizedPhoneExpr({ $ifNull: ['$contact.firstPhone', ''] })
          }
        },
        {
          $addFields: {
            _dedupeKey: {
              $cond: [
                {
                  $and: [
                    { $gt: [{ $strLenCP: '$_name' }, 0] },
                    { $gt: [{ $strLenCP: '$_phone' }, 0] },
                    { $gt: [{ $strLenCP: '$_email' }, 0] }
                  ]
                },
                { $concat: ['npe:', '$_name', '|', '$_phone', '|', '$_email'] },
                { $concat: ['id:', { $toString: '$contactId' }] }
              ]
            }
          }
        },
        {
          $group: {
            _id: '$_dedupeKey',
            name: { $first: '$contact.name' },
            company: { $first: '$contact.company' },
            activityCount: { $sum: 1 },
            lastActivity: { $max: '$createdAt' }
          }
        },
        { $sort: { activityCount: -1 } },
        { $limit: 10 }
      ]).allowDiskUse(true)
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

    // Get all unique contacts for this project (after deduplication) to ensure counts match what users see
    // This is the same logic as in the KPI endpoint
    const allProjectContactsForFunnel = await ProjectContact.find({ ...projectFilter })
      .populate('contactId', 'name email company firstPhone')
      .lean();
    
    const activityContactIdsForFunnel = await Activity.distinct('contactId', {
      ...projectFilter,
      contactId: { $ne: null, $exists: true }
    });
    
    const existingContactIdsForFunnel = new Set(
      allProjectContactsForFunnel
        .map(pc => pc.contactId?._id?.toString())
        .filter(Boolean)
    );
    
    const missingContactIdsForFunnel = activityContactIdsForFunnel.filter(
      contactId => contactId && !existingContactIdsForFunnel.has(contactId.toString())
    );
    
    let activityBasedContactsForFunnel = [];
    if (missingContactIdsForFunnel.length > 0) {
      const missingObjectIds = missingContactIdsForFunnel
        .filter(id => mongoose.Types.ObjectId.isValid(id))
        .map(id => new mongoose.Types.ObjectId(id));
      
      const prospectContacts = await ProspectContact.find({ _id: { $in: missingObjectIds } }).lean();
      const foundIds = new Set(prospectContacts.map(c => c._id.toString()));
      const remainingIds = missingObjectIds.filter(id => !foundIds.has(id.toString()));
      
      let legacyContacts = [];
      if (remainingIds.length > 0) {
        legacyContacts = await Contact.find({ _id: { $in: remainingIds } }).lean();
      }
      
      activityBasedContactsForFunnel = [...prospectContacts, ...legacyContacts];
    }
    
    const allContactsForFunnel = [
      ...allProjectContactsForFunnel.map(pc => ({
        _id: pc.contactId?._id,
        name: pc.contactId?.name,
        email: pc.contactId?.email,
        company: pc.contactId?.company,
        firstPhone: pc.contactId?.firstPhone
      })),
      ...activityBasedContactsForFunnel.map(c => ({
        _id: c._id,
        name: c.name,
        email: c.email,
        company: c.company,
        firstPhone: c.firstPhone
      }))
    ].filter(c => c._id);
    
    // Apply deduplication logic
    const duplicateGroupsForFunnel = new Map();
    allContactsForFunnel.forEach(contact => {
      const email = (contact.email || '').trim().toLowerCase();
      const name = (contact.name || '').trim().toLowerCase();
      const phone = String(contact.firstPhone || '').replace(/\D/g, '').trim();
      
      let identifier = null;
      if (name && email && phone) {
        identifier = `npe:${name}|${phone}|${email}`;
      }
      
      if (identifier) {
        if (!duplicateGroupsForFunnel.has(identifier)) {
          duplicateGroupsForFunnel.set(identifier, []);
        }
        duplicateGroupsForFunnel.get(identifier).push(contact);
      }
    });
    
    const contactsToKeepForFunnel = new Set();
    const duplicateGroupsArrayForFunnel = Array.from(duplicateGroupsForFunnel.entries()).filter(([_, contacts]) => contacts.length > 1);
    
    if (duplicateGroupsArrayForFunnel.length > 0) {
      const allDuplicateContactIdsForFunnel = [];
      duplicateGroupsArrayForFunnel.forEach(([_, contacts]) => {
        contacts.forEach(contact => {
          const contactId = contact._id?.toString ? contact._id.toString() : String(contact._id);
          if (contactId && mongoose.Types.ObjectId.isValid(contactId)) {
            allDuplicateContactIdsForFunnel.push(new mongoose.Types.ObjectId(contactId));
          }
        });
      });
      
      if (allDuplicateContactIdsForFunnel.length > 0) {
        const mostRecentActivitiesForFunnel = await Activity.aggregate([
          {
            $match: {
              ...projectFilter,
              contactId: { $in: allDuplicateContactIdsForFunnel }
            }
          },
          {
            $group: {
              _id: '$contactId',
              mostRecentActivityDate: { $max: '$createdAt' }
            }
          }
        ]);
        
        const activityDateMapForFunnel = new Map();
        mostRecentActivitiesForFunnel.forEach(activity => {
          if (activity._id) {
            activityDateMapForFunnel.set(activity._id.toString(), activity.mostRecentActivityDate);
          }
        });
        
        for (const [identifier, contacts] of duplicateGroupsArrayForFunnel) {
          let contactToKeep = null;
          let mostRecentDate = null;
          
          contacts.forEach(contact => {
            const contactIdStr = contact._id?.toString ? contact._id.toString() : String(contact._id);
            const activityDate = activityDateMapForFunnel.get(contactIdStr);
            
            if (activityDate) {
              if (!mostRecentDate || activityDate > mostRecentDate) {
                mostRecentDate = activityDate;
                contactToKeep = contact;
              }
            } else if (!contactToKeep) {
              contactToKeep = contact;
            }
          });
          
          if (!contactToKeep) {
            contactToKeep = contacts[0];
          }
          
          const contactToKeepId = contactToKeep._id?.toString ? contactToKeep._id.toString() : String(contactToKeep._id);
          contactsToKeepForFunnel.add(contactToKeepId);
        }
      }
    }
    
    const validContactIdsForFunnel = new Set();
    allContactsForFunnel.forEach(contact => {
      const contactIdStr = contact._id?.toString ? contact._id.toString() : String(contact._id);
      const email = (contact.email || '').trim().toLowerCase();
      const name = (contact.name || '').trim().toLowerCase();
      const phone = String(contact.firstPhone || '').replace(/\D/g, '').trim();
      
      let identifier = null;
      if (name && email && phone) {
        identifier = `npe:${name}|${phone}|${email}`;
      }
      
      if (identifier) {
        const isDuplicate = duplicateGroupsForFunnel.has(identifier) && duplicateGroupsForFunnel.get(identifier).length > 1;
        if (!isDuplicate || contactsToKeepForFunnel.has(contactIdStr)) {
          validContactIdsForFunnel.add(contactIdStr);
        }
      } else {
        validContactIdsForFunnel.add(contactIdStr);
      }
    });

    // Cold calling funnel counts must be UNIQUE and based on the MOST RECENT call activity per contact.
    // (This matches the requested "most recently added activity" rule and keeps outside/inside consistent.)
    const latestCallByContactForFunnel = new Map();
    (callFunnel || []).forEach(c => {
      const contactId = c.contactId?.toString();
      if (!contactId || !validContactIdsForFunnel.has(contactId)) return;

      const activityDate = c.callDate ? new Date(c.callDate) : new Date(c.createdAt);
      const existing = latestCallByContactForFunnel.get(contactId);
      if (!existing || activityDate > existing._activityDate) {
        latestCallByContactForFunnel.set(contactId, { ...c, _activityDate: activityDate });
      }
    });

    latestCallByContactForFunnel.forEach((c, contactId) => {
      // Calls Attempted - any call activity
      if (c.callDate || c.callStatus) {
        callsAttemptedSet.add(contactId);
      }

      // Calls Connected - answered (not failed statuses)
      if (c.callStatus && !['Ring', 'Busy', 'Switch Off', 'Invalid', 'Hang Up'].includes(c.callStatus)) {
        callsConnectedSet.add(contactId);
      }

      // Decision Maker Reached - answered and not "Not Interested"
      if (c.callStatus && !['Ring', 'Busy', 'Switch Off', 'Invalid', 'Hang Up', 'Not Interested'].includes(c.callStatus)) {
        decisionMakerReachedSet.add(contactId);
      }

      if (c.callStatus === 'Interested') interestedSet.add(contactId);
      if (c.callStatus === 'Details Shared') detailsSharedSet.add(contactId);
      if (c.callStatus === 'Demo Booked') demoBookedSet.add(contactId);
      if (c.callStatus === 'Demo Completed') demoCompletedSet.add(contactId);
    });

    // Get SQL and WON from ProjectContact stage (same as KPI endpoint) but only for valid (deduped) contacts
    const sqlContacts = await ProjectContact.find({
      ...projectFilter,
      stage: 'SQL'
    }).distinct('contactId');
    sqlContacts.forEach(contactId => {
      if (contactId) {
        const idStr = contactId.toString();
        if (validContactIdsForFunnel.has(idStr)) sqlSet.add(idStr);
      }
    });

    const wonContacts = await ProjectContact.find({
      ...projectFilter,
      stage: 'WON'
    }).distinct('contactId');
    wonContacts.forEach(contactId => {
      if (contactId) {
        const idStr = contactId.toString();
        if (validContactIdsForFunnel.has(idStr)) wonSet.add(idStr);
      }
    });

    // Calculate call status breakdown for the donut chart using UNIQUE latest status per contact
    const callStatusBreakdown = {};
    latestCallByContactForFunnel.forEach((c) => {
      let status = 'No Status';
      if (c.callStatus && typeof c.callStatus === 'string' && c.callStatus.trim() !== '') {
        status = c.callStatus.trim();
      }
      callStatusBreakdown[status] = (callStatusBreakdown[status] || 0) + 1;
    });

    const callFunnelData = {
      prospectData: totalProspects,
      // New 10-stage structure - counts unique contacts that have EVER reached each stage
      callsAttempted: callsAttemptedSet.size,
      callsConnected: callsConnectedSet.size,
      decisionMakerReached: decisionMakerReachedSet.size,
      interested: interestedSet.size,
      detailsShared: detailsSharedSet.size,
      demoBooked: demoBookedSet.size,
      demoCompleted: demoCompletedSet.size,
      sql: sqlSet.size,
      won: wonSet.size,
      // Provide the exact contactIds for each stage so the UI popup can show the same unique count.
      // These ids are already deduped + computed from the most recent call activity per contact.
      stageContactIds: {
        callsAttempted: Array.from(callsAttemptedSet),
        callsConnected: Array.from(callsConnectedSet),
        decisionMakerReached: Array.from(decisionMakerReachedSet),
        interested: Array.from(interestedSet),
        detailsShared: Array.from(detailsSharedSet),
        demoBooked: Array.from(demoBookedSet),
        demoCompleted: Array.from(demoCompletedSet),
        sql: Array.from(sqlSet),
        won: Array.from(wonSet)
      },
      // Call status breakdown for donut chart
      callStatusBreakdown: callStatusBreakdown,
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
    const dedupedEmailFunnel = (emailFunnel || []).filter(e => {
      const contactId = e?._id?.toString();
      return contactId && validContactIdsForFunnel.has(contactId);
    });

    // Build stage contactId sets so popup can match funnel counts exactly (unique + latest per contact).
    const emailSentSet = new Set();
    const emailAcceptedSet = new Set();
    const emailFollowupsSet = new Set();
    const emailCipSet = new Set();
    const emailMeetingProposedSet = new Set();
    const emailScheduledSet = new Set();
    const emailCompletedSet = new Set();
    const emailSqlSet = new Set();

    dedupedEmailFunnel.forEach(e => {
      const contactId = e?._id?.toString();
      if (!contactId) return;

      if (e.emailDate) emailSentSet.add(contactId);
      if (['Interested', 'Meeting Proposed', 'Meeting Scheduled'].includes(e.status)) emailAcceptedSet.add(contactId);
      // "Followups" = more than one email sent
      if ((e.sentCount || 0) > 1) emailFollowupsSet.add(contactId);
      if (e.status === 'CIP') emailCipSet.add(contactId);
      if (e.status === 'Meeting Proposed') emailMeetingProposedSet.add(contactId);
      if (e.status === 'Meeting Scheduled') emailScheduledSet.add(contactId);
      if (e.status === 'Meeting Completed') emailCompletedSet.add(contactId);
      if (e.status === 'SQL' || e.status === 'Meeting Completed') emailSqlSet.add(contactId);
    });

    const emailFunnelData = {
      prospectData: totalProspects,
      emailSent: emailSentSet.size,
      accepted: emailAcceptedSet.size,
      // Funnel "Followups" in UI means: contacts with >1 activity (same logic as stage popup)
      followups: emailFollowupsSet.size,
      cip: emailCipSet.size,
      meetingProposed: emailMeetingProposedSet.size,
      scheduled: emailScheduledSet.size,
      completed: emailCompletedSet.size,
      sql: emailSqlSet.size,
      stageContactIds: {
        emailSent: Array.from(emailSentSet),
        accepted: Array.from(emailAcceptedSet),
        followups: Array.from(emailFollowupsSet),
        cip: Array.from(emailCipSet),
        meetingProposed: Array.from(emailMeetingProposedSet),
        scheduled: Array.from(emailScheduledSet),
        completed: Array.from(emailCompletedSet),
        sql: Array.from(emailSqlSet)
      }
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
    
    (linkedinFunnel || []).forEach(l => {
      const contactId = l._id?.toString();
      if (!contactId) return;
      if (!validContactIdsForFunnel.has(contactId)) return;
      
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
      // Funnel "Followups" in UI means: contacts with >1 activity (same logic as stage popup)
      followups: (() => {
        const s = new Set();
        (linkedinFunnel || []).forEach(l => {
          const contactId = l?._id?.toString();
          if (!contactId) return;
          if (!validContactIdsForFunnel.has(contactId)) return;
          if ((l.activityCount || 0) > 1) s.add(contactId);
        });
        return s.size;
      })(),
      cip: linkedinCipSet.size,
      meetingProposed: linkedinMeetingProposedSet.size,
      scheduled: linkedinScheduledSet.size,
      completed: linkedinCompletedSet.size,
      sql: linkedinSqlSet.size,
      stageContactIds: {
        connectionSent: Array.from(linkedinConnectionSentSet),
        accepted: Array.from(linkedinAcceptedSet),
        followups: (() => {
          const s = new Set();
          (linkedinFunnel || []).forEach(l => {
            const contactId = l?._id?.toString();
            if (!contactId) return;
            if (!validContactIdsForFunnel.has(contactId)) return;
            if ((l.activityCount || 0) > 1) s.add(contactId);
          });
          return Array.from(s);
        })(),
        cip: Array.from(linkedinCipSet),
        meetingProposed: Array.from(linkedinMeetingProposedSet),
        scheduled: Array.from(linkedinScheduledSet),
        completed: Array.from(linkedinCompletedSet),
        sql: Array.from(linkedinSqlSet)
      }
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

// Get team member funnel data for Prospect Analytics Dashboard
// IMPORTANT: This route must come before /:id to avoid route conflicts
router.get('/team-member-funnels', authenticate, async (req, res) => {
  try {
    const user = req.user;
    const isAdmin = user.isAdmin || user.email === 'akshay@kology.co';
    const { projectId } = req.query;
    
    // Build project filter
    let projectFilter = {};
    if (projectId && mongoose.Types.ObjectId.isValid(projectId)) {
      const projectObjectId = new mongoose.Types.ObjectId(projectId);
      if (!isAdmin) {
        const project = await Project.findOne({
          _id: projectObjectId,
          $or: [
            { createdBy: user._id },
            { teamMembers: { $in: [user.email.toLowerCase()] } }
          ]
        });
        if (!project) {
          return res.status(403).json({
            success: false,
            error: 'Access denied to this project'
          });
        }
      }
      projectFilter.projectId = projectObjectId;
    } else if (!isAdmin) {
      const userProjects = await Project.find({
        $or: [
          { createdBy: user._id },
          { teamMembers: { $in: [user.email.toLowerCase()] } }
        ]
      }).lean();
      const projectIds = userProjects.map(p => p._id);
      projectFilter.projectId = { $in: projectIds };
    }
    
    // Get all team members from projects AND those who have created activities
    let projectQuery = {};
    if (projectId && mongoose.Types.ObjectId.isValid(projectId)) {
      projectQuery = { _id: new mongoose.Types.ObjectId(projectId) };
    } else if (projectFilter.projectId) {
      if (projectFilter.projectId.$in) {
        projectQuery = { _id: { $in: projectFilter.projectId.$in } };
      } else {
        projectQuery = { _id: projectFilter.projectId };
      }
    }
    const projectsForTeamMembers = await Project.find(projectQuery).select('teamMembers assignedTo').lean();
    
    // Collect all unique team member emails from projects
    const teamMemberEmails = new Set();
    projectsForTeamMembers.forEach(project => {
      if (project.teamMembers && Array.isArray(project.teamMembers)) {
        project.teamMembers.forEach(email => {
          if (email && email.trim()) {
            teamMemberEmails.add(email.toLowerCase().trim());
          }
        });
      }
      if (project.assignedTo && project.assignedTo.trim()) {
        teamMemberEmails.add(project.assignedTo.toLowerCase().trim());
      }
    });
    
    // Also get team members who have created activities (even if not in teamMembers array)
    const activityBasedMembers = await Activity.aggregate([
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
          email: { $first: '$user.email' }
        }
      }
    ]);
    
    // Add emails from activity-based members to the set
    activityBasedMembers.forEach(member => {
      if (member.email) {
        teamMemberEmails.add(member.email.toLowerCase().trim());
      }
    });
    
    // Get user details for ALL team members (from projects + activities)
    const allTeamMemberUsers = await User.find({
      email: { $in: Array.from(teamMemberEmails) }
    }).select('_id name email').lean();
    
    // Map to the format expected by the rest of the code
    const teamMembers = allTeamMemberUsers.map(user => ({
      _id: user._id,
      name: user.name || 'Unknown',
      email: user.email || ''
    })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    
    // Get total prospects for the project (deduped to match Prospect Management)
    const totalProspects = await ProjectContact.aggregate([
      { $match: projectFilter },
      { $match: { contactId: { $ne: null, $exists: true } } },
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
          from: 'contacts',
          localField: 'contactId',
          foreignField: '_id',
          as: 'legacyContact'
        }
      },
      {
        $project: {
          projectId: 1,
          contactId: 1,
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
          $or: [
            { 'contact.email': { $exists: true, $ne: '', $ne: null } },
            { 'contact.firstPhone': { $exists: true, $ne: '', $ne: null } }
          ]
        }
      },
      {
        $addFields: {
          _email: { $toLower: { $trim: { input: { $ifNull: ['$contact.email', ''] } } } },
          _name: { $toLower: { $trim: { input: { $ifNull: ['$contact.name', ''] } } } },
          _phone: buildNormalizedPhoneExpr({ $ifNull: ['$contact.firstPhone', ''] })
        }
      },
      {
        $addFields: {
          _dedupeKey: {
            $cond: [
              {
                $and: [
                  { $gt: [{ $strLenCP: '$_name' }, 0] },
                  { $gt: [{ $strLenCP: '$_phone' }, 0] },
                  { $gt: [{ $strLenCP: '$_email' }, 0] }
                ]
              },
              { $concat: ['npe:', '$_name', '|', '$_phone', '|', '$_email'] },
              { $concat: ['id:', { $toString: '$contactId' }] }
            ]
          }
        }
      },
      { $group: { _id: { projectId: '$projectId', key: '$_dedupeKey' } } },
      { $count: 'count' }
    ]).allowDiskUse(true).then(r => (r && r[0] ? r[0].count : 0));
    
    // Calculate funnel data for each team member
    const teamMemberFunnels = await Promise.all(
      teamMembers.map(async (member) => {
        const memberId = member._id;
        if (!memberId) return null;
        
        const memberActivityFilter = {
          ...projectFilter,
          createdBy: memberId
        };
        
        // Get all call activities for this member
        const callActivities = await Activity.aggregate([
          {
            $match: {
              ...memberActivityFilter,
              type: 'call',
              contactId: { $ne: null, $exists: true }
            }
          },
          {
            $project: {
              contactId: 1,
              callDate: 1,
              callStatus: 1,
              createdAt: 1
            }
          },
          {
            $sort: { createdAt: -1 }
          }
        ]);
        
        // Get LinkedIn activities for this member
        const linkedinActivities = await Activity.aggregate([
          {
            $match: {
              ...memberActivityFilter,
              type: 'linkedin',
              contactId: { $ne: null, $exists: true }
            }
          },
          {
            $project: {
              contactId: 1,
              linkedinDate: 1,
              lnRequestSent: 1,
              connected: 1,
              status: 1,
              createdAt: 1
            }
          },
          {
            $sort: { createdAt: -1 }
          }
        ]);
        
        // NOTE: LinkedIn funnel stages + SQL/WON are calculated after email activities too,
        // so we can apply the same dedupe-key mapping consistently across all channels.
        
        // Get Email activities for this member
        const emailActivities = await Activity.aggregate([
          {
            $match: {
              ...memberActivityFilter,
              type: 'email',
              contactId: { $ne: null, $exists: true }
            }
          },
          {
            $project: {
              contactId: 1,
              emailDate: 1,
              status: 1,
              createdAt: 1
            }
          },
          {
            $sort: { createdAt: -1 }
          }
        ]);

        // Build contactId -> dedupeKey (name+phone+email) map for this member's contacts
        const allContactIdStrings = Array.from(new Set([
          ...(callActivities || []).map(a => a.contactId?.toString()).filter(Boolean),
          ...(linkedinActivities || []).map(a => a.contactId?.toString()).filter(Boolean),
          ...(emailActivities || []).map(a => a.contactId?.toString()).filter(Boolean)
        ]));

        const allContactObjectIds = allContactIdStrings
          .filter(id => mongoose.Types.ObjectId.isValid(id))
          .map(id => new mongoose.Types.ObjectId(id));

        const contactById = new Map();
        if (allContactObjectIds.length > 0) {
          const prospectContacts = await ProspectContact.find({ _id: { $in: allContactObjectIds } })
            .select('_id name email firstPhone company')
            .lean();
          prospectContacts.forEach(c => contactById.set(c._id.toString(), c));

          const foundIds = new Set(prospectContacts.map(c => c._id.toString()));
          const remainingIds = allContactObjectIds.filter(id => !foundIds.has(id.toString()));
          if (remainingIds.length > 0) {
            const legacyContacts = await Contact.find({ _id: { $in: remainingIds } })
              .select('_id name email firstPhone company')
              .lean();
            legacyContacts.forEach(c => contactById.set(c._id.toString(), c));
          }
        }

        const toDedupeKey = (contactIdStr) => {
          if (!contactIdStr) return null;
          const c = contactById.get(contactIdStr);
          const name = String(c?.name || '').trim().toLowerCase();
          const email = String(c?.email || '').trim().toLowerCase();
          const phone = String(c?.firstPhone || '').replace(/\D/g, '').trim();
          if (name && email && phone) return `npe:${name}|${phone}|${email}`;
          return `id:${contactIdStr}`;
        };

        // Calculate call funnel stages (deduped)
        const callsAttemptedSet = new Set();
        const callsConnectedSet = new Set();
        const decisionMakerReachedSet = new Set();
        const interestedSet = new Set();
        const detailsSharedSet = new Set();
        const demoBookedSet = new Set();
        const demoCompletedSet = new Set();

        (callActivities || []).forEach(c => {
          const contactIdStr = c.contactId?.toString();
          const key = toDedupeKey(contactIdStr);
          if (!key) return;

          if (c.callDate || c.callStatus) callsAttemptedSet.add(key);
          if (c.callStatus && !['Ring', 'Busy', 'Switch Off', 'Invalid', 'Hang Up'].includes(c.callStatus)) callsConnectedSet.add(key);
          if (c.callStatus && !['Ring', 'Busy', 'Switch Off', 'Invalid', 'Hang Up', 'Not Interested'].includes(c.callStatus)) decisionMakerReachedSet.add(key);
          if (c.callStatus === 'Interested') interestedSet.add(key);
          if (c.callStatus === 'Details Shared') detailsSharedSet.add(key);
          if (c.callStatus === 'Demo Booked') demoBookedSet.add(key);
          if (c.callStatus === 'Demo Completed') demoCompletedSet.add(key);
        });

        // SQL and WON from ProjectContact for this member's call-contactIds (deduped)
        const memberContactIds = Array.from(new Set((callActivities || []).map(a => a.contactId?.toString()).filter(Boolean)));
        const memberContactObjectIds = memberContactIds
          .filter(id => mongoose.Types.ObjectId.isValid(id))
          .map(id => new mongoose.Types.ObjectId(id));

        let sqlCount = 0;
        let wonCount = 0;
        if (memberContactObjectIds.length > 0) {
          const sqlIds = await ProjectContact.find({
            ...projectFilter,
            contactId: { $in: memberContactObjectIds },
            stage: 'SQL'
          }).distinct('contactId');
          sqlCount = new Set((sqlIds || []).map(id => toDedupeKey(id?.toString()))).size;

          const wonIds = await ProjectContact.find({
            ...projectFilter,
            contactId: { $in: memberContactObjectIds },
            stage: 'WON'
          }).distinct('contactId');
          wonCount = new Set((wonIds || []).map(id => toDedupeKey(id?.toString()))).size;
        }

        // Calculate LinkedIn funnel stages (deduped, hierarchical)
        const linkedinConnectionSentSet = new Set();
        const linkedinAcceptedSet = new Set();
        const linkedinCipSet = new Set();
        const linkedinMeetingProposedSet = new Set();
        const linkedinScheduledSet = new Set();
        const linkedinCompletedSet = new Set();
        const linkedinSqlSet = new Set();

        (linkedinActivities || []).forEach(l => {
          const contactIdStr = l.contactId?.toString();
          const key = toDedupeKey(contactIdStr);
          if (!key) return;

          if (l.lnRequestSent === 'Yes' || l.lnRequestSent === true) {
            linkedinConnectionSentSet.add(key);
          }

          const currentStatus = l.status;

          if ((l.connected === 'Yes' || l.connected === true) &&
              (!currentStatus || currentStatus === '' ||
               (!['CIP', 'Meeting Proposed', 'Meeting Scheduled', 'Meeting Completed', 'SQL'].includes(currentStatus)))) {
            linkedinAcceptedSet.add(key);
          }

          if (currentStatus === 'CIP') {
            linkedinCipSet.add(key);
            linkedinAcceptedSet.delete(key);
          }

          if (currentStatus === 'Meeting Proposed') {
            linkedinMeetingProposedSet.add(key);
            linkedinAcceptedSet.delete(key);
            linkedinCipSet.delete(key);
          }

          if (currentStatus === 'Meeting Scheduled') {
            linkedinScheduledSet.add(key);
            linkedinAcceptedSet.delete(key);
            linkedinCipSet.delete(key);
            linkedinMeetingProposedSet.delete(key);
          }

          if (currentStatus === 'Meeting Completed') {
            linkedinCompletedSet.add(key);
            linkedinAcceptedSet.delete(key);
            linkedinCipSet.delete(key);
            linkedinMeetingProposedSet.delete(key);
            linkedinScheduledSet.delete(key);
          }

          if (currentStatus === 'SQL' || currentStatus === 'Meeting Completed') {
            linkedinSqlSet.add(key);
          }
        });

        // LinkedIn SQL and WON from ProjectContact for this member's linkedin contactIds (deduped)
        const linkedinContactIds = Array.from(new Set((linkedinActivities || []).map(a => a.contactId?.toString()).filter(Boolean)));
        const linkedinContactObjectIds = linkedinContactIds
          .filter(id => mongoose.Types.ObjectId.isValid(id))
          .map(id => new mongoose.Types.ObjectId(id));

        let linkedinSqlCount = 0;
        let linkedinWonCount = 0;
        if (linkedinContactObjectIds.length > 0) {
          const sqlIds = await ProjectContact.find({
            ...projectFilter,
            contactId: { $in: linkedinContactObjectIds },
            stage: 'SQL'
          }).distinct('contactId');
          linkedinSqlCount = new Set((sqlIds || []).map(id => toDedupeKey(id?.toString()))).size;

          const wonIds = await ProjectContact.find({
            ...projectFilter,
            contactId: { $in: linkedinContactObjectIds },
            stage: 'WON'
          }).distinct('contactId');
          linkedinWonCount = new Set((wonIds || []).map(id => toDedupeKey(id?.toString()))).size;
        }

        // Calculate Email funnel stages (deduped)
        const emailSentSet = new Set();
        const emailAcceptedSet = new Set();
        const emailCipSet = new Set();
        const emailMeetingProposedSet = new Set();
        const emailScheduledSet = new Set();
        const emailCompletedSet = new Set();
        const emailSqlSet = new Set();

        (emailActivities || []).forEach(e => {
          const contactIdStr = e.contactId?.toString();
          const key = toDedupeKey(contactIdStr);
          if (!key) return;

          if (e.emailDate) emailSentSet.add(key);
          if (['Interested', 'Meeting Proposed'].includes(e.status)) emailAcceptedSet.add(key);
          if (e.status === 'CIP') emailCipSet.add(key);
          if (e.status === 'Meeting Proposed') emailMeetingProposedSet.add(key);
          if (e.status === 'Meeting Scheduled') emailScheduledSet.add(key);
          if (e.status === 'Meeting Completed') emailCompletedSet.add(key);
          if (e.status === 'SQL' || e.status === 'Meeting Completed') emailSqlSet.add(key);
        });
        
        return {
          memberId: memberId.toString(),
          name: member.name || 'Unknown',
          email: member.email || '',
          funnels: {
            coldCalling: {
              prospectData: totalProspects,
              callsAttempted: callsAttemptedSet.size,
              callsConnected: callsConnectedSet.size,
              decisionMakerReached: decisionMakerReachedSet.size,
              interested: interestedSet.size,
              detailsShared: detailsSharedSet.size,
              demoBooked: demoBookedSet.size,
              demoCompleted: demoCompletedSet.size,
              sql: sqlCount,
              won: wonCount
            },
            linkedin: {
              prospectData: totalProspects,
              connectionSent: linkedinConnectionSentSet.size,
              accepted: linkedinAcceptedSet.size,
              cip: linkedinCipSet.size,
              meetingProposed: linkedinMeetingProposedSet.size,
              scheduled: linkedinScheduledSet.size,
              completed: linkedinCompletedSet.size,
              sql: linkedinSqlCount,
              win: linkedinWonCount
            },
            email: {
              prospectData: totalProspects,
              emailSent: emailSentSet.size,
              accepted: emailAcceptedSet.size,
              cip: emailCipSet.size,
              meetingProposed: emailMeetingProposedSet.size,
              scheduled: emailScheduledSet.size,
              completed: emailCompletedSet.size,
              sql: emailSqlSet.size
            }
          }
        };
      })
    );
    
    // Filter out null entries
    const validFunnels = teamMemberFunnels.filter(f => f !== null);
    
    res.json({
      success: true,
      data: validFunnels
    });
  } catch (error) {
    console.error('Error fetching team member funnels:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch team member funnels'
    });
  }
});

// Get employee performance data
// IMPORTANT: This route must come before /:id to avoid route conflicts
router.get('/employee-performance', authenticate, async (req, res) => {
  try {
    const user = req.user;
    const isAdmin = user.isAdmin || user.email === 'akshay@kology.co';

    // Get all projects user is allowed to see
    let projectFilter = {};
    if (!isAdmin) {
      projectFilter.$or = [
        { createdBy: user._id },
        { teamMembers: user.email.toLowerCase() }
      ];
    }

    const projects = await Project.find(projectFilter).select('_id companyName createdBy teamMembers').lean();

    // Determine which users to include in the report
    // Admin: all users
    // Non-admin: the current user + any project creators + any team members on projects the user can access
    let users = [];
    if (isAdmin) {
      users = await User.find({}).select('_id name email').lean();
    } else {
      const creatorIds = new Set();
      const memberEmails = new Set();

      // Include the current user
      creatorIds.add(user._id.toString());
      memberEmails.add(user.email);
      memberEmails.add(user.email.toLowerCase());

      // Include all project creators + team members for accessible projects
      for (const p of projects) {
        if (p.createdBy) {
          creatorIds.add(p.createdBy.toString());
        }
        if (Array.isArray(p.teamMembers)) {
          for (const e of p.teamMembers) {
            if (!e) continue;
            memberEmails.add(e);
            memberEmails.add(String(e).toLowerCase());
          }
        }
      }

      const creatorObjectIds = Array.from(creatorIds)
        .filter(Boolean)
        .map((id) => new mongoose.Types.ObjectId(id));

      users = await User.find({
        $or: [
          { _id: { $in: creatorObjectIds } },
          { email: { $in: Array.from(memberEmails) } }
        ]
      }).select('_id name email').lean();
    }

    // Build employee performance data
    const employeePerformance = await Promise.all(
      users.map(async (employee) => {
        // Get projects where user is creator or team member
        const userProjects = projects.filter(p => 
          p.createdBy.toString() === employee._id.toString() ||
          (p.teamMembers && p.teamMembers.some(email => email.toLowerCase() === employee.email.toLowerCase()))
        );

        const projectIds = userProjects.map(p => p._id);

        if (projectIds.length === 0) {
          return {
            userId: employee._id.toString(),
            name: employee.name || employee.email,
            email: employee.email,
            projects: [],
            totalActivities: 0,
            byChannel: {
              email: { total: 0, byStatus: {} },
              call: { total: 0, byStatus: {} },
              linkedin: { total: 0, byStatus: {} }
            },
            byProject: []
          };
        }

        // Build activity match filter with time filter
        const activityMatch = {
          projectId: { $in: projectIds.map(id => new mongoose.Types.ObjectId(id)) },
          createdBy: new mongoose.Types.ObjectId(employee._id)
        };

        // Add date filter if timeFilter is provided
        const { timeFilter } = req.query;
        if (timeFilter) {
          const now = new Date();
          if (timeFilter === 'today') {
            const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            activityMatch.createdAt = { $gte: startOfToday };
          } else if (timeFilter === 'last7days') {
            const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            activityMatch.createdAt = { $gte: sevenDaysAgo };
          } else if (timeFilter === 'lastMonth') {
            const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
            activityMatch.createdAt = { $gte: lastMonth };
          }
        }

        // Get all activities for this user's projects
        const activities = await Activity.aggregate([
          {
            $match: activityMatch
          },
          {
            $lookup: {
              from: 'projects',
              localField: 'projectId',
              foreignField: '_id',
              as: 'project'
            }
          },
          {
            $unwind: {
              path: '$project',
              preserveNullAndEmptyArrays: true
            }
          }
        ]);

        // Calculate metrics by channel and status
        const byChannel = {
          email: { total: 0, byStatus: {} },
          call: { total: 0, byStatus: {} },
          linkedin: { total: 0, byStatus: {} }
        };

        // Calculate metrics by project
        const byProjectMap = new Map();

        activities.forEach(activity => {
          const channel = activity.type;
          const status = activity.status || activity.callStatus || 'No Status';
          const projectId = activity.projectId?.toString();
          const projectName = activity.project?.companyName || 'Unknown';

          // Update channel metrics
          if (byChannel[channel]) {
            byChannel[channel].total++;
            byChannel[channel].byStatus[status] = (byChannel[channel].byStatus[status] || 0) + 1;
          }

          // Update project metrics
          if (!byProjectMap.has(projectId)) {
            byProjectMap.set(projectId, {
              projectId,
              projectName,
              total: 0,
              email: 0,
              call: 0,
              linkedin: 0
            });
          }

          const projectData = byProjectMap.get(projectId);
          projectData.total++;
          if (channel === 'email') projectData.email++;
          if (channel === 'call') projectData.call++;
          if (channel === 'linkedin') projectData.linkedin++;
        });

        const byProject = Array.from(byProjectMap.values());

        return {
          userId: employee._id.toString(),
          name: employee.name || employee.email,
          email: employee.email,
          projects: userProjects.map(p => ({
            id: p._id.toString(),
            companyName: p.companyName,
            isCreator: p.createdBy.toString() === employee._id.toString(),
            isTeamMember: p.teamMembers && p.teamMembers.some(email => email.toLowerCase() === employee.email.toLowerCase())
          })),
          totalActivities: activities.length,
          byChannel,
          byProject
        };
      })
    );

    // Calculate summary statistics
    const summary = {
      totalEmployees: employeePerformance.length,
      totalActivities: employeePerformance.reduce((sum, emp) => sum + emp.totalActivities, 0),
      totalProjects: new Set(employeePerformance.flatMap(emp => emp.projects.map(p => p.id))).size,
      byChannel: {
        email: employeePerformance.reduce((sum, emp) => sum + emp.byChannel.email.total, 0),
        call: employeePerformance.reduce((sum, emp) => sum + emp.byChannel.call.total, 0),
        linkedin: employeePerformance.reduce((sum, emp) => sum + emp.byChannel.linkedin.total, 0)
      }
    };

    res.json({
      success: true,
      data: {
        employees: employeePerformance,
        summary
      }
    });
  } catch (error) {
    console.error('Error fetching employee performance:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch employee performance'
    });
  }
});

// Get all projects
// Get all projects
router.get('/', authenticate, async (req, res) => {
  try {
    const { search, status } = req.query;
    const user = req.user;
    const isAdmin = user.isAdmin || user.email === 'akshay@kology.co';
    
    let filter = {};
    
    // Build access control conditions for non-admin users
    let accessConditions = [];
    if (!isAdmin) {
      accessConditions.push(
        { createdBy: user._id },
        { teamMembers: { $in: [user.email.toLowerCase()] } }
      );
    }

    // Build search conditions
    let searchConditions = [];
    if (search) {
      searchConditions.push(
        { companyName: { $regex: search, $options: 'i' } },
        { 'contactPerson.fullName': { $regex: search, $options: 'i' } },
        { 'contactPerson.email': { $regex: search, $options: 'i' } }
      );
    }

    // Combine filters properly
    if (accessConditions.length > 0 && searchConditions.length > 0) {
      // Both access and search filters exist - use $and to combine them
      filter.$and = [
        { $or: accessConditions },
        { $or: searchConditions }
      ];
    } else if (accessConditions.length > 0) {
      // Only access filter (non-admin users)
      filter.$or = accessConditions;
    } else if (searchConditions.length > 0) {
      // Only search filter (admin users with search)
      filter.$or = searchConditions;
    }
    // If both are empty (admin with no search), filter remains {} which matches all

    if (status) {
      filter.status = status;
    }

    // Debug: Log filter for admins to verify
    if (isAdmin) {
      console.log('Admin user - Filter:', JSON.stringify(filter, null, 2));
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
            // Total Prospects must match Prospect Management for this project.
            // Prospect Management (`GET /projects/:id/project-contacts`) filters out:
            // - missing linked contacts
            // - "default/test" prospects (no email AND no phone)
            // and deduplicates ONLY when name + phone + email all match.
            { $match: { contactId: { $ne: null, $exists: true } } },
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
                from: 'contacts',
                localField: 'contactId',
                foreignField: '_id',
                as: 'legacyContact'
              }
            },
            {
              $project: {
                projectId: 1,
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
                $or: [
                  { 'contact.email': { $exists: true, $ne: '', $ne: null } },
                  { 'contact.firstPhone': { $exists: true, $ne: '', $ne: null } }
                ]
              }
            },
            {
              $addFields: {
                _email: { $toLower: { $trim: { input: { $ifNull: ['$contact.email', ''] } } } },
                _name: { $toLower: { $trim: { input: { $ifNull: ['$contact.name', ''] } } } },
                _phone: {
                  // MongoDB compatibility: avoid $regexReplace (not available on older versions).
                  // Strip common separators via $split + $reduce.
                  $let: {
                    vars: {
                      p0: { $trim: { input: { $ifNull: ['$contact.firstPhone', ''] } } }
                    },
                    in: {
                      $let: {
                        vars: {
                          p1: {
                            $reduce: {
                              input: { $split: ['$$p0', ' '] },
                              initialValue: '',
                              in: { $concat: ['$$value', '$$this'] }
                            }
                          }
                        },
                        in: {
                          $let: {
                            vars: {
                              p2: {
                                $reduce: {
                                  input: { $split: ['$$p1', '-'] },
                                  initialValue: '',
                                  in: { $concat: ['$$value', '$$this'] }
                                }
                              }
                            },
                            in: {
                              $let: {
                                vars: {
                                  p3: {
                                    $reduce: {
                                      input: { $split: ['$$p2', '('] },
                                      initialValue: '',
                                      in: { $concat: ['$$value', '$$this'] }
                                    }
                                  }
                                },
                                in: {
                                  $let: {
                                    vars: {
                                      p4: {
                                        $reduce: {
                                          input: { $split: ['$$p3', ')'] },
                                          initialValue: '',
                                          in: { $concat: ['$$value', '$$this'] }
                                        }
                                      }
                                    },
                                    in: {
                                      $let: {
                                        vars: {
                                          p5: {
                                            $reduce: {
                                              input: { $split: ['$$p4', '+'] },
                                              initialValue: '',
                                              in: { $concat: ['$$value', '$$this'] }
                                            }
                                          }
                                        },
                                        in: '$$p5'
                                      }
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            },
            {
              $addFields: {
                _identifier: {
                  // Deduplicate ONLY when name + phone + email all match.
                  $cond: [
                    {
                      $and: [
                        { $gt: [{ $strLenCP: '$_name' }, 0] },
                        { $gt: [{ $strLenCP: '$_phone' }, 0] },
                        { $gt: [{ $strLenCP: '$_email' }, 0] }
                      ]
                    },
                    { $concat: ['npe:', '$_name', '|', '$_phone', '|', '$_email'] },
                    ''
                  ]
                }
              }
            },
            {
              // If no identifier (should be rare), treat each contact as unique using its id.
              $group: {
                _id: {
                  $cond: [
                    { $gt: [{ $strLenCP: '$_identifier' }, 0] },
                    '$_identifier',
                    { $concat: ['id:', { $toString: '$contact._id' }] }
                  ]
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
                  $eq: ['$projectId', '$$projectId']
                }
              }
            },
            {
              $group: {
                _id: '$stage',
                count: { $sum: 1 }
              }
            }
          ],
          as: 'leadsByStage'
        }
      },
      {
        $lookup: {
          from: 'activities',
          let: { projectId: '$_id' },
          pipeline: [
            {
              $match: {
                $and: [
                  {
                    $expr: {
                      $eq: ['$projectId', '$$projectId']
                    }
                  },
                  { contactId: { $ne: null } },
                  { contactId: { $exists: true } }
                ]
              }
            },
            {
              $project: {
                contactId: 1,
                type: 1,
                callStatus: 1,
                status: 1,
                activityStatus: {
                  $cond: {
                    if: { $eq: ['$type', 'call'] },
                    then: '$callStatus',
                    else: '$status'
                  }
                }
              }
            },
            {
              $match: {
                activityStatus: { $ne: null, $ne: '' }
              }
            },
            {
              $group: {
                _id: {
                  status: '$activityStatus',
                  contactId: '$contactId'
                }
              }
            },
            {
              $group: {
                _id: '$_id.status',
                count: { $sum: 1 }
              }
            }
          ],
          as: 'leadsByActivityStatus'
        }
      },
      {
        $project: {
          _id: 1,
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
                sqlWonLeads: {
                  $filter: {
                    input: '$leadsByStage',
                    as: 'lead',
                    cond: { $in: ['$$lead._id', ['SQL', 'WON']] }
                  }
                }
              },
              in: {
                $sum: {
                  $map: {
                    input: '$$sqlWonLeads',
                    as: 'lead',
                    in: '$$lead.count'
                  }
                }
              }
            }
          },
          leadsByStatus: {
            $let: {
              vars: {
                stageMap: {
                  $arrayToObject: {
                    $map: {
                      input: '$leadsByStage',
                      as: 'lead',
                      in: {
                        k: { $ifNull: ['$$lead._id', 'New'] },
                        v: '$$lead.count'
                      }
                    }
                  }
                },
                activityStatusMap: {
                  $arrayToObject: {
                    $map: {
                      input: '$leadsByActivityStatus',
                      as: 'lead',
                      in: {
                        k: { $ifNull: ['$$lead._id', ''] },
                        v: '$$lead.count'
                      }
                    }
                  }
                }
              },
              in: {
                new: { $ifNull: ['$$stageMap.New', 0] },
                interested: { $ifNull: ['$$activityStatusMap.Interested', 0] },
                cip: { $ifNull: ['$$activityStatusMap.CIP', 0] },
                detailsShared: { $ifNull: ['$$activityStatusMap.Details Shared', 0] },
                demoBooked: { $ifNull: ['$$activityStatusMap.Demo Booked', 0] },
                demoCompleted: { $ifNull: ['$$activityStatusMap.Demo Completed', 0] },
                sql: { $ifNull: ['$$activityStatusMap.SQL', 0] },
                won: { $ifNull: ['$$activityStatusMap.WON', 0] },
                meetingProposed: { $ifNull: ['$$activityStatusMap.Meeting Proposed', 0] },
                meetingScheduled: { $ifNull: ['$$activityStatusMap.Meeting Scheduled', 0] },
                meetingCompleted: { $ifNull: ['$$activityStatusMap.Meeting Completed', 0] }
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
    const user = req.user;
    const isAdmin = user.isAdmin || user.email === 'akshay@kology.co';

    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid project ID format'
      });
    }

    let filter = { _id: projectId };
    
    // Filter by user unless admin - include projects where user is creator OR team member
    if (!isAdmin) {
      filter.$or = [
        { _id: projectId, createdBy: user._id },
        { _id: projectId, teamMembers: { $in: [user.email.toLowerCase()] } }
      ];
    }

    const project = await Project.findOne(filter).lean();

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

// Get KPI metrics for a project
router.get('/:id/kpi-metrics', authenticate, async (req, res) => {
  try {
    const projectId = req.params.id;
    const user = req.user;
    const isAdmin = user.isAdmin || user.email === 'akshay@kology.co';

    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid project ID format'
      });
    }

    const projectObjectId = new mongoose.Types.ObjectId(projectId);

    // Check if project exists and user has access
    let projectFilter = { _id: projectObjectId };
    if (!isAdmin) {
      projectFilter.createdBy = user._id;
    }
    const projectExists = await Project.exists(projectFilter);
    if (!projectExists) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    // Build activity filter
    let activityFilter = { projectId: projectObjectId };
    if (!isAdmin) {
      activityFilter.createdBy = user._id;
    }

    // Get all activities for this project - use select to only fetch needed fields
    const Activity = require('../models/Activity');
    const activities = await Activity.find(activityFilter)
      .select('type template callStatus status contactId callDate emailDate linkedinDate createdAt createdBy lnRequestSent connected nextActionDate')
      .lean();

    // Calculate Call KPIs and Funnel Stages
    const callActivities = activities.filter(a => a.type === 'call');
    const callsMade = callActivities.length;
    const callsAnswered = callActivities.filter(a => 
      a.callStatus && !['Ring', 'Busy', 'Switch Off', 'Invalid', 'Hang Up'].includes(a.callStatus)
    ).length;
    const callAnswerRate = callsMade > 0 
      ? ((callsAnswered / callsMade) * 100).toFixed(1) 
      : '0.0';
    const callsInterested = callActivities.filter(a => 
      a.callStatus && ['Interested', 'Details Shared', 'Demo Booked', 'Demo Completed'].includes(a.callStatus)
    ).length;
    const callInterestedRate = callsMade > 0 
      ? ((callsInterested / callsMade) * 100).toFixed(1) 
      : '0.0';
    const callMeetings = callActivities.filter(a => 
      a.callStatus && ['Demo Booked', 'Demo Completed'].includes(a.callStatus)
    ).length;

    // Calculate Call Funnel Stages
    // Use the same contact set as Prospect Management (ProjectContact-linked prospects only)
    // so KPI tile counts can match the popup list (which is based on /project-contacts).
    const allProjectContacts = await ProjectContact.find({ projectId: projectObjectId })
      .populate('contactId', 'name email company firstPhone')
      .lean();

    // Combine all contacts (project-linked only)
    const allContacts = [
      ...allProjectContacts.map(pc => ({
        _id: pc.contactId?._id,
        name: pc.contactId?.name,
        email: pc.contactId?.email,
        company: pc.contactId?.company,
        firstPhone: pc.contactId?.firstPhone
      }))
    ].filter(c => c._id);
    
    // Apply deduplication logic (same as project-contacts endpoint)
    const duplicateGroups = new Map();
    allContacts.forEach(contact => {
      const email = (contact.email || '').trim().toLowerCase();
      const name = (contact.name || '').trim().toLowerCase();
      const phone = String(contact.firstPhone || '').replace(/\D/g, '').trim();
      
      let identifier = null;
      if (name && email && phone) {
        identifier = `npe:${name}|${phone}|${email}`;
      }
      
      if (identifier) {
        if (!duplicateGroups.has(identifier)) {
          duplicateGroups.set(identifier, []);
        }
        duplicateGroups.get(identifier).push(contact);
      }
    });
    
    // For each duplicate group, find the contact with the most recent activity
    const contactsToKeep = new Set();
    const duplicateGroupsArray = Array.from(duplicateGroups.entries()).filter(([_, contacts]) => contacts.length > 1);
    
    if (duplicateGroupsArray.length > 0) {
      const allDuplicateContactIds = [];
      duplicateGroupsArray.forEach(([_, contacts]) => {
        contacts.forEach(contact => {
          const contactId = contact._id?.toString ? contact._id.toString() : String(contact._id);
          if (contactId && mongoose.Types.ObjectId.isValid(contactId)) {
            allDuplicateContactIds.push(new mongoose.Types.ObjectId(contactId));
          }
        });
      });
      
      if (allDuplicateContactIds.length > 0) {
        const mostRecentActivities = await Activity.aggregate([
          {
            $match: {
              projectId: projectObjectId,
              contactId: { $in: allDuplicateContactIds }
            }
          },
          {
            $group: {
              _id: '$contactId',
              mostRecentActivityDate: { $max: '$createdAt' }
            }
          }
        ]);
        
        const activityDateMap = new Map();
        mostRecentActivities.forEach(activity => {
          if (activity._id) {
            activityDateMap.set(activity._id.toString(), activity.mostRecentActivityDate);
          }
        });
        
        for (const [identifier, contacts] of duplicateGroupsArray) {
          let contactToKeep = null;
          let mostRecentDate = null;
          
          contacts.forEach(contact => {
            const contactIdStr = contact._id?.toString ? contact._id.toString() : String(contact._id);
            const activityDate = activityDateMap.get(contactIdStr);
            
            if (activityDate) {
              if (!mostRecentDate || activityDate > mostRecentDate) {
                mostRecentDate = activityDate;
                contactToKeep = contact;
              }
            } else if (!contactToKeep) {
              contactToKeep = contact;
            }
          });
          
          if (!contactToKeep) {
            contactToKeep = contacts[0];
          }
          
          const contactToKeepId = contactToKeep._id?.toString ? contactToKeep._id.toString() : String(contactToKeep._id);
          contactsToKeep.add(contactToKeepId);
        }
      }
    }
    
    // Get final list of contactIds to count (after deduplication)
    const validContactIds = new Set();
    allContacts.forEach(contact => {
      const contactIdStr = contact._id?.toString ? contact._id.toString() : String(contact._id);
      const email = (contact.email || '').trim().toLowerCase();
      const name = (contact.name || '').trim().toLowerCase();
      const phone = String(contact.firstPhone || '').replace(/\D/g, '').trim();
      
      let identifier = null;
      if (name && email && phone) {
        identifier = `npe:${name}|${phone}|${email}`;
      }
      
      if (identifier) {
        const isDuplicate = duplicateGroups.has(identifier) && duplicateGroups.get(identifier).length > 1;
        if (!isDuplicate || contactsToKeep.has(contactIdStr)) {
          validContactIds.add(contactIdStr);
        }
      } else {
        // No identifier, include it
        validContactIds.add(contactIdStr);
      }
    });
    
    // Call KPIs: base everything on UNIQUE prospects and the MOST RECENTLY ADDED call activity per contact,
    // so tile counts match popup lists (each contact counted once, by latest call status).
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dayAfterTomorrow = new Date(tomorrow);
    dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 1);

    // Build latest call per contact by createdAt (most recently added)
    const latestCallByContact = new Map();
    callActivities.forEach(a => {
      const contactIdStr = a.contactId?.toString();
      if (!contactIdStr || !validContactIds.has(contactIdStr)) return;
      if (!(a.callDate || a.callStatus)) return;

      const created = new Date(a.createdAt || 0);
      const existing = latestCallByContact.get(contactIdStr);
      if (!existing || created > existing.createdAt) {
        latestCallByContact.set(contactIdStr, {
          createdAt: created,
          activityDate: a.callDate ? new Date(a.callDate) : created,
          nextActionDate: a.nextActionDate ? new Date(a.nextActionDate) : null,
          callStatus: a.callStatus || null
        });
      }
    });

    // Counts and contact ID arrays from latest call only (one bucket per contact)
    const callMetricContactIds = {
      totalCalls: [],
      callsAttempted: [],
      callsConnected: [],
      decisionMakerReached: [],
      interested: [],
      notInterested: [],
      detailsShared: [],
      demoBooked: [],
      demoCompleted: [],
      hangUp: [],
      ring: [],
      busy: [],
      switchOff: [],
      callBack: [],
      future: [],
      invalid: [],
      noStatus: []
    };

    latestCallByContact.forEach(({ callStatus }, contactIdStr) => {
      callMetricContactIds.totalCalls.push(contactIdStr);
      callMetricContactIds.callsAttempted.push(contactIdStr);

      const status = (callStatus && String(callStatus).trim()) || 'No Status';
      const connected = status && !['Ring', 'Busy', 'Switch Off', 'Invalid', 'Hang Up'].includes(status);
      const decisionMaker = connected && status !== 'Not Interested';

      if (connected) callMetricContactIds.callsConnected.push(contactIdStr);
      if (decisionMaker) callMetricContactIds.decisionMakerReached.push(contactIdStr);
      if (status === 'Interested') callMetricContactIds.interested.push(contactIdStr);
      if (status === 'Not Interested') callMetricContactIds.notInterested.push(contactIdStr);
      if (status === 'Details Shared') callMetricContactIds.detailsShared.push(contactIdStr);
      if (status === 'Demo Booked') callMetricContactIds.demoBooked.push(contactIdStr);
      if (status === 'Demo Completed') callMetricContactIds.demoCompleted.push(contactIdStr);
      if (status === 'Hang Up') callMetricContactIds.hangUp.push(contactIdStr);
      if (status === 'Ring') callMetricContactIds.ring.push(contactIdStr);
      if (status === 'Busy') callMetricContactIds.busy.push(contactIdStr);
      if (status === 'Switch Off') callMetricContactIds.switchOff.push(contactIdStr);
      if (status === 'Call Back') callMetricContactIds.callBack.push(contactIdStr);
      if (status === 'Future') callMetricContactIds.future.push(contactIdStr);
      if (status === 'Invalid') callMetricContactIds.invalid.push(contactIdStr);
      if (status === 'No Status') callMetricContactIds.noStatus.push(contactIdStr);
    });

    // Total Calls = all call activities (1st, 2nd, 3rd, ...) for unique prospects only
    const totalCallsCount = callActivities.filter(a => {
      const contactIdStr = a.contactId?.toString();
      return contactIdStr && validContactIds.has(contactIdStr) && (a.callDate || a.callStatus);
    }).length;

    const callsAttempted = callMetricContactIds.callsAttempted.length;
    const callsConnected = callMetricContactIds.callsConnected.length;
    const decisionMakerReached = callMetricContactIds.decisionMakerReached.length;
    const interested = callMetricContactIds.interested.length;
    const notInterested = callMetricContactIds.notInterested.length;
    const detailsShared = callMetricContactIds.detailsShared.length;
    const demoBooked = callMetricContactIds.demoBooked.length;
    const demoCompleted = callMetricContactIds.demoCompleted.length;

    // Follow-up metrics from same latest call per contact
    let todayFollowups = 0;
    let tomorrowFollowups = 0;
    let missedFollowups = 0;
    const followupContactIds = { today: [], tomorrow: [], missed: [] };
    latestCallByContact.forEach(({ nextActionDate }, contactIdStr) => {
      if (!nextActionDate || isNaN(nextActionDate.getTime())) return;
      const d = new Date(nextActionDate);
      d.setHours(0, 0, 0, 0);
      if (d >= today && d < tomorrow) {
        todayFollowups += 1;
        followupContactIds.today.push(contactIdStr);
      } else if (d >= tomorrow && d < dayAfterTomorrow) {
        tomorrowFollowups += 1;
        followupContactIds.tomorrow.push(contactIdStr);
      } else if (d < today) {
        missedFollowups += 1;
        followupContactIds.missed.push(contactIdStr);
      }
    });
    
    // Get SQL and WON from project contacts (stage field) for deduplicated contacts
    const sqlContacts = await ProjectContact.countDocuments({ 
      projectId: projectObjectId, 
      contactId: { $in: Array.from(validContactIds).map(id => new mongoose.Types.ObjectId(id)) },
      stage: 'SQL' 
    });
    const wonContacts = await ProjectContact.countDocuments({ 
      projectId: projectObjectId, 
      contactId: { $in: Array.from(validContactIds).map(id => new mongoose.Types.ObjectId(id)) },
      stage: 'WON' 
    });

    // Calculate LinkedIn KPIs - New funnel structure (after deduplication)
    const linkedInActivities = activities.filter(a => a.type === 'linkedin');
    
    // Count unique contacts for each stage (using deduplicated contacts)
    const connectionSent = new Set(linkedInActivities
      .filter(a => {
        const contactIdStr = a.contactId?.toString();
        return contactIdStr && validContactIds.has(contactIdStr) && 
               (a.lnRequestSent === true || a.lnRequestSent === 'Yes');
      })
      .map(a => a.contactId?.toString())
      .filter(Boolean)
    ).size;
    
    const accepted = new Set(linkedInActivities
      .filter(a => {
        const contactIdStr = a.contactId?.toString();
        return contactIdStr && validContactIds.has(contactIdStr) && 
               (a.connected === true || a.connected === 'Yes');
      })
      .map(a => a.contactId?.toString())
      .filter(Boolean)
    ).size;
    
    // Follow-ups: contacts with more than 1 LinkedIn activity
    const linkedInActivityCounts = new Map();
    linkedInActivities.forEach(a => {
      const contactIdStr = a.contactId?.toString();
      if (contactIdStr && validContactIds.has(contactIdStr)) {
        linkedInActivityCounts.set(contactIdStr, (linkedInActivityCounts.get(contactIdStr) || 0) + 1);
      }
    });
    const followUps = Array.from(linkedInActivityCounts.values()).filter(count => count > 1).length;
    
    const cip = new Set(linkedInActivities
      .filter(a => {
        const contactIdStr = a.contactId?.toString();
        return contactIdStr && validContactIds.has(contactIdStr) && 
               a.status && (a.status === 'CIP' || a.status === 'Conversations in Progress');
      })
      .map(a => a.contactId?.toString())
      .filter(Boolean)
    ).size;
    
    const meetingProposed = new Set(linkedInActivities
      .filter(a => {
        const contactIdStr = a.contactId?.toString();
        return contactIdStr && validContactIds.has(contactIdStr) && 
               a.status && a.status === 'Meeting Proposed';
      })
      .map(a => a.contactId?.toString())
      .filter(Boolean)
    ).size;
    
    const scheduled = new Set(linkedInActivities
      .filter(a => {
        const contactIdStr = a.contactId?.toString();
        return contactIdStr && validContactIds.has(contactIdStr) && 
               a.status && a.status === 'Meeting Scheduled';
      })
      .map(a => a.contactId?.toString())
      .filter(Boolean)
    ).size;
    
    const completed = new Set(linkedInActivities
      .filter(a => {
        const contactIdStr = a.contactId?.toString();
        return contactIdStr && validContactIds.has(contactIdStr) && 
               a.status && a.status === 'Meeting Completed';
      })
      .map(a => a.contactId?.toString())
      .filter(Boolean)
    ).size;

    // Not Interested (LinkedIn): unique contacts where LinkedIn status is "Not Interested"
    const linkedInNotInterested = new Set(linkedInActivities
      .filter(a => {
        const contactIdStr = a.contactId?.toString();
        return contactIdStr && validContactIds.has(contactIdStr) && a.status === 'Not Interested';
      })
      .map(a => a.contactId?.toString())
      .filter(Boolean)
    ).size;
    
    // Get SQL and WON from project contacts (stage field) for deduplicated contacts
    const linkedInSqlContacts = await ProjectContact.countDocuments({ 
      projectId: projectObjectId, 
      contactId: { $in: Array.from(validContactIds).map(id => new mongoose.Types.ObjectId(id)) },
      stage: 'SQL' 
    });
    const linkedInWonContacts = await ProjectContact.countDocuments({ 
      projectId: projectObjectId, 
      contactId: { $in: Array.from(validContactIds).map(id => new mongoose.Types.ObjectId(id)) },
      stage: 'WON' 
    });
    
    // Legacy metrics (for backward compatibility if needed)
    const connectionRequestsSent = connectionSent;
    const connectionsAccepted = accepted;
    const connectionAcceptanceRate = connectionSent > 0 
      ? ((accepted / connectionSent) * 100).toFixed(1) 
      : '0.0';
    const messagesSent = new Set(linkedInActivities
      .filter(a => {
        const contactIdStr = a.contactId?.toString();
        return contactIdStr && validContactIds.has(contactIdStr) && a.status && a.status !== '';
      })
      .map(a => a.contactId?.toString())
      .filter(Boolean)
    ).size;
    const messageReplies = new Set(linkedInActivities
      .filter(a => {
        const contactIdStr = a.contactId?.toString();
        return contactIdStr && validContactIds.has(contactIdStr) && 
               a.status && ['Meeting Proposed', 'Meeting Scheduled', 'Meeting Completed', 'SQL', 'Tech Discussion'].includes(a.status);
      })
      .map(a => a.contactId?.toString())
      .filter(Boolean)
    ).size;
    const messageReplyRate = messagesSent > 0 
      ? ((messageReplies / messagesSent) * 100).toFixed(1) 
      : '0.0';
    const linkedInMeetings = new Set(linkedInActivities
      .filter(a => {
        const contactIdStr = a.contactId?.toString();
        return contactIdStr && validContactIds.has(contactIdStr) && 
               a.status && ['Meeting Scheduled', 'Meeting Completed', 'In-Person Meeting'].includes(a.status);
      })
      .map(a => a.contactId?.toString())
      .filter(Boolean)
    ).size;

    // Calculate Email KPIs
    const emailActivities = activities.filter(a => a.type === 'email');
    const emailsSent = emailActivities.length;
    
    // Accepted: emails that were opened (not bounced, opt-out, or no reply)
    const emailAccepted = emailActivities.filter(a => 
      a.status && a.status !== 'Bounce' && a.status !== 'Opt-Out' && a.status !== 'No Reply'
    ).length;
    
    // Followups: contacts with more than 1 email activity
    const emailActivityCounts = new Map();
    emailActivities.forEach(a => {
      if (a.contactId) {
        const contactIdStr = a.contactId.toString();
        emailActivityCounts.set(contactIdStr, (emailActivityCounts.get(contactIdStr) || 0) + 1);
      }
    });
    const emailFollowups = Array.from(emailActivityCounts.values()).filter(count => count > 1).length;
    
    // CIP: Conversations in Progress
    const emailCip = emailActivities.filter(a => 
      a.status && (a.status === 'CIP' || a.status === 'Conversations in Progress')
    ).length;
    
    // Meeting Proposed
    const emailMeetingProposed = emailActivities.filter(a => a.status === 'Meeting Proposed').length;
    
    // Scheduled
    const emailScheduled = emailActivities.filter(a => a.status === 'Meeting Scheduled').length;
    
    // Completed
    const emailCompleted = emailActivities.filter(a => a.status === 'Meeting Completed').length;
    
    // SQL: contacts with SQL stage
    const emailContactIds = new Set(emailActivities
      .filter(a => a.contactId)
      .map(a => a.contactId.toString())
      .filter(Boolean)
    );
    const emailSqlContacts = await ProjectContact.countDocuments({
      projectId: projectObjectId,
      contactId: { $in: Array.from(emailContactIds).map(id => new mongoose.Types.ObjectId(id)) },
      stage: 'SQL'
    });
    
    // Email bounce
    const emailBounce = emailActivities.filter(a => a.status === 'Bounce').length;

    // Not Interested (Email): count emails marked as "Not Interested"
    const emailNotInterested = emailActivities.filter(a => a.status === 'Not Interested').length;
    
    // Legacy metrics (for backward compatibility)
    const emailOpens = emailAccepted;
    const emailOpenRate = emailsSent > 0 
      ? ((emailOpens / emailsSent) * 100).toFixed(1) 
      : '0.0';
    const emailReplies = emailActivities.filter(a => 
      a.status && ['Meeting Proposed', 'Meeting Scheduled', 'Meeting Completed', 'SQL', 'Tech Discussion'].includes(a.status)
    ).length;
    const emailReplyRate = emailsSent > 0 
      ? ((emailReplies / emailsSent) * 100).toFixed(1) 
      : '0.0';
    const emailMeetings = emailActivities.filter(a => 
      a.status && ['Meeting Scheduled', 'Meeting Completed', 'In-Person Meeting'].includes(a.status)
    ).length;

    res.json({
      success: true,
      data: {
        linkedin: {
          // New funnel metrics
          connectionSent,
          accepted,
          followUps,
          cip,
          meetingProposed,
          scheduled,
          completed,
          sql: linkedInSqlContacts,
          win: linkedInWonContacts,
          notInterested: linkedInNotInterested,
          // Legacy metrics (for backward compatibility)
          connectionRequestsSent,
          connectionsAccepted,
          connectionAcceptanceRate: parseFloat(connectionAcceptanceRate),
          messagesSent,
          messageReplies,
          messageReplyRate: parseFloat(messageReplyRate),
          meetingsBooked: linkedInMeetings
        },
        call: {
          callsMade,
          callsAnswered,
          callAnswerRate: parseFloat(callAnswerRate),
          callsInterested,
          callInterestedRate: parseFloat(callInterestedRate),
          meetingsBooked: callMeetings,
          // Total Calls = all activities (1st, 2nd, 3rd...) for unique prospects
          totalCallsCount,
          // Funnel stages (unique prospects, latest call only)
          callsAttempted,
          callsConnected,
          decisionMakerReached,
          interested,
          notInterested,
          detailsShared,
          demoBooked,
          demoCompleted,
          sql: sqlContacts,
          won: wonContacts,
          todayFollowups,
          tomorrowFollowups,
          missedFollowups,
          followupContactIds,
          callMetricContactIds
        },
        email: {
          emailsSent,
          accepted: emailAccepted,
          followups: emailFollowups,
          cip: emailCip,
          meetingProposed: emailMeetingProposed,
          scheduled: emailScheduled,
          completed: emailCompleted,
          sql: emailSqlContacts,
          emailBounce,
          notInterested: emailNotInterested,
          // Legacy metrics (for backward compatibility)
          emailOpens,
          emailOpenRate: parseFloat(emailOpenRate),
          emailReplies,
          emailReplyRate: parseFloat(emailReplyRate),
          meetingsBooked: emailMeetings
        }
      }
    });
  } catch (error) {
    console.error('Error fetching KPI metrics:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch KPI metrics'
    });
  }
});

// Get imported contacts for a project (only contacts already linked to project)
router.get('/:id/project-contacts', authenticate, async (req, res) => {
  try {
    const projectId = req.params.id;
    const page = parseInt(req.query.page) || 1;
    // Default limit to 50 for better performance - can be increased if needed
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    const search = req.query.search ? req.query.search.trim() : null;

    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid project ID format'
      });
    }

    const user = req.user;
    const isAdmin = user.isAdmin || user.email === 'akshay@kology.co';
    
    // Use aggregation for better performance with large datasets
    const projectObjectId = new mongoose.Types.ObjectId(projectId);

    // Check if project exists and user has access (lightweight check)
    // Include projects where user is creator OR team member
    let projectFilter = { _id: projectObjectId };
    if (!isAdmin) {
      projectFilter.$or = [
        { _id: projectObjectId, createdBy: user._id },
        { _id: projectObjectId, teamMembers: { $in: [user.email.toLowerCase()] } }
      ];
    }
    const projectExists = await Project.exists(projectFilter);
    if (!projectExists) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    // Aggregation for Prospect Management list.
    // IMPORTANT: We dedupe in the DB (by identifier) so pagination.total is accurate and stable.
    const pipeline = [
      // Match project contacts - use index
      {
        $match: { projectId: projectObjectId }
      },
      // Sort early for consistent pagination (stable: createdAt then _id)
      {
        $sort: { createdAt: -1, _id: -1 }
      },
      // Lookup prospect contacts (needed for search filtering)
      {
        $lookup: {
          from: PROSPECT_CONTACT_COLLECTION,
          localField: 'contactId',
          foreignField: '_id',
          as: 'prospectContact'
        }
      },
      // Also lookup in Contact collection (legacy collection)
      {
        $lookup: {
          from: 'contacts',
          localField: 'contactId',
          foreignField: '_id',
          as: 'legacyContact'
        }
      },
      // Combine both lookups - prefer ProspectContact, fallback to Contact
      {
        $project: {
          projectId: 1,
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
          contact: { $ne: null },
          // Filter out default/test prospects (no email AND no phone)
          $or: [
            { 'contact.email': { $exists: true, $ne: '', $ne: null } },
            { 'contact.firstPhone': { $exists: true, $ne: '', $ne: null } }
          ]
        }
      },
      // Apply search filter if provided (BEFORE pagination)
      ...(search ? [{
        $match: {
          $or: [
            { 'contact.name': { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
            { 'contact.company': { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
            { 'contact.email': { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
            { 'contact.firstPhone': { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }
          ]
        }
      }] : []),
      // Build a dedupe identifier:
      // ONLY dedupe when name + phone + email all match; otherwise fallback id (unique).
      {
        $addFields: {
          _email: { $toLower: { $trim: { input: { $ifNull: ['$contact.email', ''] } } } },
          _name: { $toLower: { $trim: { input: { $ifNull: ['$contact.name', ''] } } } },
          _phone: {
            // MongoDB compatibility: avoid $regexReplace (not available on older versions).
            // Strip common separators via $split + $reduce.
            $let: {
              vars: {
                p0: { $trim: { input: { $ifNull: ['$contact.firstPhone', ''] } } }
              },
              in: {
                $let: {
                  vars: {
                    p1: {
                      $reduce: {
                        input: { $split: ['$$p0', ' '] },
                        initialValue: '',
                        in: { $concat: ['$$value', '$$this'] }
                      }
                    }
                  },
                  in: {
                    $let: {
                      vars: {
                        p2: {
                          $reduce: {
                            input: { $split: ['$$p1', '-'] },
                            initialValue: '',
                            in: { $concat: ['$$value', '$$this'] }
                          }
                        }
                      },
                      in: {
                        $let: {
                          vars: {
                            p3: {
                              $reduce: {
                                input: { $split: ['$$p2', '('] },
                                initialValue: '',
                                in: { $concat: ['$$value', '$$this'] }
                              }
                            }
                          },
                          in: {
                            $let: {
                              vars: {
                                p4: {
                                  $reduce: {
                                    input: { $split: ['$$p3', ')'] },
                                    initialValue: '',
                                    in: { $concat: ['$$value', '$$this'] }
                                  }
                                }
                              },
                              in: {
                                $let: {
                                  vars: {
                                    p5: {
                                      $reduce: {
                                        input: { $split: ['$$p4', '+'] },
                                        initialValue: '',
                                        in: { $concat: ['$$value', '$$this'] }
                                      }
                                    }
                                  },
                                  in: '$$p5'
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      {
        $addFields: {
          _identifier: {
            $cond: [
              {
                $and: [
                  { $gt: [{ $strLenCP: '$_name' }, 0] },
                  { $gt: [{ $strLenCP: '$_phone' }, 0] },
                  { $gt: [{ $strLenCP: '$_email' }, 0] }
                ]
              },
              { $concat: ['npe:', '$_name', '|', '$_phone', '|', '$_email'] },
              ''
            ]
          }
        }
      },
      {
        $addFields: {
          _identifier: {
            $cond: [
              { $gt: [{ $strLenCP: '$_identifier' }, 0] },
              '$_identifier',
              { $concat: ['id:', { $toString: '$contact._id' }] }
            ]
          }
        }
      },
      // Most recent activity date per contact (used to decide which duplicate to keep)
      {
        $lookup: {
          from: 'activities',
          let: { pid: '$projectId', cid: '$contact._id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$projectId', '$$pid'] },
                    { $eq: ['$contactId', '$$cid'] }
                  ]
                }
              }
            },
            { $sort: { createdAt: -1 } },
            { $limit: 1 },
            { $project: { createdAt: 1 } }
          ],
          as: '_lastActivity'
        }
      },
      {
        $addFields: {
          _lastActivityAt: { $arrayElemAt: ['$_lastActivity.createdAt', 0] }
        }
      },
      // Sort so the "best" record per identifier comes first (stable: _id tiebreaker), then group.
      { $sort: { _lastActivityAt: -1, createdAt: -1, _id: -1 } },
      {
        $group: {
          _id: '$_identifier',
          doc: { $first: '$$ROOT' }
        }
      },
      { $replaceRoot: { newRoot: '$doc' } },
      // Use $facet to get both count and data in one query
      {
        $facet: {
          total: [{ $count: 'count' }],
          data: [
            // Stable sort before pagination so page N is deterministic
            { $sort: { _lastActivityAt: -1, createdAt: -1, _id: -1 } },
            { $skip: skip },
            { $limit: limit },
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
            }
          ]
        }
      }
    ];

    const [result] = await ProjectContact.aggregate(pipeline).allowDiskUse(true);
    const contactsResult = result?.data || [];
    const total = result?.total?.[0]?.count || 0;
    const totalPages = Math.max(1, Math.ceil(total / limit));

    return res.json({
      success: true,
      data: contactsResult,
      pagination: { page, limit, total, totalPages }
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
      teamMembers,
      status
    } = req.body;

    const user = req.user;
    const isAdmin = user.isAdmin || user.email === 'akshay@kology.co';
    
    // Check if user has access (creator or admin)
    let projectFilter = { _id: projectId };
    if (!isAdmin) {
      projectFilter.createdBy = user._id; // Only creator can edit
    }
    
    const project = await Project.findOne(projectFilter);

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found or access denied'
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
    if (teamMembers !== undefined) {
      updateData.teamMembers = Array.isArray(teamMembers) 
        ? teamMembers.filter(email => email && email.trim()).map(email => email.toLowerCase().trim())
        : [];
    }
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

            // ONLY use actual data from the file - NO default values
            // If a field is missing in the Excel file, it should remain empty, not be filled with defaults
            const trimmedName = (name && name.toString().trim()) ? name.toString().trim() : '';
            const trimmedEmail = (email && email.toString().trim()) ? email.toString().trim().toLowerCase() : '';
            const trimmedCompany = (company && company.toString().trim()) ? company.toString().trim() : '';
            const trimmedPersonLinkedinUrl = (personLinkedinUrl && personLinkedinUrl.toString().trim()) ? personLinkedinUrl.toString().trim() : '';
            
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

          // ONLY use actual data from the file - NO default values
          // If a field is missing in the CSV file, it should remain empty, not be filled with defaults
          const trimmedName = (name && name.toString().trim()) ? name.toString().trim() : '';
          const trimmedEmail = (email && email.toString().trim()) ? email.toString().trim().toLowerCase() : '';
          const trimmedCompany = (company && company.toString().trim()) ? company.toString().trim() : '';
          const trimmedPersonLinkedinUrl = (personLinkedinUrl && personLinkedinUrl.trim()) ? personLinkedinUrl.trim() : '';
          
          // Validate that we have at least name or company (required fields)
          if (!trimmedName && !trimmedCompany) {
            errors.push(`Row ${rowNumber}: Name or Company is required`);
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

    // Map incoming "status"-like values (e.g. "Interested") to valid ProjectContact.stage enum values.
    // ActivityLogModal currently calls this endpoint with `stage: formData.status`, which is not always a valid stage.
    const allowedStages = (ProjectContact.schema?.path('stage')?.enumValues || []).filter(Boolean);
    const normalizeProjectContactStage = (rawStage) => {
      if (rawStage === undefined || rawStage === null) return null;
      const s = String(rawStage).trim();
      if (!s) return null;
      if (allowedStages.includes(s)) return s;

      const key = s.toLowerCase();
      const map = {
        // Common "status" values → stages
        'interested': 'CIP',
        'details shared': 'CIP',
        'existing': 'CIP',
        'call back': 'CIP',
        'callback': 'CIP',
        'follow up': 'CIP',
        'follow-up': 'CIP',
        'future': 'Potential Future',
        'potential future': 'Potential Future',
        'low potential - open': 'Low Potential - Open',
        'not interested': 'Not Interested',

        // Meetings
        'demo booked': 'Meeting Scheduled',
        'meeting proposed': 'Meeting Proposed',
        'meeting scheduled': 'Meeting Scheduled',
        'in-person meeting': 'In-Person Meeting',
        'in person meeting': 'In-Person Meeting',
        'demo completed': 'Meeting Completed',
        'meeting completed': 'Meeting Completed',
        'tech discussion': 'Tech Discussion',

        // Call outcomes that imply "No Reply"
        'ring': 'No Reply',
        'ringing': 'No Reply',
        'busy': 'No Reply',
        'hang up': 'No Reply',
        'hung up': 'No Reply',
        'switch off': 'No Reply',
        'switched off': 'No Reply',
        'invalid': 'No Reply',
        'wrong number': 'No Reply',
        'no reply': 'No Reply',

        // Email / LinkedIn outcomes that imply lost
        'bounce': 'Lost',
        'bounced': 'Lost',
        'opt-out': 'Lost',
        'opt out': 'Lost',
        'unsubscribed': 'Lost',
        'wrong person': 'Lost',

        // Direct stage shortcuts
        'cip': 'CIP',
        'sql': 'SQL',
        'won': 'WON',
        'lost': 'Lost',
        'new': 'New',
        'contacted': 'Contacted',
        'qualified': 'Qualified',
        'proposal': 'Proposal',
        'negotiation': 'Negotiation'
      };

      const mapped = map[key] || null;
      if (mapped && allowedStages.includes(mapped)) return mapped;
      return null;
    };

    const normalizedStage = normalizeProjectContactStage(stage);

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
        stage: normalizedStage || 'New',
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
    // If stage was provided but cannot be normalized to an allowed enum, ignore it to avoid 400s
    // from ActivityLogModal when saving activities (it uses activity "status" values).
    if (stage !== undefined) {
      if (normalizedStage) {
        projectContact.stage = normalizedStage;
      }
    }
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

