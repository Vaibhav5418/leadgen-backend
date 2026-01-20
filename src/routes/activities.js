const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Activity = require('../models/Activity');
const ProspectContact = require('../models/ProspectContact');
const Contact = require('../models/Contact');
const ProjectContact = require('../models/ProjectContact');
const authenticate = require('../middleware/auth');

// Mongoose automatically pluralizes and lowercases: 'ProspectContact' -> 'prospectcontacts'
const PROSPECT_CONTACT_COLLECTION = 'prospectcontacts';

// Create a new activity
router.post('/', authenticate, async (req, res) => {
  try {
    const {
      projectId,
      contactId,
      type,
      template,
      outcome,
      conversationNotes,
      nextAction,
      nextActionDate,
      phoneNumber,
      email,
      linkedInUrl,
      status,
      linkedInAccountName,
      lnRequestSent,
      connected,
      callNumber,
      callStatus,
      callDate,
      emailDate,
      linkedinDate
    } = req.body;

    // Validate required fields
    if (!projectId || !type) {
      return res.status(400).json({
        success: false,
        error: 'Project ID and activity type are required'
      });
    }

    // Verify user has access to this project (creator or team member)
    const user = req.user;
    const isAdmin = user.isAdmin || user.email === 'akshay@kology.co';
    if (!isAdmin) {
      const Project = require('../models/Project');
      const project = await Project.findById(projectId);
      if (!project) {
        return res.status(404).json({
          success: false,
          error: 'Project not found'
        });
      }
      const isCreator = project.createdBy.toString() === user._id.toString();
      const isTeamMember = project.teamMembers && 
        project.teamMembers.some(email => email.toLowerCase() === user.email.toLowerCase());
      if (!isCreator && !isTeamMember) {
        return res.status(403).json({
          success: false,
          error: 'Access denied to this project'
        });
      }
    }

    // Status is now optional for all activity types (Email, LinkedIn, and Call)
    // Conversation Notes is now optional - no minimum length validation

    // Next action and date are now optional
    // But if nextAction is provided, nextActionDate should also be provided
    if (nextAction && !nextActionDate) {
      return res.status(400).json({
        success: false,
        error: 'Next action date is required when next action is specified'
      });
    }

    // Validate next action date is within 7 days (if provided)
    let selectedDate = null;
    if (nextActionDate) {
      selectedDate = new Date(nextActionDate);
      const today = new Date();
      const maxDate = new Date(today);
      maxDate.setDate(maxDate.getDate() + 7);

      if (selectedDate > maxDate) {
        return res.status(400).json({
          success: false,
          error: 'Next action must be scheduled within 7 days'
        });
      }
    }

    const activity = new Activity({
      projectId,
      contactId: contactId || null,
      type,
      template: template || '',
      outcome: null, // Outcome is not used for any activity types
      conversationNotes: conversationNotes ? conversationNotes.trim() : '',
      nextAction: nextAction || null,
      nextActionDate: selectedDate || null,
      phoneNumber: phoneNumber || null,
      email: email || null,
      linkedInUrl: linkedInUrl || null,
      status: status || null,
      linkedInAccountName: linkedInAccountName || null,
      lnRequestSent: lnRequestSent || null,
      connected: connected || null,
      callNumber: callNumber || null,
      callStatus: callStatus || null,
      callDate: (callDate && callDate.trim && callDate.trim() !== '') ? new Date(callDate) : null,
      emailDate: (emailDate && emailDate.trim && emailDate.trim() !== '') ? new Date(emailDate) : null,
      linkedinDate: (linkedinDate && linkedinDate.trim && linkedinDate.trim() !== '') ? new Date(linkedinDate) : null,
      createdBy: req.user._id
    });

    await activity.save();

    // Update ProjectContact stage based on the most recent activity status
    // Create ProjectContact entry if it doesn't exist to prevent duplicates
    if (contactId && projectId) {
      try {
        // Check if ProjectContact entry exists
        const existingProjectContact = await ProjectContact.findOne({
          projectId: projectId,
          contactId: contactId
        });

        // If the current activity has a status, use it to update the stage
        if (status) {
          if (existingProjectContact) {
            // Update existing entry
            await ProjectContact.findOneAndUpdate(
              { projectId: projectId, contactId: contactId },
              { stage: status }
            );
          } else {
            // Create new ProjectContact entry
            await ProjectContact.create({
              projectId: projectId,
              contactId: contactId,
              stage: status,
              assignedTo: '',
              priority: 'Medium'
            });
          }
        } else {
          // If current activity doesn't have a status, find the most recent activity with a status
          const mostRecentActivity = await Activity.findOne({
            contactId: contactId,
            projectId: projectId,
            status: { $exists: true, $ne: null }
          })
            .sort({ createdAt: -1 })
            .lean();

          if (existingProjectContact) {
            // Update existing entry
            if (mostRecentActivity && mostRecentActivity.status) {
              await ProjectContact.findOneAndUpdate(
                { projectId: projectId, contactId: contactId },
                { stage: mostRecentActivity.status }
              );
            } else {
              // If no activity with status exists, set stage to 'New'
              await ProjectContact.findOneAndUpdate(
                { projectId: projectId, contactId: contactId },
                { stage: 'New' }
              );
            }
          } else {
            // Create new ProjectContact entry
            const stageToSet = (mostRecentActivity && mostRecentActivity.status) ? mostRecentActivity.status : 'New';
            await ProjectContact.create({
              projectId: projectId,
              contactId: contactId,
              stage: stageToSet,
              assignedTo: '',
              priority: 'Medium'
            });
          }
        }
      } catch (updateError) {
        // Log error but don't fail the activity creation
        console.error('Error updating ProjectContact stage:', updateError);
      }
    }

    console.log(`✓ Activity saved to database:`, {
      id: activity._id,
      type: activity.type,
      projectId: activity.projectId,
      outcome: activity.outcome,
      callNumber: activity.callNumber || null,
      callStatus: activity.callStatus || null,
      callDate: activity.callDate || null,
      emailDate: activity.emailDate || null,
      linkedinDate: activity.linkedinDate || null,
      createdAt: activity.createdAt
    });

    res.status(201).json({
      success: true,
      data: activity,
      message: 'Activity logged successfully'
    });
  } catch (error) {
    console.error('Error creating activity:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to log activity'
    });
  }
});

