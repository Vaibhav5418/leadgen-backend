const express = require('express');
const router = express.Router();
const Activity = require('../models/Activity');
const authenticate = require('../middleware/auth');

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
      callNumber,
      callStatus,
      callDate
    } = req.body;

    // Validate required fields (conversationNotes is now optional)
    if (!projectId || !type || !outcome || !nextAction || !nextActionDate) {
      return res.status(400).json({
        success: false,
        error: 'All required fields must be provided'
      });
    }

    // Validate conversation notes length
    // Conversation Notes is now optional - no minimum length validation

    // Validate next action date is within 7 days
    const selectedDate = new Date(nextActionDate);
    const today = new Date();
    const maxDate = new Date(today);
    maxDate.setDate(maxDate.getDate() + 7);

    if (selectedDate > maxDate) {
      return res.status(400).json({
        success: false,
        error: 'Next action must be scheduled within 7 days'
      });
    }

    const activity = new Activity({
      projectId,
      contactId: contactId || null,
      type,
      template: template || '',
      outcome,
      conversationNotes: conversationNotes ? conversationNotes.trim() : '',
      nextAction,
      nextActionDate: selectedDate,
      phoneNumber: phoneNumber || null,
      email: email || null,
      linkedInUrl: linkedInUrl || null,
      status: status || null,
      linkedInAccountName: linkedInAccountName || null,
      callNumber: callNumber || null,
      callStatus: callStatus || null,
      callDate: callDate ? new Date(callDate) : null,
      createdBy: req.user._id
    });

    await activity.save();

    console.log(`✓ Activity saved to database:`, {
      id: activity._id,
      type: activity.type,
      projectId: activity.projectId,
      outcome: activity.outcome,
      callNumber: activity.callNumber || null,
      callStatus: activity.callStatus || null,
      callDate: activity.callDate || null,
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
      .select('projectId contactId type outcome conversationNotes nextAction nextActionDate status createdAt')
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
    const activities = await Activity.find({ contactId: req.params.contactId })
      .populate('projectId', 'companyName')
      .sort({ createdAt: -1 })
      .lean();

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

module.exports = router;
