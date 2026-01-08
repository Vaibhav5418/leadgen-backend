const express = require('express');
const router = express.Router();
const Category = require('../models/Category');

// Get all categories
router.get('/', async (req, res) => {
  try {
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
    
    const categories = await Category.find({ isActive: true })
      .select('name description')
      .sort({ name: 1 })
      .lean();
    
    res.json({
      success: true,
      data: categories.map(cat => cat.name)
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