// Get all activities for a project
router.get('/project/:projectId', authenticate, async (req, res) => {
  try {
    const user = req.user;
    const isAdmin = user.isAdmin || user.email === 'akshay@kology.co';
    const Project = require('../models/Project');
    
    // Verify user has access to this project (creator or team member)
    if (!isAdmin) {
      const project = await Project.findById(req.params.projectId);
      if (!project) {
        return res.status(404).json({
          success: false,
          error: 'Project not found'
        });
      }
      const isCreator = project.createdBy.toString() === user._id.toString();
      const isTeamMember = project.teamMembers && 
        project.teamMembers.some(email => email.toLowerCase() === user.email.toLowerCase());
      if (!isCreator && !isTeamMember) {
        return res.status(403).json({
          success: false,
          error: 'Access denied to this project'
        });
      }
    }
    
    const limit = Math.min(parseInt(req.query.limit) || 1000, 5000); // Default limit to 1000, max 5000 for performance
    let activityFilter = { projectId: req.params.projectId };
    
    // For team members, show all activities in the project
    // For creators, show all activities in their projects
    // For non-team members, only show their own activities
    if (!isAdmin) {
      const project = await Project.findById(req.params.projectId).lean();
      const isTeamMember = project.teamMembers && 
        project.teamMembers.some(email => email.toLowerCase() === user.email.toLowerCase());
      const isCreator = project.createdBy.toString() === user._id.toString();
      
      // Team members and creators can see all activities in the project
      if (!isTeamMember && !isCreator) {
      activityFilter.createdBy = user._id;
      }
    }
    
    const activities = await Activity.find(activityFilter)
      .select('projectId contactId type outcome conversationNotes nextAction nextActionDate status createdAt lnRequestSent connected linkedInAccountName callNumber callStatus callDate emailDate linkedinDate')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.json({
      success: true,
      data: activities
    });
  } catch (error) {
    console.error('Error fetching activities:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch activities'
    });
  }
});

