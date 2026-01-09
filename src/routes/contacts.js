const express = require('express');
const router = express.Router();
const Contact = require('../models/Contact');
const authenticate = require('../middleware/auth');

// Helper function to check for duplicates
async function checkDuplicate(contactData) {
  const { name, email, company } = contactData;
  
  // Normalize values for comparison
  const normalizedName = name ? name.trim().toLowerCase() : '';
  const normalizedEmail = email ? email.toLowerCase().trim() : '';
  const normalizedCompany = company ? company.trim().toLowerCase() : '';
  
  // Primary check: Name + Email combination (most reliable)
  // This allows same email for different people but prevents exact duplicates
  if (normalizedName && normalizedEmail) {
    const duplicateByNameEmail = await Contact.findOne({
      name: { $regex: new RegExp(`^${normalizedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
      email: { $regex: new RegExp(`^${normalizedEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
    });
    if (duplicateByNameEmail) {
      return {
        isDuplicate: true,
        existingContact: duplicateByNameEmail,
        reason: `A contact with name "${name}" and email "${email}" already exists`
      };
    }
  }
  
  // Secondary check: Name + Company combination (for cases where email might be shared)
  // Only check if email is not provided or is empty
  if (normalizedName && normalizedCompany && !normalizedEmail) {
    const duplicateByNameCompany = await Contact.findOne({
      name: { $regex: new RegExp(`^${normalizedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
      company: { $regex: new RegExp(`^${normalizedCompany.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
    });
    if (duplicateByNameCompany) {
      return {
        isDuplicate: true,
        existingContact: duplicateByNameCompany,
        reason: `A contact with name "${name}" and company "${company}" already exists`
      };
    }
  }
  
  // Tertiary check: Exact name match (only if no email and no company)
  // This is less strict but helps catch obvious duplicates
  if (normalizedName && !normalizedEmail && !normalizedCompany) {
    const duplicateByName = await Contact.findOne({
      name: { $regex: new RegExp(`^${normalizedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
      email: { $in: ['', null] },
      company: { $in: ['', null] }
    });
    if (duplicateByName) {
      return {
        isDuplicate: true,
        existingContact: duplicateByName,
        reason: `A contact with name "${name}" already exists (no email or company provided)`
      };
    }
  }
  
  return { isDuplicate: false };
}

// Create contact
router.post('/', async (req, res) => {
  try {
    // Check for duplicates before creating
    const duplicateCheck = await checkDuplicate(req.body);
    if (duplicateCheck.isDuplicate) {
      return res.status(409).json({
        success: false,
        error: duplicateCheck.reason,
        duplicate: true
      });
    }
    
    const contact = await Contact.create(req.body);
    res.status(201).json({
      success: true,
      data: contact
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// Get all contacts
router.get('/', async (req, res) => {
  try {
    const { 
      category, 
      page = 1, 
      limit = 50, 
      search,
      filterCompany,
      filterIndustry,
      filterKeywords,
      filterCity,
      filterState,
      filterCountry,
      filterHasLinkedIn,
      filterHasEmail,
      filterHasPhone
    } = req.query;
    
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;
    
    let filter = {};
    let categoryFilter = {};
    
    if (category) {
      // Handle category matching for variations like:
      // - "IND-IT & Service" (UI) vs "IND-IT&service" (database)
      // - "Web Design & Development" (UI) vs "Web Development" or "Web Design & Devlopment" (database)
      // - "Accounting & Book keeping" (UI) vs "Accounting&Book keeping" (database)
      // Works for all categories with flexible matching
      
      // Extract key words from the category (for flexible matching)
      const getKeyWords = (cat) => {
        // Split by &, spaces, and hyphens, then filter meaningful words
        const words = cat
          .split(/[&\s-]+/)
          .map(w => w.trim())
          .filter(w => 
            w.length > 2 && 
            !['the', 'and', 'for', 'with', 'from', 'and', 'or'].includes(w.toLowerCase())
          );
        return words;
      };
      
      const queryWords = getKeyWords(category);
      
      // Build regex patterns for flexible matching
      if (category.includes('&') && queryWords.length > 0) {
        // Category has & symbol (e.g., "Web Design & Development")
        const parts = category.trim().split(/\s*&\s*/);
        const escapedParts = parts.map(part => 
          part.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        );
        
        // Pattern 1: Exact match with flexible spacing around &
        const exactPattern = escapedParts.join('\\s*&\\s*');
        
        // Pattern 2: Match if contains the first and last significant words
        // For "Web Design & Development": match "Web.*Development" (allows missing "Design &")
        // Also handle typos: "Devlopment" -> "Development", "Developement" -> "Development"
        const firstWord = queryWords[0]?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') || '';
        const lastWord = queryWords[queryWords.length - 1]?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') || '';
        const lastWordLower = queryWords[queryWords.length - 1]?.toLowerCase() || '';
        
        // Create patterns for partial matching
        const patterns = [exactPattern];
        
        if (firstWord && lastWord) {
          // Match: "Web.*Development" (allows missing middle parts)
          patterns.push(`${firstWord}.*${lastWord}`);
          // Handle typos in "Development" - check original word before escaping
          if (lastWordLower.includes('development')) {
            const escapedDevlopment = 'devlopment'.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const escapedDevelopement = 'developement'.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            patterns.push(`${firstWord}.*${escapedDevlopment}`);
            patterns.push(`${firstWord}.*${escapedDevelopement}`);
          }
        }
        
        // Combine all patterns: exact match OR partial matches
        // Filter out empty patterns and validate before creating regex
        const validPatterns = patterns.filter(p => p && p.trim().length > 0);
        
        if (validPatterns.length === 0) {
          // Fallback to exact match if no valid patterns
          const escapedCategory = category.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          categoryFilter = { 
            category: { 
              $regex: new RegExp(`^${escapedCategory}$`, 'i') 
            } 
          };
        } else {
          try {
            const regexPattern = `^(${validPatterns.join('|')})$`;
            // Test if regex is valid
            new RegExp(regexPattern, 'i');
            categoryFilter = { 
              category: { 
                $regex: new RegExp(regexPattern, 'i') 
              } 
            };
          } catch (regexError) {
            // Fallback to exact match if regex construction fails
            const escapedCategory = category.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            categoryFilter = { 
              category: { 
                $regex: new RegExp(`^${escapedCategory}$`, 'i') 
              } 
            };
          }
        }
      } else {
        // No & symbol - exact match or contains key words
        const escapedCategory = category.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        
        if (queryWords.length >= 2) {
          // If multiple words, match if contains first and last word
          const firstWord = queryWords[0]?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') || '';
          const lastWord = queryWords[queryWords.length - 1]?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') || '';
          const partialPattern = `${firstWord}.*${lastWord}`;
          
          categoryFilter = { 
            category: { 
              $regex: new RegExp(`^(${escapedCategory}|.*${partialPattern}.*)$`, 'i') 
            } 
          };
        } else {
          // Single word or simple category - exact match
          categoryFilter = { 
            category: { 
              $regex: new RegExp(`^${escapedCategory}$`, 'i') 
            } 
          };
        }
      }
    }
    
    // Combine category filter
    if (Object.keys(categoryFilter).length > 0) {
      if (Object.keys(filter).length > 0) {
        if (filter.$and) {
          filter.$and.push(categoryFilter);
        } else {
          filter = { $and: [filter, categoryFilter] };
        }
      } else {
        filter = categoryFilter;
      }
    }
    
    // Add search filter if provided
    if (search && search.trim()) {
      // Escape special regex characters in search term
      const searchTerm = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchFilter = {
        $or: [
          { name: { $regex: searchTerm, $options: 'i' } },
          { email: { $regex: searchTerm, $options: 'i' } },
          { company: { $regex: searchTerm, $options: 'i' } },
          { title: { $regex: searchTerm, $options: 'i' } },
          { firstPhone: { $regex: searchTerm, $options: 'i' } },
          { industry: { $regex: searchTerm, $options: 'i' } },
          { keywords: { $regex: searchTerm, $options: 'i' } }
        ]
      };
      
      // Combine with existing filter
      if (Object.keys(filter).length > 0) {
        filter = {
          $and: [
            filter,
            searchFilter
          ]
        };
      } else {
        filter = searchFilter;
      }
    }
    
    // Add additional filters
    if (filterIndustry && filterIndustry.trim()) {
      const industryFilter = { industry: { $regex: filterIndustry.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } };
      if (Object.keys(filter).length > 0 && filter.$and) {
        filter.$and.push(industryFilter);
      } else if (Object.keys(filter).length > 0) {
        filter = { $and: [filter, industryFilter] };
      } else {
        filter = industryFilter;
      }
    }
    
    if (filterCompany && filterCompany.trim()) {
      const companyFilter = { company: { $regex: filterCompany.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } };
      if (Object.keys(filter).length > 0 && filter.$and) {
        filter.$and.push(companyFilter);
      } else if (Object.keys(filter).length > 0) {
        filter = { $and: [filter, companyFilter] };
      } else {
        filter = companyFilter;
      }
    }
    
    if (filterKeywords && filterKeywords.trim()) {
      const keywordsFilter = { keywords: { $regex: filterKeywords.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } };
      if (Object.keys(filter).length > 0 && filter.$and) {
        filter.$and.push(keywordsFilter);
      } else if (Object.keys(filter).length > 0) {
        filter = { $and: [filter, keywordsFilter] };
      } else {
        filter = keywordsFilter;
      }
    }
    
    if (filterCity && filterCity.trim()) {
      const cityFilter = {
        $or: [
          { city: { $regex: filterCity.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
          { companyCity: { $regex: filterCity.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }
        ]
      };
      if (Object.keys(filter).length > 0 && filter.$and) {
        filter.$and.push(cityFilter);
      } else if (Object.keys(filter).length > 0) {
        filter = { $and: [filter, cityFilter] };
      } else {
        filter = cityFilter;
      }
    }
    
    if (filterState && filterState.trim()) {
      const stateFilter = {
        $or: [
          { state: { $regex: filterState.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
          { companyState: { $regex: filterState.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }
        ]
      };
      if (Object.keys(filter).length > 0 && filter.$and) {
        filter.$and.push(stateFilter);
      } else if (Object.keys(filter).length > 0) {
        filter = { $and: [filter, stateFilter] };
      } else {
        filter = stateFilter;
      }
    }
    
    if (filterCountry && filterCountry.trim()) {
      const countryFilter = {
        $or: [
          { country: { $regex: filterCountry.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
          { companyCountry: { $regex: filterCountry.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }
        ]
      };
      if (Object.keys(filter).length > 0 && filter.$and) {
        filter.$and.push(countryFilter);
      } else if (Object.keys(filter).length > 0) {
        filter = { $and: [filter, countryFilter] };
      } else {
        filter = countryFilter;
      }
    }
    
    if (filterHasLinkedIn === 'yes') {
      // Show only contacts that have at least one LinkedIn URL
      const linkedInFilter = {
        $or: [
          {
            $and: [
              { personLinkedinUrl: { $exists: true } },
              { personLinkedinUrl: { $ne: '' } },
              { personLinkedinUrl: { $ne: null } },
              { personLinkedinUrl: { $not: { $regex: '^\\s*$' } } }
            ]
          },
          {
            $and: [
              { companyLinkedinUrl: { $exists: true } },
              { companyLinkedinUrl: { $ne: '' } },
              { companyLinkedinUrl: { $ne: null } },
              { companyLinkedinUrl: { $not: { $regex: '^\\s*$' } } }
            ]
          }
        ]
      };
      if (Object.keys(filter).length > 0 && filter.$and) {
        filter.$and.push(linkedInFilter);
      } else if (Object.keys(filter).length > 0) {
        filter = { $and: [filter, linkedInFilter] };
      } else {
        filter = linkedInFilter;
      }
    } else if (filterHasLinkedIn === 'no') {
      // Show contacts that don't have any LinkedIn URL
      const noLinkedInFilter = {
        $and: [
          {
            $or: [
              { personLinkedinUrl: { $exists: false } },
              { personLinkedinUrl: null },
              { personLinkedinUrl: '' },
              { personLinkedinUrl: { $regex: '^\\s*$' } }
            ]
          },
          {
            $or: [
              { companyLinkedinUrl: { $exists: false } },
              { companyLinkedinUrl: null },
              { companyLinkedinUrl: '' },
              { companyLinkedinUrl: { $regex: '^\\s*$' } }
            ]
          }
        ]
      };
      if (Object.keys(filter).length > 0 && filter.$and) {
        filter.$and.push(noLinkedInFilter);
      } else if (Object.keys(filter).length > 0) {
        filter = { $and: [filter, noLinkedInFilter] };
      } else {
        filter = noLinkedInFilter;
      }
    }
    
    if (filterHasEmail === 'yes') {
      // Show only contacts that have a valid, non-empty email
      // Valid email format: contains @ symbol and has characters before and after @
      // Examples: abc123@co.in, test@example.com, user@domain.co.uk
      // Exclude: null, empty string, whitespace-only, single dash "-", placeholder text
      const emailFilter = {
        $and: [
          { email: { $exists: true } },
          { email: { $ne: null } },
          { email: { $ne: '' } },
          { email: { $ne: '-' } }, // Exclude single dash
          { email: { $not: { $regex: /^\s*$/ } } }, // Not just whitespace
          { email: { $not: { $regex: /^-\s*$/ } } }, // Not just dash with optional whitespace
          // Must contain @ symbol and have characters before and after
          // Pattern: at least one char before @, at least one char after @, and a dot somewhere after @
          { email: { $regex: /^[^\s@]+@[^\s@]+\.[^\s@]+/ } },
          // Exclude common placeholder text (case insensitive)
          { email: { $not: { $regex: /^(no\s*email|n\/a|na|none|not\s*available|no\s*data|-)$/i } } }
        ]
      };
      
      if (Object.keys(filter).length > 0) {
        if (filter.$and) {
          // Add email filter conditions to existing $and array
          filter.$and.push(...emailFilter.$and);
        } else {
          // Create new $and array with existing filter and email filter
          filter = { $and: [filter, ...emailFilter.$and] };
        }
      } else {
        // No existing filter, use email filter directly
        filter = emailFilter;
      }
    } else if (filterHasEmail === 'no') {
      // Show contacts that don't have a valid email
      // This includes: missing, null, empty string, whitespace-only, single dash, invalid format, or placeholder text
      const noEmailFilter = {
        $or: [
          { email: { $exists: false } },
          { email: null },
          { email: '' },
          { email: '-' }, // Single dash
          { email: { $regex: /^\s*$/ } }, // Just whitespace
          { email: { $regex: /^-\s*$/ } }, // Just dash with optional whitespace
          // Invalid email format (no @ or doesn't match valid pattern)
          { email: { $not: { $regex: /^[^\s@]+@[^\s@]+\.[^\s@]+/ } } },
          // Placeholder text (case insensitive)
          { email: { $regex: /^(no\s*email|n\/a|na|none|not\s*available|no\s*data|-)$/i } }
        ]
      };
      if (Object.keys(filter).length > 0) {
        if (filter.$and) {
          filter.$and.push(noEmailFilter);
        } else {
          filter = { $and: [filter, noEmailFilter] };
        }
      } else {
        filter = noEmailFilter;
      }
    }
    
    if (filterHasPhone === 'yes') {
      // Show only contacts that have a valid, non-empty phone number
      const phoneConditions = [
        { firstPhone: { $exists: true } },
        { firstPhone: { $ne: null } },
        { firstPhone: { $ne: '' } },
        { firstPhone: { $not: { $regex: /^\s*$/ } } } // Not just whitespace
      ];
      if (Object.keys(filter).length > 0) {
        if (filter.$and) {
          filter.$and = filter.$and.concat(phoneConditions);
        } else {
          filter = { $and: [filter, ...phoneConditions] };
        }
      } else {
        filter = { $and: phoneConditions };
      }
    } else if (filterHasPhone === 'no') {
      // Show contacts that don't have a valid phone number
      const noPhoneFilter = {
        $or: [
          { firstPhone: { $exists: false } },
          { firstPhone: null },
          { firstPhone: '' },
          { firstPhone: { $regex: /^\s*$/ } } // Just whitespace
        ]
      };
      if (Object.keys(filter).length > 0) {
        if (filter.$and) {
          filter.$and.push(noPhoneFilter);
        } else {
          filter = { $and: [filter, noPhoneFilter] };
        }
      } else {
        filter = noPhoneFilter;
      }
    }
    
    // Run count and find queries in parallel for better performance
    const [totalCount, contacts] = await Promise.all([
      Contact.countDocuments(filter),
      Contact.find(filter)
        .select('name title company email firstPhone category industry keywords city state country companyCity companyState companyCountry personLinkedinUrl companyLinkedinUrl website')
      .sort({ name: 1 })
      .skip(skip)
        .limit(limitNum)
        .lean() // Use lean() for faster queries (returns plain JS objects)
    ]);
    
    res.json({
      success: true,
      count: contacts.length,
      total: totalCount,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(totalCount / limitNum),
      data: contacts
    });
  } catch (error) {
    console.error('=== API Error ===');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    console.error('================');
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Get all unique categories
router.get('/categories', async (req, res) => {
  try {
    // Use distinct with a filter to exclude empty categories
    const categories = await Contact.distinct('category', { 
      category: { $exists: true, $ne: '', $ne: null } 
    });
    const filteredCategories = categories
      .filter(cat => cat && cat.trim() !== '')
      .sort();
    res.json({
      success: true,
      data: filteredCategories
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get all unique companies with contact counts
router.get('/companies', async (req, res) => {
  try {
    const { 
      category,
      search,
      filterKeywords,
      filterCity,
      filterState,
      filterCountry,
      filterHasLinkedIn,
      filterHasEmail,
      filterHasPhone
    } = req.query;
    
    // Build filter for category if provided
    let filter = { 
      company: { $exists: true, $ne: '', $ne: null } 
    };
    
    if (category && category !== 'All') {
      // Use the same category matching logic as the main contacts route
      const getKeyWords = (cat) => {
        const words = cat
          .split(/[&\s-]+/)
          .map(w => w.trim())
          .filter(w => 
            w.length > 2 && 
            !['the', 'and', 'for', 'with', 'from', 'and', 'or'].includes(w.toLowerCase())
          );
        return words;
      };
      
      const queryWords = getKeyWords(category);
      
      if (category.includes('&') && queryWords.length > 0) {
        const parts = category.trim().split(/\s*&\s*/);
        const escapedParts = parts.map(part => 
          part.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        );
        const exactPattern = escapedParts.join('\\s*&\\s*');
        const firstWord = queryWords[0]?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') || '';
        const lastWord = queryWords[queryWords.length - 1]?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') || '';
        
        const patterns = [exactPattern];
        if (firstWord && lastWord) {
          patterns.push(`${firstWord}.*${lastWord}`);
        }
        
        const validPatterns = patterns.filter(p => p && p.trim().length > 0);
        if (validPatterns.length > 0) {
          try {
            const regexPattern = `^(${validPatterns.join('|')})$`;
            new RegExp(regexPattern, 'i');
            filter.category = { $regex: new RegExp(regexPattern, 'i') };
          } catch (regexError) {
            const escapedCategory = category.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            filter.category = { $regex: new RegExp(`^${escapedCategory}$`, 'i') };
          }
        } else {
          const escapedCategory = category.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          filter.category = { $regex: new RegExp(`^${escapedCategory}$`, 'i') };
        }
      } else {
        const escapedCategory = category.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.category = { $regex: new RegExp(`^${escapedCategory}$`, 'i') };
      }
    }
    
    // Add search filter if provided
    if (search && search.trim()) {
      const searchTerm = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchFilter = {
        $or: [
          { name: { $regex: searchTerm, $options: 'i' } },
          { email: { $regex: searchTerm, $options: 'i' } },
          { company: { $regex: searchTerm, $options: 'i' } },
          { title: { $regex: searchTerm, $options: 'i' } }
        ]
      };
      
      if (Object.keys(filter).length > 0) {
        filter = { $and: [filter, searchFilter] };
      } else {
        filter = searchFilter;
      }
    }
    
    // Add additional filters (same logic as main contacts route)
    if (filterKeywords && filterKeywords.trim()) {
      const keywordsFilter = { keywords: { $regex: filterKeywords.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } };
      if (Object.keys(filter).length > 0 && filter.$and) {
        filter.$and.push(keywordsFilter);
      } else if (Object.keys(filter).length > 0) {
        filter = { $and: [filter, keywordsFilter] };
      } else {
        filter = keywordsFilter;
      }
    }
    
    if (filterCity && filterCity.trim()) {
      const cityFilter = {
        $or: [
          { city: { $regex: filterCity.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
          { companyCity: { $regex: filterCity.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }
        ]
      };
      if (Object.keys(filter).length > 0 && filter.$and) {
        filter.$and.push(cityFilter);
      } else if (Object.keys(filter).length > 0) {
        filter = { $and: [filter, cityFilter] };
      } else {
        filter = cityFilter;
      }
    }
    
    if (filterState && filterState.trim()) {
      const stateFilter = {
        $or: [
          { state: { $regex: filterState.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
          { companyState: { $regex: filterState.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }
        ]
      };
      if (Object.keys(filter).length > 0 && filter.$and) {
        filter.$and.push(stateFilter);
      } else if (Object.keys(filter).length > 0) {
        filter = { $and: [filter, stateFilter] };
      } else {
        filter = stateFilter;
      }
    }
    
    if (filterCountry && filterCountry.trim()) {
      const countryFilter = {
        $or: [
          { country: { $regex: filterCountry.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
          { companyCountry: { $regex: filterCountry.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }
        ]
      };
      if (Object.keys(filter).length > 0 && filter.$and) {
        filter.$and.push(countryFilter);
      } else if (Object.keys(filter).length > 0) {
        filter = { $and: [filter, countryFilter] };
      } else {
        filter = countryFilter;
      }
    }
    
    if (filterHasLinkedIn === 'yes') {
      const linkedInFilter = {
        $or: [
          {
            $and: [
              { personLinkedinUrl: { $exists: true } },
              { personLinkedinUrl: { $ne: '' } },
              { personLinkedinUrl: { $ne: null } },
              { personLinkedinUrl: { $not: { $regex: '^\\s*$' } } }
            ]
          },
          {
            $and: [
              { companyLinkedinUrl: { $exists: true } },
              { companyLinkedinUrl: { $ne: '' } },
              { companyLinkedinUrl: { $ne: null } },
              { companyLinkedinUrl: { $not: { $regex: '^\\s*$' } } }
            ]
          }
        ]
      };
      if (Object.keys(filter).length > 0 && filter.$and) {
        filter.$and.push(linkedInFilter);
      } else if (Object.keys(filter).length > 0) {
        filter = { $and: [filter, linkedInFilter] };
      } else {
        filter = linkedInFilter;
      }
    } else if (filterHasLinkedIn === 'no') {
      const noLinkedInFilter = {
        $and: [
          {
            $or: [
              { personLinkedinUrl: { $exists: false } },
              { personLinkedinUrl: null },
              { personLinkedinUrl: '' },
              { personLinkedinUrl: { $regex: '^\\s*$' } }
            ]
          },
          {
            $or: [
              { companyLinkedinUrl: { $exists: false } },
              { companyLinkedinUrl: null },
              { companyLinkedinUrl: '' },
              { companyLinkedinUrl: { $regex: '^\\s*$' } }
            ]
          }
        ]
      };
      if (Object.keys(filter).length > 0 && filter.$and) {
        filter.$and.push(noLinkedInFilter);
      } else if (Object.keys(filter).length > 0) {
        filter = { $and: [filter, noLinkedInFilter] };
      } else {
        filter = noLinkedInFilter;
      }
    }
    
    if (filterHasEmail === 'yes') {
      const validEmailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const emailFilter = {
        $and: [
          { email: { $exists: true } },
          { email: { $ne: null } },
          { email: { $ne: '' } },
          { email: { $ne: '-' } },
          { email: { $not: { $regex: /^\s*$/ } } },
          { email: { $regex: validEmailRegex } },
          { email: { $not: { $regex: /^(no\s*email|n\/a|na|none|not\s*available|no\s*data|-)$/i } } }
        ]
      };
      if (Object.keys(filter).length > 0) {
        if (filter.$and) {
          filter.$and.push(...emailFilter.$and);
        } else {
          filter = { $and: [filter, ...emailFilter.$and] };
        }
      } else {
        filter = emailFilter;
      }
    } else if (filterHasEmail === 'no') {
      const noEmailFilter = {
        $or: [
          { email: { $exists: false } },
          { email: null },
          { email: '' },
          { email: '-' },
          { email: { $regex: /^\s*$/ } },
          { email: { $not: { $regex: /^[^\s@]+@[^\s@]+\.[^\s@]+/ } } },
          { email: { $regex: /^(no\s*email|n\/a|na|none|not\s*available|no\s*data|-)$/i } }
        ]
      };
      if (Object.keys(filter).length > 0) {
        if (filter.$and) {
          filter.$and.push(noEmailFilter);
        } else {
          filter = { $and: [filter, noEmailFilter] };
        }
      } else {
        filter = noEmailFilter;
      }
    }
    
    if (filterHasPhone === 'yes') {
      const phoneConditions = [
        { firstPhone: { $exists: true } },
        { firstPhone: { $ne: null } },
        { firstPhone: { $ne: '' } },
        { firstPhone: { $not: { $regex: /^\s*$/ } } }
      ];
      if (Object.keys(filter).length > 0) {
        if (filter.$and) {
          filter.$and = filter.$and.concat(phoneConditions);
        } else {
          filter = { $and: [filter, ...phoneConditions] };
        }
      } else {
        filter = { $and: phoneConditions };
      }
    } else if (filterHasPhone === 'no') {
      const noPhoneFilter = {
        $or: [
          { firstPhone: { $exists: false } },
          { firstPhone: null },
          { firstPhone: '' },
          { firstPhone: { $regex: /^\s*$/ } }
        ]
      };
      if (Object.keys(filter).length > 0) {
        if (filter.$and) {
          filter.$and.push(noPhoneFilter);
        } else {
          filter = { $and: [filter, noPhoneFilter] };
        }
      } else {
        filter = noPhoneFilter;
      }
    }
    
    // Aggregate to get companies with contact counts (optimized)
    const companiesWithCounts = await Contact.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$company',
          count: { $sum: 1 }
        }
      },
      {
        $match: {
          _id: { $exists: true, $ne: null, $ne: '' }
        }
      },
      {
        $project: {
          name: { $trim: { input: '$_id' } },
          count: 1,
          _id: 0
        }
      },
      {
        $match: {
          name: { $ne: '' }
        }
      },
      { $sort: { name: 1 } }
    ]);
    
    // Format results
    const uniqueCompanies = companiesWithCounts.map(item => ({
      name: item.name,
      count: item.count
    }));
    
    res.json({
      success: true,
      data: uniqueCompanies
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get single contact by ID
router.get('/:id', async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.id);
    if (!contact) {
      return res.status(404).json({ 
        success: false,
        error: 'Contact not found' 
      });
    }
    res.json({
      success: true,
      data: contact
    });
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Update contact
router.put('/:id', authenticate, async (req, res) => {
  try {
    const contact = await Contact.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!contact) {
      return res.status(404).json({
        success: false,
        error: 'Contact not found'
      });
    }
    res.json({
      success: true,
      data: contact
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// Delete a contact
router.delete('/:id', async (req, res) => {
  try {
    const contact = await Contact.findByIdAndDelete(req.params.id);
    if (!contact) {
      return res.status(404).json({ 
        success: false,
        error: 'Contact not found' 
      });
    }
    res.json({ 
      success: true,
      message: 'Contact deleted successfully' 
    });
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

module.exports = router;
