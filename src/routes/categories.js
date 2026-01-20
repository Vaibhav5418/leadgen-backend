const express = require('express');
const router = express.Router();
const Category = require('../models/Category');
const Project = require('../models/Project');
const authenticate = require('../middleware/auth');

// Get all categories (including projects)
router.get('/', authenticate, async (req, res) => {
  try {
    const user = req.user;
    const isAdmin = user.isAdmin || user.email === 'akshay@kology.co';
    
    // Check if any categories exist, if not, sync from contacts
    const categoryCount = await Category.countDocuments({ isActive: true });
    
    if (categoryCount === 0) {
      // Auto-sync categories from existing contacts
      try {
        const Contact = require('../models/Contact');
        const contactCategories = await Contact.distinct('category', {
          category: { $exists: true, $ne: '', $ne: null }
        });
        
        if (contactCategories.length > 0) {
          const categoryPromises = contactCategories
            .filter(cat => cat && cat.trim())
            .map(async (catName) => {
              const existing = await Category.findOne({ 
                name: { $regex: new RegExp(`^${catName.trim()}$`, 'i') }
              });
              if (!existing) {
                await Category.create({ name: catName.trim() });
              }
            });
          
          await Promise.all(categoryPromises);
        }
      } catch (syncError) {
        console.error('Error syncing categories:', syncError);
        // Continue even if sync fails
      }
    }
    
    // Get regular categories
    const categories = await Category.find({ isActive: true })
      .select('name description')
      .sort({ name: 1 })
      .lean();
    
    // Get projects (filter by user unless admin - include projects where user is creator OR team member)
    let projectFilter = {};
    if (!isAdmin) {
      projectFilter.$or = [
        { createdBy: user._id },
        { teamMembers: { $in: [user.email.toLowerCase()] } }
      ];
    }
    
    const projects = await Project.find(projectFilter)
      .select('_id companyName status')
      .sort({ createdAt: -1 })
      .lean();
    
    // Format project names with prefix to distinguish from regular categories
    const projectCategories = projects.map(project => ({
      name: `Project: ${project.companyName}`,
      projectId: project._id.toString(),
      isProject: true
    }));
    
    // Combine regular categories and project categories
    const allCategories = [
      ...categories.map(cat => ({ name: cat.name, isProject: false })),
      ...projectCategories
    ];
    
    res.json({
      success: true,
      data: allCategories.map(cat => cat.name),
      projects: projectCategories // Include project metadata for frontend
    });
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Create a new category
router.post('/', async (req, res) => {
  try {
    const { name, description } = req.body;
    
    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Category name is required'
      });
    }
    
    // Check if category already exists
    const existingCategory = await Category.findOne({ 
      name: { $regex: new RegExp(`^${name.trim()}$`, 'i') }
    });
    
    if (existingCategory) {
      // If exists but inactive, reactivate it
      if (!existingCategory.isActive) {
        existingCategory.isActive = true;
        existingCategory.description = description || existingCategory.description;
        await existingCategory.save();
        return res.json({
          success: true,
          data: {
            name: existingCategory.name,
            message: 'Category reactivated'
          }
        });
      }
      return res.status(409).json({
        success: false,
        error: 'Category already exists'
      });
    }
    
    // Create new category
    const category = await Category.create({
      name: name.trim(),
      description: description || ''
    });
    
    res.status(201).json({
      success: true,
      data: {
        name: category.name,
        message: 'Category created successfully'
      }
    });
  } catch (error) {
    console.error('Error creating category:', error);
    
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        error: 'Category already exists'
      });
    }
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get distinct categories from contacts (for migration/backward compatibility)
router.get('/from-contacts', async (req, res) => {
  try {
    const Contact = require('../models/Contact');
    const categories = await Contact.distinct('category', {
      category: { $exists: true, $ne: '', $ne: null }
    });
    
    // Sync with Category collection
    const categoryPromises = categories
      .filter(cat => cat && cat.trim())
      .map(async (catName) => {
        const existing = await Category.findOne({ 
          name: { $regex: new RegExp(`^${catName.trim()}$`, 'i') }
        });
        if (!existing) {
          await Category.create({ name: catName.trim() });
        }
      });
    
    await Promise.all(categoryPromises);
    
    res.json({
      success: true,
      data: categories.filter(cat => cat && cat.trim()).sort()
    });
  } catch (error) {
    console.error('Error syncing categories:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
