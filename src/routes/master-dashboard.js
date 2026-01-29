const express = require('express');
const router = express.Router();
const Project = require('../models/Project');
const ProspectContact = require('../models/ProspectContact');
const ProjectContact = require('../models/ProjectContact');
const Activity = require('../models/Activity');
const Contact = require('../models/Contact');
const authenticate = require('../middleware/auth');
const mongoose = require('mongoose');

// Master Dashboard - All Projects Summary
router.get('/', authenticate, async (req, res) => {
  try {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const thisWeekStart = new Date(today);
    thisWeekStart.setDate(today.getDate() - today.getDay()); // Start of week (Sunday)
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Get all projects - all users can see all data in master dashboard
    const allProjects = await Project.find().lean();
    const projectIds = allProjects.map(p => p._id);

    // Parallel queries for performance
    const [
      activeProjects,
      totalLeadsInPlay,
      totalTouchesThisWeek,
      totalTouchesThisMonth,
      totalMeetingsBookedThisWeek,
      totalMeetingsBookedThisMonth,
      projectMetrics,
      channelEfficiency,
      teamPerformance,
      dataQualityMetrics,
      linkedInMetrics,
      coldCallMetrics,
      coldCallStatusBreakdownRows,
      emailMetrics,
      followUpMetrics,
      alerts
    ] = await Promise.all([
      // Active projects count
      Project.countDocuments({ status: 'active' }),

      // Total leads in play (prospects in active projects)
      ProjectContact.countDocuments({ 
        projectId: { $in: projectIds },
        stage: { $nin: ['WON', 'Lost'] }
      }),

      // Total touches this week (activities created this week)
      Activity.countDocuments({
        projectId: { $in: projectIds },
        createdAt: { $gte: thisWeekStart }
      }),

      // Total touches this month
      Activity.countDocuments({
        projectId: { $in: projectIds },
        createdAt: { $gte: thisMonthStart }
      }),

      // Meetings booked this week
      Activity.countDocuments({
        projectId: { $in: projectIds },
        createdAt: { $gte: thisWeekStart },
        status: { $in: ['Meeting Scheduled', 'Meeting Completed', 'In-Person Meeting'] }
      }),

      // Meetings booked this month
      Activity.countDocuments({
        projectId: { $in: projectIds },
        createdAt: { $gte: thisMonthStart },
        status: { $in: ['Meeting Scheduled', 'Meeting Completed', 'In-Person Meeting'] }
      }),

      // Project-level metrics (weighted conversion, meetings per 100 leads, etc.)
      ProjectContact.aggregate([
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
        {
          $group: {
            _id: '$projectId',
            projectName: { $first: '$project.companyName' },
            totalProspects: { $sum: 1 },
            won: { $sum: { $cond: [{ $eq: ['$stage', 'WON'] }, 1, 0] } },
            lost: { $sum: { $cond: [{ $eq: ['$stage', 'Lost'] }, 1, 0] } },
            sql: { $sum: { $cond: [{ $eq: ['$stage', 'SQL'] }, 1, 0] } },
            cip: { $sum: { $cond: [{ $eq: ['$stage', 'CIP'] }, 1, 0] } },
            meetings: {
              $sum: {
                $cond: [
                  { $in: ['$stage', ['Meeting Scheduled', 'Meeting Completed', 'In-Person Meeting']] },
                  1,
                  0
                ]
              }
            }
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
            projectName: 1,
            totalProspects: 1,
            won: 1,
            lost: 1,
            sql: 1,
            cip: 1,
            meetings: 1,
            totalActivities: { $size: '$activities' },
            conversionRate: {
              $cond: [
                { $gt: ['$totalProspects', 0] },
                { $multiply: [{ $divide: ['$won', '$totalProspects'] }, 100] },
                0
              ]
            },
            meetingsPer100Leads: {
              $cond: [
                { $gt: ['$totalProspects', 0] },
                { $multiply: [{ $divide: ['$meetings', '$totalProspects'] }, 100] },
                0
              ]
            }
          }
        },
        { $sort: { conversionRate: -1 } }
      ]),

      // Channel efficiency leaderboard
      Activity.aggregate([
        { $match: { projectId: { $in: projectIds } } },
        {
          $group: {
            _id: '$type',
            total: { $sum: 1 },
            linkedinSent: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ['$type', 'linkedin'] }, { $ne: ['$linkedInUrl', null] }] },
                  1,
                  0
                ]
              }
            },
            linkedinAccepted: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ['$type', 'linkedin'] }, { $eq: ['$connected', 'Yes'] }] },
                  1,
                  0
                ]
              }
            },
            callsMade: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ['$type', 'call'] }, { $ne: ['$callStatus', null] }] },
                  1,
                  0
                ]
              }
            },
            callsConnected: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ['$type', 'call'] }, { $in: ['$callStatus', ['Interested', 'Details Shared', 'Demo Booked', 'Demo Completed']] }] },
                  1,
                  0
                ]
              }
            },
            emailsSent: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ['$type', 'email'] }, { $ne: ['$email', null] }] },
                  1,
                  0
                ]
              }
            },
            emailsReplied: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ['$type', 'email'] }, { $in: ['$status', ['Interested', 'Meeting Proposed', 'Meeting Scheduled']] }] },
                  1,
                  0
                ]
              }
            }
          }
        }
      ]),

      // Team performance leaderboard
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
            totalActivities: { $sum: 1 },
            calls: { $sum: { $cond: [{ $eq: ['$type', 'call'] }, 1, 0] } },
            emails: { $sum: { $cond: [{ $eq: ['$type', 'email'] }, 1, 0] } },
            linkedin: { $sum: { $cond: [{ $eq: ['$type', 'linkedin'] }, 1, 0] } },
            meetings: {
              $sum: {
                $cond: [
                  { $in: ['$status', ['Meeting Scheduled', 'Meeting Completed', 'In-Person Meeting']] },
                  1,
                  0
                ]
              }
            }
          }
        },
        { $sort: { totalActivities: -1 } },
        { $limit: 20 }
      ]),

      // Data quality metrics
      ProspectContact.aggregate([
        {
          $project: {
            hasEmail: { $cond: [{ $and: [{ $ne: ['$email', null] }, { $ne: ['$email', ''] }] }, 1, 0] },
            hasValidEmail: {
              $cond: [
                {
                  $and: [
                    { $ne: ['$email', null] },
                    { $ne: ['$email', ''] },
                    { $regexMatch: { input: '$email', regex: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ } }
                  ]
                },
                1,
                0
              ]
            },
            hasPhone: { $cond: [{ $and: [{ $ne: ['$firstPhone', null] }, { $ne: ['$firstPhone', ''] }] }, 1, 0] },
            hasLinkedIn: { $cond: [{ $and: [{ $ne: ['$personLinkedinUrl', null] }, { $ne: ['$personLinkedinUrl', ''] }] }, 1, 0] }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            withEmail: { $sum: '$hasEmail' },
            withValidEmail: { $sum: '$hasValidEmail' },
            withPhone: { $sum: '$hasPhone' },
            withLinkedIn: { $sum: '$hasLinkedIn' }
          }
        }
      ]),

      // LinkedIn metrics
      Activity.aggregate([
        {
          $match: {
            projectId: { $in: projectIds },
            type: 'linkedin'
          }
        },
        {
          $group: {
            _id: null,
            connectionRequestsSent: {
              $sum: {
                $cond: [
                  { $and: [{ $ne: ['$linkedInUrl', null] }, { $ne: ['$lnRequestSent', null] }] },
                  1,
                  0
                ]
              }
            },
            accepted: {
              $sum: {
                $cond: [{ $eq: ['$connected', 'Yes'] }, 1, 0]
              }
            },
            messagesSent: {
              $sum: {
                $cond: [
                  { $and: [{ $ne: ['$linkedInUrl', null] }, { $ne: ['$conversationNotes', null] }, { $ne: ['$conversationNotes', ''] }] },
                  1,
                  0
                ]
              }
            },
            replies: {
              $sum: {
                $cond: [
                  { $in: ['$status', ['Interested', 'CIP', 'SQL', 'Meeting Proposed', 'Meeting Scheduled']] },
                  1,
                  0
                ]
              }
            },
            meetingsBooked: {
              $sum: {
                $cond: [
                  { $in: ['$status', ['Meeting Scheduled', 'Meeting Completed', 'In-Person Meeting']] },
                  1,
                  0
                ]
              }
            }
          }
        }
      ]),

      // Cold Call metrics
      Activity.aggregate([
        {
          $match: {
            projectId: { $in: projectIds },
            type: 'call'
          }
        },
        {
          $group: {
            _id: null,
            callsMade: {
              $sum: {
                $cond: [{ $ne: ['$callStatus', null] }, 1, 0]
              }
            },
            connected: {
              $sum: {
                $cond: [
                  { $in: ['$callStatus', ['Interested', 'Details Shared', 'Demo Booked', 'Demo Completed', 'Call Back', 'Future']] },
                  1,
                  0
                ]
              }
            },
            decisionMakerConnects: {
              $sum: {
                $cond: [
                  { $in: ['$callStatus', ['Interested', 'Details Shared', 'Demo Booked', 'Demo Completed']] },
                  1,
                  0
                ]
              }
            },
            interested: {
              $sum: {
                $cond: [{ $eq: ['$callStatus', 'Interested'] }, 1, 0]
              }
            },
            meetingsBooked: {
              $sum: {
                $cond: [
                  { $in: ['$status', ['Meeting Scheduled', 'Meeting Completed', 'In-Person Meeting']] },
                  1,
                  0
                ]
              }
            }
          }
        }
      ]),

      // Cold Call status breakdown (for Call Status Distribution chart, same as Prospect Analytics)
      Activity.aggregate([
        { $match: { projectId: { $in: projectIds }, type: 'call' } },
        {
          $group: {
            _id: {
              $cond: [
                { $or: [{ $eq: ['$callStatus', null] }, { $eq: [{ $strLenCP: { $ifNull: ['$callStatus', ''] } }, 0] }] },
                'No Status',
                { $trim: { input: { $ifNull: ['$callStatus', ''] } } }
              ]
            },
            count: { $sum: 1 }
          }
        }
      ]),

      // Email metrics
      Activity.aggregate([
        {
          $match: {
            projectId: { $in: projectIds },
            type: 'email'
          }
        },
        {
          $group: {
            _id: null,
            emailsSent: {
              $sum: {
                $cond: [{ $ne: ['$email', null] }, 1, 0]
              }
            },
            bounced: {
              $sum: {
                $cond: [{ $eq: ['$status', 'Bounce'] }, 1, 0]
              }
            },
            replied: {
              $sum: {
                $cond: [
                  { $in: ['$status', ['Interested', 'Meeting Proposed', 'Meeting Scheduled', 'Out of Office', 'Not Interested']] },
                  1,
                  0
                ]
              }
            },
            positiveReplies: {
              $sum: {
                $cond: [
                  { $in: ['$status', ['Interested', 'Meeting Proposed', 'Meeting Scheduled']] },
                  1,
                  0
                ]
              }
            },
            meetingsBooked: {
              $sum: {
                $cond: [
                  { $in: ['$status', ['Meeting Scheduled', 'Meeting Completed', 'In-Person Meeting']] },
                  1,
                  0
                ]
              }
            }
          }
        }
      ]),

      // Follow-up discipline metrics
      Activity.aggregate([
        {
          $match: {
            projectId: { $in: projectIds },
            nextActionDate: { $ne: null }
          }
        },
        {
          $project: {
            nextActionDate: 1,
            createdAt: 1,
            projectId: 1,
            contactId: 1,
            nextAction: 1
          }
        },
        {
          $lookup: {
            from: 'activities',
            let: { 
              contactId: '$contactId',
              projectId: '$projectId',
              nextActionDate: '$nextActionDate'
            },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ['$contactId', '$$contactId'] },
                      { $eq: ['$projectId', '$$projectId'] },
                      { $gt: ['$createdAt', '$$nextActionDate'] }
                    ]
                  }
                }
              },
              { $sort: { createdAt: 1 } },
              { $limit: 1 }
            ],
            as: 'followUpActivity'
          }
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
          $unwind: { path: '$project', preserveNullAndEmptyArrays: true }
        },
        {
          $project: {
            nextActionDate: 1,
            createdAt: 1,
            projectId: 1,
            projectName: '$project.companyName',
            hasFollowUp: { $gt: [{ $size: '$followUpActivity' }, 0] },
            isOverdue: { $lt: ['$nextActionDate', new Date()] },
            daysOverdue: {
              $cond: [
                { $lt: ['$nextActionDate', new Date()] },
                { $divide: [{ $subtract: [new Date(), '$nextActionDate'] }, 86400000] },
                0
              ]
            },
            actionDate: { $dateToString: { format: '%Y-%m-%d', date: '$nextActionDate' } }
          }
        },
        {
          $group: {
            _id: null,
            totalDue: { $sum: 1 },
            completed: {
              $sum: {
                $cond: ['$hasFollowUp', 1, 0]
              }
            },
            overdue: {
              $sum: {
                $cond: ['$isOverdue', 1, 0]
              }
            },
            overdueCount: {
              $sum: {
                $cond: [{ $and: ['$isOverdue', { $not: '$hasFollowUp' }] }, 1, 0]
              }
            },
            byDate: {
              $push: {
                date: '$actionDate',
                hasFollowUp: '$hasFollowUp',
                isOverdue: '$isOverdue'
              }
            },
            byProject: {
              $push: {
                projectName: '$projectName',
                hasFollowUp: '$hasFollowUp',
                isOverdue: '$isOverdue'
              }
            }
          }
        }
      ]),

      // Alerts
      Promise.all([
        // Projects with low activity last 3 days
        Activity.aggregate([
          {
            $match: {
              projectId: { $in: projectIds },
              createdAt: { $gte: threeDaysAgo }
            }
          },
          {
            $group: {
              _id: '$projectId',
              activityCount: { $sum: 1 }
            }
          },
          {
            $lookup: {
              from: 'projects',
              localField: '_id',
              foreignField: '_id',
              as: 'project'
            }
          },
          { $unwind: '$project' },
          {
            $lookup: {
              from: 'projectcontacts',
              localField: '_id',
              foreignField: 'projectId',
              as: 'contacts'
            }
          },
          {
            $project: {
              projectName: '$project.companyName',
              activityCount: 1,
              totalContacts: { $size: '$contacts' },
              activityPerContact: {
                $cond: [
                  { $gt: [{ $size: '$contacts' }, 0] },
                  { $divide: ['$activityCount', { $size: '$contacts' }] },
                  0
                ]
              }
            }
          },
          { $match: { activityPerContact: { $lt: 0.1 } } }, // Less than 0.1 activities per contact
          { $sort: { activityPerContact: 1 } },
          { $limit: 10 }
        ]),

        // Projects with high bounce/wrong data
        Activity.aggregate([
          {
            $match: {
              projectId: { $in: projectIds },
              type: 'email',
              status: { $in: ['Bounce', 'Wrong Person'] }
            }
          },
          {
            $group: {
              _id: '$projectId',
              bounceCount: {
                $sum: {
                  $cond: [{ $eq: ['$status', 'Bounce'] }, 1, 0]
                }
              },
              wrongPersonCount: {
                $sum: {
                  $cond: [{ $eq: ['$status', 'Wrong Person'] }, 1, 0]
                }
              },
              total: { $sum: 1 }
            }
          },
          {
            $lookup: {
              from: 'projects',
              localField: '_id',
              foreignField: '_id',
              as: 'project'
            }
          },
          { $unwind: '$project' },
          {
            $project: {
              projectName: '$project.companyName',
              bounceCount: 1,
              wrongPersonCount: 1,
              total: 1,
              errorRate: {
                $cond: [
                  { $gt: ['$total', 0] },
                  { $multiply: [{ $divide: [{ $add: ['$bounceCount', '$wrongPersonCount'] }, '$total'] }, 100] },
                  0
                ]
              }
            }
          },
          { $match: { errorRate: { $gt: 10 } } }, // More than 10% error rate
          { $sort: { errorRate: -1 } },
          { $limit: 10 }
        ]),

        // Projects with missing follow-ups (overdue)
        Activity.aggregate([
          {
            $match: {
              projectId: { $in: projectIds },
              nextActionDate: { $ne: null, $lt: new Date() }
            }
          },
          {
            $lookup: {
              from: 'activities',
              let: {
                contactId: '$contactId',
                projectId: '$projectId',
                nextActionDate: '$nextActionDate'
              },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ['$contactId', '$$contactId'] },
                        { $eq: ['$projectId', '$$projectId'] },
                        { $gt: ['$createdAt', '$$nextActionDate'] }
                      ]
                    }
                  }
                },
                { $limit: 1 }
              ],
              as: 'followUp'
            }
          },
          {
            $match: {
              followUp: { $size: 0 } // No follow-up activity found
            }
          },
          {
            $group: {
              _id: '$projectId',
              overdueCount: { $sum: 1 }
            }
          },
          {
            $lookup: {
              from: 'projects',
              localField: '_id',
              foreignField: '_id',
              as: 'project'
            }
          },
          { $unwind: '$project' },
          {
            $project: {
              projectName: '$project.companyName',
              overdueCount: 1
            }
          },
          { $sort: { overdueCount: -1 } },
          { $limit: 10 }
        ])
      ])
    ]);

    // Process channel efficiency data
    // The aggregation groups by type, so we get separate documents for each type
    const linkedinChannelData = channelEfficiency.find(c => c._id === 'linkedin') || {};
    const callChannelData = channelEfficiency.find(c => c._id === 'call') || {};
    const emailChannelData = channelEfficiency.find(c => c._id === 'email') || {};
    
    const linkedinTotal = linkedinChannelData.linkedinSent || 0;
    const linkedinAccepted = linkedinChannelData.linkedinAccepted || 0;
    const callsTotal = callChannelData.callsMade || 0;
    const callsConnected = callChannelData.callsConnected || 0;
    const emailsTotal = emailChannelData.emailsSent || 0;
    const emailsReplied = emailChannelData.emailsReplied || 0;

    // Process data quality
    const dataQuality = dataQualityMetrics[0] || {};
    const totalProspects = dataQuality.total || 0;
    const validEmailCount = dataQuality.withValidEmail || 0;
    const validPhoneCount = dataQuality.withPhone || 0;

    // Process LinkedIn metrics
    const linkedInData = linkedInMetrics[0] || {};
    const connectionRequestsSent = linkedInData.connectionRequestsSent || 0;
    const linkedinAcceptedCount = linkedInData.accepted || 0;
    const messagesSent = linkedInData.messagesSent || 0;
    const linkedinReplies = linkedInData.replies || 0;

    // Process Cold Call metrics
    const coldCallData = coldCallMetrics[0] || {};
    const callsMadeCount = coldCallData.callsMade || 0;
    const callsConnectedCount = coldCallData.connected || 0;
    const decisionMakerConnects = coldCallData.decisionMakerConnects || 0;
    const interestedCount = coldCallData.interested || 0;
    const callMeetingsBooked = coldCallData.meetingsBooked || 0;

    // Build call status breakdown object for Call Status Distribution chart (same as Prospect Analytics)
    const callStatusBreakdown = {};
    (coldCallStatusBreakdownRows || []).forEach((row) => {
      const status = row._id != null && row._id !== '' ? String(row._id) : 'No Status';
      callStatusBreakdown[status] = (callStatusBreakdown[status] || 0) + (row.count || 0);
    });

    // Process Email metrics
    const emailData = emailMetrics[0] || {};
    const emailsSentCount = emailData.emailsSent || 0;
    const bouncedCount = emailData.bounced || 0;
    const emailsRepliedCount = emailData.replied || 0;
    const positiveReplies = emailData.positiveReplies || 0;
    const emailMeetingsBooked = emailData.meetingsBooked || 0;

    // Process Follow-up metrics
    const followUpData = followUpMetrics[0] || {};
    const totalDue = followUpData.totalDue || 0;
    const followUpsCompleted = followUpData.completed || 0;
    const overdueCount = followUpData.overdueCount || 0;

    // Calculate weighted conversion rate
    let totalWeightedConversion = 0;
    let totalWeight = 0;
    projectMetrics.forEach(project => {
      if (project.totalProspects > 0) {
        const weight = project.totalProspects;
        totalWeightedConversion += project.conversionRate * weight;
        totalWeight += weight;
      }
    });
    const weightedConversionRate = totalWeight > 0 ? totalWeightedConversion / totalWeight : 0;

    // Calculate SLA compliance
    const slaCompliance = totalDue > 0 ? ((followUpsCompleted / totalDue) * 100) : 100;

    // Process alerts
    const [lowActivityProjects, highBounceProjects, missingFollowUps] = alerts;

    // Calculate duplicate rate (check for duplicate emails)
    const duplicateCheck = await ProspectContact.aggregate([
      {
        $group: {
          _id: { $toLower: '$email' },
          count: { $sum: 1 }
        }
      },
      {
        $match: {
          count: { $gt: 1 }
        }
      },
      {
        $group: {
          _id: null,
          duplicateEmails: { $sum: { $subtract: ['$count', 1] } }
        }
      }
    ]);
    const duplicateCount = duplicateCheck[0]?.duplicateEmails || 0;
    const duplicateRate = totalProspects > 0 ? ((duplicateCount / totalProspects) * 100) : 0;

    // Calculate data quality score
    const emailQuality = totalProspects > 0 ? ((validEmailCount / totalProspects) * 100) : 0;
    const phoneQuality = totalProspects > 0 ? ((validPhoneCount / totalProspects) * 100) : 0;
    const dataQualityScore = (emailQuality + phoneQuality) / 2;

    // Get leads added (daily/weekly)
    const leadsAddedDaily = await ProspectContact.countDocuments({
      createdAt: { $gte: today }
    });
    const leadsAddedWeekly = await ProspectContact.countDocuments({
      createdAt: { $gte: thisWeekStart }
    });

    res.json({
      success: true,
      data: {
        // Executive Tiles
        executive: {
          activeProjects,
          totalLeadsInPlay,
          totalTouchesThisWeek,
          totalTouchesThisMonth,
          totalMeetingsBookedThisWeek,
          totalMeetingsBookedThisMonth,
          weightedConversionRate: parseFloat(weightedConversionRate.toFixed(2)),
          slaCompliance: parseFloat(slaCompliance.toFixed(2))
        },

        // Rankings
        rankings: {
          bestPerformingProjects: projectMetrics
            .filter(p => p.totalProspects >= 10) // Only projects with at least 10 prospects
            .sort((a, b) => b.meetingsPer100Leads - a.meetingsPer100Leads)
            .slice(0, 10)
            .map(p => ({
              projectName: p.projectName || 'Unknown',
              meetingsPer100Leads: parseFloat(p.meetingsPer100Leads.toFixed(2)),
              totalProspects: p.totalProspects,
              meetings: p.meetings
            })),
          worstDataQualityProjects: projectMetrics
            .map(p => ({
              ...p,
              dataQualityScore: 0 // Placeholder - would need to calculate per project
            }))
            .sort((a, b) => a.dataQualityScore - b.dataQualityScore)
            .slice(0, 10),
          channelEfficiency: {
            linkedin: {
              acceptanceRate: linkedinTotal > 0 ? parseFloat(((linkedinAccepted / linkedinTotal) * 100).toFixed(2)) : 0,
              total: linkedinTotal,
              accepted: linkedinAccepted
            },
            call: {
              connectRate: callsTotal > 0 ? parseFloat(((callsConnected / callsTotal) * 100).toFixed(2)) : 0,
              total: callsTotal,
              connected: callsConnected
            },
            email: {
              replyRate: emailsTotal > 0 ? parseFloat(((emailsReplied / emailsTotal) * 100).toFixed(2)) : 0,
              total: emailsTotal,
              replied: emailsReplied
            }
          },
          teamLeaderboard: teamPerformance.map(member => ({
            name: member.name || member.email || 'Unknown',
            email: member.email || '',
            totalActivities: member.totalActivities,
            calls: member.calls,
            emails: member.emails,
            linkedin: member.linkedin,
            meetings: member.meetings
          }))
        },

        // Alerts
        alerts: {
          lowActivityProjects: lowActivityProjects.map(p => ({
            projectName: p.projectName || 'Unknown',
            activityCount: p.activityCount,
            totalContacts: p.totalContacts,
            activityPerContact: parseFloat(p.activityPerContact.toFixed(2))
          })),
          highBounceProjects: highBounceProjects.map(p => ({
            projectName: p.projectName || 'Unknown',
            bounceCount: p.bounceCount,
            wrongPersonCount: p.wrongPersonCount,
            errorRate: parseFloat(p.errorRate.toFixed(2))
          })),
          missingFollowUps: missingFollowUps.map(p => ({
            projectName: p.projectName || 'Unknown',
            overdueCount: p.overdueCount
          }))
        },

        // Data/Scraping
        dataQuality: {
          leadsAddedDaily,
          leadsAddedWeekly,
          validEmailPercent: parseFloat(emailQuality.toFixed(2)),
          validPhonePercent: parseFloat(phoneQuality.toFixed(2)),
          duplicatePercent: parseFloat(duplicateRate.toFixed(2)),
          dataQualityScore: parseFloat(dataQualityScore.toFixed(2)),
          totalProspects,
          validEmailCount,
          validPhoneCount,
          duplicateCount
        },

        // LinkedIn
        linkedin: {
          connectionRequestsSent,
          acceptanceRate: connectionRequestsSent > 0 ? parseFloat(((linkedinAcceptedCount / connectionRequestsSent) * 100).toFixed(2)) : 0,
          accepted: linkedinAcceptedCount,
          messagesSent,
          replies: linkedinReplies,
          replyRate: messagesSent > 0 ? parseFloat(((linkedinReplies / messagesSent) * 100).toFixed(2)) : 0,
          meetingsBooked: linkedInData.meetingsBooked || 0
        },

        // Cold Call
        coldCall: {
          callsMade: callsMadeCount,
          connectRate: callsMadeCount > 0 ? parseFloat(((callsConnectedCount / callsMadeCount) * 100).toFixed(2)) : 0,
          connected: callsConnectedCount,
          decisionMakerConnects,
          interested: interestedCount,
          meetingsBooked: callMeetingsBooked,
          callStatusBreakdown
        },

        // Email
        email: {
          emailsSent: emailsSentCount,
          bounceRate: emailsSentCount > 0 ? parseFloat(((bouncedCount / emailsSentCount) * 100).toFixed(2)) : 0,
          bounced: bouncedCount,
          replyRate: emailsSentCount > 0 ? parseFloat(((emailsRepliedCount / emailsSentCount) * 100).toFixed(2)) : 0,
          replied: emailsRepliedCount,
          positiveReplies,
          meetingsBooked: emailMeetingsBooked
        },

        // Follow-up Discipline
        followUp: {
          totalDue,
          completed: followUpsCompleted,
          overdueCount,
          completionRate: totalDue > 0 ? parseFloat(((followUpsCompleted / totalDue) * 100).toFixed(2)) : 100,
          slaCompliance: parseFloat(slaCompliance.toFixed(2)),
          chartData: followUpMetrics[0]?.byDate ? (() => {
            const byDate = followUpMetrics[0].byDate;
            const dateMap = {};
            byDate.forEach(item => {
              if (!dateMap[item.date]) {
                dateMap[item.date] = { total: 0, completed: 0, overdue: 0 };
              }
              dateMap[item.date].total++;
              if (item.hasFollowUp) dateMap[item.date].completed++;
              if (item.isOverdue && !item.hasFollowUp) dateMap[item.date].overdue++;
            });
            const sortedDates = Object.keys(dateMap).sort();
            return {
              labels: sortedDates,
              total: sortedDates.map(d => dateMap[d].total),
              completed: sortedDates.map(d => dateMap[d].completed),
              overdue: sortedDates.map(d => dateMap[d].overdue)
            };
          })() : null,
          projectData: followUpMetrics[0]?.byProject ? (() => {
            const byProject = followUpMetrics[0].byProject;
            const projectMap = {};
            byProject.forEach(item => {
              const projectName = item.projectName || 'Unknown';
              if (!projectMap[projectName]) {
                projectMap[projectName] = { total: 0, completed: 0, overdue: 0 };
              }
              projectMap[projectName].total++;
              if (item.hasFollowUp) projectMap[projectName].completed++;
              if (item.isOverdue && !item.hasFollowUp) projectMap[projectName].overdue++;
            });
            const sortedProjects = Object.keys(projectMap).sort((a, b) => projectMap[b].total - projectMap[a].total).slice(0, 10);
            return {
              labels: sortedProjects,
              total: sortedProjects.map(p => projectMap[p].total),
              completed: sortedProjects.map(p => projectMap[p].completed),
              overdue: sortedProjects.map(p => projectMap[p].overdue)
            };
          })() : null
        }
      }
    });
  } catch (error) {
    console.error('Error fetching master dashboard data:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch master dashboard data'
    });
  }
});

module.exports = router;