// Get all activities for a contact
router.get('/contact/:contactId', authenticate, async (req, res) => {
  try {
    const user = req.user;
    const isAdmin = user.isAdmin || user.email === 'akshay@kology.co';
    const Project = require('../models/Project');
    const contactObjectId = new mongoose.Types.ObjectId(req.params.contactId);
    const projectId = req.query.projectId; // Get projectId from query parameter (optional)
    
    // Validate projectId if provided
    let projectObjectId = null;
    if (projectId) {
      if (!mongoose.Types.ObjectId.isValid(projectId)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid project ID format'
        });
      }
      projectObjectId = new mongoose.Types.ObjectId(projectId);
      
      // Verify user has access to this project (creator or team member)
      if (!isAdmin) {
        const project = await Project.findById(projectId);
        if (!project) {
          return res.status(404).json({
            success: false,
            error: 'Project not found'
          });
        }
        const isCreator = project.createdBy.toString() === user._id.toString();
        const isTeamMember = project.teamMembers && 
          project.teamMembers.some(email => email.toLowerCase() === user.email.toLowerCase());
        if (!isCreator && !isTeamMember) {
          return res.status(403).json({
            success: false,
            error: 'Access denied to this project'
          });
        }
      }
    }
    
    // First verify the contact exists in either ProspectContact or Contact (legacy)
    const [prospectContact, legacyContact] = await Promise.all([
      ProspectContact.findById(contactObjectId).lean(),
      Contact.findById(contactObjectId).lean()
    ]);
    
    if (!prospectContact && !legacyContact) {
      return res.status(404).json({
        success: false,
        error: 'Contact not found'
      });
    }
    
    // Build match criteria - filter by contactId and optionally by projectId
    // This ensures activities are project-specific when projectId is provided
    const matchCriteria = { contactId: contactObjectId };
    if (projectObjectId) {
      matchCriteria.projectId = projectObjectId; // Only show activities for this specific project
    }
    
    // Filter by user unless admin
    if (!isAdmin) {
      matchCriteria.createdBy = user._id;
    }
    
    // Use aggregation for better performance - lookup from both ProspectContact and Contact collections
    const activities = await Activity.aggregate([
      { $match: matchCriteria },
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
      },
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
          projectId: {
            _id: '$project._id',
            companyName: '$project.companyName'
          },
          contactId: 1,
          contact: {
            $cond: {
              if: { $gt: [{ $size: '$prospectContact' }, 0] },
              then: {
                _id: { $arrayElemAt: ['$prospectContact._id', 0] },
                name: { $arrayElemAt: ['$prospectContact.name', 0] },
                email: { $arrayElemAt: ['$prospectContact.email', 0] },
                company: { $arrayElemAt: ['$prospectContact.company', 0] }
              },
              else: {
                _id: { $arrayElemAt: ['$legacyContact._id', 0] },
                name: { $arrayElemAt: ['$legacyContact.name', 0] },
                email: { $arrayElemAt: ['$legacyContact.email', 0] },
                company: { $arrayElemAt: ['$legacyContact.company', 0] }
              }
            }
          },
          type: 1,
          template: 1,
          outcome: 1,
          conversationNotes: 1,
          nextAction: 1,
          nextActionDate: 1,
          phoneNumber: 1,
          email: 1,
          linkedInUrl: 1,
          status: 1,
          linkedInAccountName: 1,
          lnRequestSent: 1,
          connected: 1,
          callNumber: 1,
          callStatus: 1,
          callDate: 1,
          emailDate: 1,
          linkedinDate: 1,
          createdBy: 1,
          createdAt: 1,
          updatedAt: 1
        }
      },
      { $sort: { createdAt: -1 } }
    ]);

    res.json({
      success: true,
      data: activities
    });
  } catch (error) {
    console.error('Error fetching contact activities:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch contact activities'
    });
  }
});

