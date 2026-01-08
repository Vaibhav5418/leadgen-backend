const express = require('express');
const router = express.Router();
const Activity = require('../models/Activity');
const authenticate = require('../middleware/auth');

// Create a new activity
router.post('/', authenticate, async (req, res) => {
  try {
    const {
      projectId,
      type,
      template,
      outcome,
      conversationNotes,
      nextAction,
      nextActionDate
    } = req.body;

    // Validate required fields
    if (!projectId || !type || !outcome || !conversationNotes || !nextAction || !nextActionDate) {
      return res.status(400).json({
        success: false,
        error: 'All required fields must be provided'
      });
    }

    // Validate conversation notes length
    if (conversationNotes.trim().length < 50) {
      return res.status(400).json({
        success: false,
        error: 'Conversation notes must be at least 50 characters'
      });
    }

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
      type,
      template: template || '',
      outcome,
      conversationNotes: conversationNotes.trim(),
      nextAction,
      nextActionDate: selectedDate,
      createdBy: req.user._id
    });

    await activity.save();

    console.log(`✓ Activity saved to database:`, {
      id: activity._id,
      type: activity.type,
      projectId: activity.projectId,
      outcome: activity.outcome,
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
    const activities = await Activity.find({ projectId: req.params.projectId })
      .sort({ createdAt: -1 })
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
