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
    // Only update if the current activity has a status, or if we need to find the latest status
    if (contactId && projectId) {
      try {
        // If the current activity has a status, use it to update the stage
        if (status) {
          await ProjectContact.findOneAndUpdate(
            { projectId: projectId, contactId: contactId },
            { stage: status },
            { upsert: false } // Don't create if it doesn't exist
          );
        } else {
          // If current activity doesn't have a status, find the most recent activity with a status
          const mostRecentActivity = await Activity.findOne({
            contactId: contactId,
            projectId: projectId,
            status: { $exists: true, $ne: null }
          })
            .sort({ createdAt: -1 })
            .lean();

          if (mostRecentActivity && mostRecentActivity.status) {
            // Update ProjectContact stage to match the most recent activity status
            await ProjectContact.findOneAndUpdate(
              { projectId: projectId, contactId: contactId },
              { stage: mostRecentActivity.status },
              { upsert: false } // Don't create if it doesn't exist
            );
          } else {
            // If no activity with status exists, set stage to 'New'
            await ProjectContact.findOneAndUpdate(
              { projectId: projectId, contactId: contactId },
              { stage: 'New' },
              { upsert: false } // Don't create if it doesn't exist
            );
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
    const limit = parseInt(req.query.limit) || 1000; // Default limit to improve performance
    const activities = await Activity.find({ projectId: req.params.projectId })
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
    if (activity.contactId && activity.projectId) {
      try {
        // If the updated activity has a status, use it to update the stage
        if (status !== undefined && status !== null) {
          // Update to the new status
          await ProjectContact.findOneAndUpdate(
            { projectId: activity.projectId, contactId: activity.contactId },
            { stage: status },
            { upsert: false } // Don't create if it doesn't exist
          );
        } else {
          // If status wasn't changed or was cleared, find the most recent activity with a status
          const mostRecentActivity = await Activity.findOne({
            contactId: activity.contactId,
            projectId: activity.projectId,
            status: { $exists: true, $ne: null }
          })
            .sort({ createdAt: -1 })
            .lean();

          if (mostRecentActivity && mostRecentActivity.status) {
            // Update ProjectContact stage to match the most recent activity status
            await ProjectContact.findOneAndUpdate(
              { projectId: activity.projectId, contactId: activity.contactId },
              { stage: mostRecentActivity.status },
              { upsert: false } // Don't create if it doesn't exist
            );
          } else {
            // If no activity with status exists, set stage to 'New'
            await ProjectContact.findOneAndUpdate(
              { projectId: activity.projectId, contactId: activity.contactId },
              { stage: 'New' },
              { upsert: false } // Don't create if it doesn't exist
            );
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