// Get team performance activity data
router.get('/team-performance', authenticate, async (req, res) => {
  try {
    const user = req.user;
    const isAdmin = user.isAdmin || user.email === 'akshay@kology.co';
    const { projectId, timeFilter } = req.query;
    const Project = require('../models/Project');
    
    // Calculate date range based on time filter
    const now = new Date();
    let startDate;
    
    switch (timeFilter) {
      case 'today':
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case 'last7days':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'lastMonth':
        startDate = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
        break;
      default:
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }
    
    // Build project filter - include projects where user is creator OR team member
    let projectFilter = {};
    if (projectId && mongoose.Types.ObjectId.isValid(projectId)) {
      if (!isAdmin) {
        const project = await Project.findOne({
          _id: projectId,
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
      projectFilter.projectId = new mongoose.Types.ObjectId(projectId);
    } else if (!isAdmin) {
      const projects = await Project.find({
        $or: [
          { createdBy: user._id },
          { teamMembers: { $in: [user.email.toLowerCase()] } }
        ]
      }).lean();
      const projectIds = projects.map(p => p._id);
      projectFilter.projectId = { $in: projectIds };
    }
    
    // Build date filter - use activity-specific dates
    const dateFilter = {
      $or: [
        { callDate: { $gte: startDate, $lte: now } },
        { emailDate: { $gte: startDate, $lte: now } },
        { linkedinDate: { $gte: startDate, $lte: now } },
        { 
          $and: [
            { callDate: { $exists: false } },
            { emailDate: { $exists: false } },
            { linkedinDate: { $exists: false } },
            { createdAt: { $gte: startDate, $lte: now } }
          ]
        }
      ]
    };
    
    // Fetch activities
    const activities = await Activity.find({
      ...projectFilter,
      ...dateFilter
    }).lean();
    
    // Process activities for chart data
    const chartLabels = [];
    const callData = [];
    const emailData = [];
    const linkedinData = [];
    
    // Group by date
    const activitiesByDate = {};
    activities.forEach(activity => {
      let activityDate;
      if (activity.type === 'call' && activity.callDate) {
        activityDate = new Date(activity.callDate).toISOString().split('T')[0];
      } else if (activity.type === 'email' && activity.emailDate) {
        activityDate = new Date(activity.emailDate).toISOString().split('T')[0];
      } else if (activity.type === 'linkedin' && activity.linkedinDate) {
        activityDate = new Date(activity.linkedinDate).toISOString().split('T')[0];
      } else {
        activityDate = new Date(activity.createdAt).toISOString().split('T')[0];
      }
      
      if (!activitiesByDate[activityDate]) {
        activitiesByDate[activityDate] = { call: 0, email: 0, linkedin: 0 };
      }
      
      if (activity.type === 'call') {
        activitiesByDate[activityDate].call++;
      } else if (activity.type === 'email') {
        activitiesByDate[activityDate].email++;
      } else if (activity.type === 'linkedin') {
        activitiesByDate[activityDate].linkedin++;
      }
    });
    
    // Sort dates and build chart data
    const sortedDates = Object.keys(activitiesByDate).sort();
    sortedDates.forEach(date => {
      const dateObj = new Date(date);
      chartLabels.push(dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
      callData.push(activitiesByDate[date].call);
      emailData.push(activitiesByDate[date].email);
      linkedinData.push(activitiesByDate[date].linkedin);
    });
    
    // Build status-based breakdown
    const callStatuses = {};
    const emailStatuses = {};
    const linkedinStatuses = {};
    
    activities.forEach(activity => {
      if (activity.type === 'call') {
        const status = activity.callStatus || 'No Status';
        callStatuses[status] = (callStatuses[status] || 0) + 1;
      } else if (activity.type === 'email') {
        const status = activity.status || 'No Status';
        emailStatuses[status] = (emailStatuses[status] || 0) + 1;
      } else if (activity.type === 'linkedin') {
        const status = activity.status || (activity.connected ? 'Connected' : 'No Status');
        linkedinStatuses[status] = (linkedinStatuses[status] || 0) + 1;
      }
    });
    
    // Build pie chart data with status breakdown
    const pieLabels = [];
    const pieData = [];
    const pieColors = [];
    const colorMap = {
      'Interested': 'rgba(34, 197, 94, 0.6)',
      'Ring': 'rgba(59, 130, 246, 0.6)',
      'Busy': 'rgba(251, 191, 36, 0.6)',
      'Call Back': 'rgba(249, 115, 22, 0.6)',
      'Hang Up': 'rgba(239, 68, 68, 0.6)',
      'Switch Off': 'rgba(107, 114, 128, 0.6)',
      'Invalid': 'rgba(156, 163, 175, 0.6)',
      'Future': 'rgba(168, 85, 247, 0.6)',
      'Details Shared': 'rgba(34, 197, 94, 0.6)',
      'Demo Booked': 'rgba(59, 130, 246, 0.6)',
      'Demo Completed': 'rgba(34, 197, 94, 0.6)',
      'Opened': 'rgba(34, 197, 94, 0.6)',
      'Replied': 'rgba(59, 130, 246, 0.6)',
      'No Reply': 'rgba(239, 68, 68, 0.6)',
      'Meeting Proposed': 'rgba(168, 85, 247, 0.6)',
      'Meeting Scheduled': 'rgba(59, 130, 246, 0.6)',
      'Meeting Completed': 'rgba(34, 197, 94, 0.6)',
      'Connected': 'rgba(34, 197, 94, 0.6)',
      'No Status': 'rgba(156, 163, 175, 0.6)'
    };
    
    // Add call statuses
    Object.entries(callStatuses).forEach(([status, count]) => {
      pieLabels.push(`Call: ${status}`);
      pieData.push(count);
      pieColors.push(colorMap[status] || 'rgba(156, 163, 175, 0.6)');
    });
    
    // Add email statuses
    Object.entries(emailStatuses).forEach(([status, count]) => {
      pieLabels.push(`Email: ${status}`);
      pieData.push(count);
      pieColors.push(colorMap[status] || 'rgba(156, 163, 175, 0.6)');
    });
    
    // Add LinkedIn statuses
    Object.entries(linkedinStatuses).forEach(([status, count]) => {
      pieLabels.push(`LinkedIn: ${status}`);
      pieData.push(count);
      pieColors.push(colorMap[status] || 'rgba(156, 163, 175, 0.6)');
    });
    
    res.json({
      success: true,
      data: {
        chartData: {
          labels: chartLabels,
          datasets: [
            {
              label: 'Calls',
              data: callData,
              backgroundColor: 'rgba(34, 197, 94, 0.6)',
              borderColor: 'rgba(34, 197, 94, 1)',
              borderWidth: 1
            },
            {
              label: 'Emails',
              data: emailData,
              backgroundColor: 'rgba(59, 130, 246, 0.6)',
              borderColor: 'rgba(59, 130, 246, 1)',
              borderWidth: 1
            },
            {
              label: 'LinkedIn',
              data: linkedinData,
              backgroundColor: 'rgba(139, 92, 246, 0.6)',
              borderColor: 'rgba(139, 92, 246, 1)',
              borderWidth: 1
            }
          ]
        },
        pieData: {
          labels: pieLabels,
          datasets: [
            {
              data: pieData,
              backgroundColor: pieColors,
              borderColor: pieColors.map(c => c.replace('0.6', '1')),
              borderWidth: 1
            }
          ]
        }
      }
    });
  } catch (error) {
    console.error('Error fetching team performance activity data:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch team performance activity data'
    });
  }
});

// Get a single activity
router.get('/:id', authenticate, async (req, res) => {
  try {
    const activity = await Activity.findById(req.params.id).lean();

    if (!activity) {
      return res.status(404).json({
        success: false,
        error: 'Activity not found'
      });
    }

    res.json({
      success: true,
      data: activity
    });
  } catch (error) {
    console.error('Error fetching activity:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch activity'
    });
  }
});

// Update an activity
router.put('/:id', authenticate, async (req, res) => {
  try {
    const {
      template,
      conversationNotes,
      nextAction,
      nextActionDate,
      phoneNumber,
      email,
      linkedInUrl,
      status,
      linkedInAccountName,
      lnRequestSent,
      connected,
      callNumber,
      callStatus,
      callDate,
      emailDate,
      linkedinDate
    } = req.body;

    const activity = await Activity.findById(req.params.id);

    if (!activity) {
      return res.status(404).json({
        success: false,
        error: 'Activity not found'
      });
    }

    // Validate next action date is within 7 days (if provided)
    let selectedDate = null;
    if (nextActionDate) {
      selectedDate = new Date(nextActionDate);
      const today = new Date();
      const maxDate = new Date(today);
      maxDate.setDate(maxDate.getDate() + 7);

      if (selectedDate > maxDate) {
        return res.status(400).json({
          success: false,
          error: 'Next action must be scheduled within 7 days'
        });
      }
    }

    // Update fields
    if (template !== undefined) activity.template = template || '';
    if (conversationNotes !== undefined) activity.conversationNotes = conversationNotes ? conversationNotes.trim() : '';
    if (nextAction !== undefined) activity.nextAction = nextAction || null;
    if (nextActionDate !== undefined) activity.nextActionDate = selectedDate || null;
    if (phoneNumber !== undefined) activity.phoneNumber = phoneNumber || null;
    if (email !== undefined) activity.email = email || null;
    if (linkedInUrl !== undefined) activity.linkedInUrl = linkedInUrl || null;
    if (status !== undefined) activity.status = status || null;
    if (linkedInAccountName !== undefined) activity.linkedInAccountName = linkedInAccountName || null;
    if (lnRequestSent !== undefined) activity.lnRequestSent = lnRequestSent || null;
    if (connected !== undefined) activity.connected = connected || null;
    if (callNumber !== undefined) activity.callNumber = callNumber || null;
    if (callStatus !== undefined) activity.callStatus = callStatus || null;
    if (callDate !== undefined) activity.callDate = (callDate && callDate.trim && callDate.trim() !== '') ? new Date(callDate) : null;
    if (emailDate !== undefined) activity.emailDate = (emailDate && emailDate.trim && emailDate.trim() !== '') ? new Date(emailDate) : null;
    if (linkedinDate !== undefined) activity.linkedinDate = (linkedinDate && linkedinDate.trim && linkedinDate.trim() !== '') ? new Date(linkedinDate) : null;

    await activity.save();

    // Update ProjectContact stage based on the most recent activity status
    // Create ProjectContact entry if it doesn't exist to prevent duplicates
    if (activity.contactId && activity.projectId) {
      try {
        // Check if ProjectContact entry exists
        const existingProjectContact = await ProjectContact.findOne({
          projectId: activity.projectId,
          contactId: activity.contactId
        });

        // If the updated activity has a status, use it to update the stage
        if (status !== undefined && status !== null) {
          if (existingProjectContact) {
            // Update existing entry
            await ProjectContact.findOneAndUpdate(
              { projectId: activity.projectId, contactId: activity.contactId },
              { stage: status }
            );
          } else {
            // Create new ProjectContact entry
            await ProjectContact.create({
              projectId: activity.projectId,
              contactId: activity.contactId,
              stage: status,
              assignedTo: '',
              priority: 'Medium'
            });
          }
        } else {
          // If status wasn't changed or was cleared, find the most recent activity with a status
          const mostRecentActivity = await Activity.findOne({
            contactId: activity.contactId,
            projectId: activity.projectId,
            status: { $exists: true, $ne: null }
          })
            .sort({ createdAt: -1 })
            .lean();

          if (existingProjectContact) {
            // Update existing entry
            if (mostRecentActivity && mostRecentActivity.status) {
              await ProjectContact.findOneAndUpdate(
                { projectId: activity.projectId, contactId: activity.contactId },
                { stage: mostRecentActivity.status }
              );
            } else {
              // If no activity with status exists, set stage to 'New'
              await ProjectContact.findOneAndUpdate(
                { projectId: activity.projectId, contactId: activity.contactId },
                { stage: 'New' }
              );
            }
          } else {
            // Create new ProjectContact entry
            const stageToSet = (mostRecentActivity && mostRecentActivity.status) ? mostRecentActivity.status : 'New';
            await ProjectContact.create({
              projectId: activity.projectId,
              contactId: activity.contactId,
              stage: stageToSet,
              assignedTo: '',
              priority: 'Medium'
            });
          }
        }
      } catch (updateError) {
        // Log error but don't fail the activity update
        console.error('Error updating ProjectContact stage:', updateError);
      }
    }

    console.log(`✓ Activity updated in database:`, {
      id: activity._id,
      type: activity.type,
      callNumber: activity.callNumber || null,
      callStatus: activity.callStatus || null,
      callDate: activity.callDate || null,
      emailDate: activity.emailDate || null,
      linkedinDate: activity.linkedinDate || null
    });

    res.json({
      success: true,
      data: activity,
      message: 'Activity updated successfully'
    });
  } catch (error) {
    console.error('Error updating activity:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update activity'
    });
  }
});

// Delete an activity
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const activity = await Activity.findById(req.params.id);

    if (!activity) {
      return res.status(404).json({
        success: false,
        error: 'Activity not found'
      });
    }

    await Activity.findByIdAndDelete(req.params.id);

    console.log(`✓ Activity deleted from database:`, {
      id: activity._id,
      type: activity.type
    });

    res.json({
      success: true,
      message: 'Activity deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting activity:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete activity'
    });
  }
});

module.exports = router;
