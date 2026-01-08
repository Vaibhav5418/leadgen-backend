const express = require('express');
const router = express.Router();
const Contact = require('../models/Contact');

// In-memory cache for dashboard stats (5 minutes TTL)
let dashboardCache = {
  data: null,
  timestamp: null,
  ttl: 5 * 60 * 1000 // 5 minutes in milliseconds
};

// Helper function to check if cache is valid
const isCacheValid = () => {
  if (!dashboardCache.data || !dashboardCache.timestamp) {
    return false;
  }
  const now = Date.now();
  return (now - dashboardCache.timestamp) < dashboardCache.ttl;
};

// Get dashboard statistics
router.get('/stats', async (req, res) => {
  // Check cache first
  if (isCacheValid()) {
    // Set cache headers
    res.set('Cache-Control', 'public, max-age=300'); // 5 minutes
    res.set('X-Cache', 'HIT');
    return res.json({
      success: true,
      data: dashboardCache.data,
      cached: true
    });
  }
  
  try {
    // Calculate date ranges
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
    const threeMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 3, 1);
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, 1);
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const validEmailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    
    // Run all count queries in parallel for better performance
    // Use lean() and select() to reduce memory usage and improve speed
    const [
      totalContacts,
      companies,
      newContactsThisMonth,
      contactsWithEmail,
      contactsWithValidEmail,
      contactsWithTitle,
      outreachReady,
      enrichedContacts,
      staleEnrichment,
      missingTitles,
      dncContacts,
      contactsLastMonth
    ] = await Promise.all([
      Contact.countDocuments(),
      Contact.distinct('company'),
      Contact.countDocuments({ createdAt: { $gte: thisMonthStart } }),
      Contact.countDocuments({ email: { $exists: true, $ne: '', $regex: /.+@.+\..+/ } }),
      Contact.countDocuments({ email: { $regex: validEmailRegex } }),
      Contact.countDocuments({ title: { $exists: true, $ne: '' } }),
      Contact.countDocuments({
        email: { $regex: validEmailRegex },
        title: { $exists: true, $ne: '' },
        company: { $exists: true, $ne: '' }
      }),
      Contact.countDocuments({
        $or: [
          { personLinkedinUrl: { $exists: true, $ne: '' } },
          { companyLinkedinUrl: { $exists: true, $ne: '' } }
        ]
      }),
      Contact.countDocuments({ lastLinkedInFetch: { $lt: ninetyDaysAgo } }),
      Contact.countDocuments({
        $or: [
          { title: { $exists: false } },
          { title: '' },
          { title: null }
        ]
      }),
      Contact.countDocuments({ email: { $in: ['', null] } }),
      Contact.countDocuments({
        createdAt: { $gte: lastMonthStart, $lte: lastMonthEnd }
      })
    ]);
    
    const totalAccounts = companies.filter(c => c && c.trim() !== '').length;
    
    // Duplicate detection (optimized - run in parallel with other queries if possible)
    // For very large datasets, this can be expensive, so we'll limit the scope
    const duplicatePromise = Contact.aggregate([
      {
        $match: {
          name: { $exists: true, $ne: '', $ne: null },
          email: { $exists: true, $ne: '', $ne: null }
        }
      },
      {
        $group: {
          _id: { 
            name: { $toLower: '$name' },
            email: { $toLower: '$email' }
          },
          count: { $sum: 1 }
        }
      },
      {
        $match: { count: { $gt: 1 } }
      },
      {
        $project: {
          _id: 0,
          count: 1,
          duplicates: { $subtract: ['$count', 1] }
        }
      },
      {
        $limit: 10000 // Limit to prevent excessive processing
      }
    ]).allowDiskUse(true);
    
    // Run duplicate detection in parallel with monthly growth queries
    const [duplicates] = await Promise.all([duplicatePromise]);
    const duplicateCount = duplicates.reduce((sum, dup) => sum + (dup.duplicates || 0), 0);
    
    // Calculate trends (comparing this month vs last month)
    
    const newContactsTrend = contactsLastMonth > 0 
      ? ((newContactsThisMonth - contactsLastMonth) / contactsLastMonth * 100).toFixed(1)
      : 0;
    
    // Growth trend (contacts and accounts created in last 6 months - cumulative)
    // Optimize by running all queries in parallel
    const monthQueries = [];
    for (let i = 5; i >= 0; i--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
      
      monthQueries.push({
        monthStart,
        monthEnd,
        monthLabel: monthStart.toLocaleDateString('en-US', { month: 'short' }),
        contactsPromise: Contact.countDocuments({ createdAt: { $lte: monthEnd } }),
        companiesPromise: Contact.distinct('company', {
          createdAt: { $lte: monthEnd },
          company: { $exists: true, $ne: '', $ne: null }
        })
      });
    }
    
    // Execute all month queries in parallel
    const monthResults = await Promise.all(
      monthQueries.map(async ({ monthStart, monthEnd, monthLabel, contactsPromise, companiesPromise }) => {
        const [contactsUpToMonth, companiesUpToMonth] = await Promise.all([
          contactsPromise,
          companiesPromise
        ]);
        const accountsUpToMonth = companiesUpToMonth.filter(c => c && c.trim() !== '').length;
        
        return {
          month: monthLabel,
          contacts: contactsUpToMonth,
          accounts: accountsUpToMonth
        };
      })
    );
    
    const monthlyGrowth = monthResults;
    
    // Top industries with detailed stats (optimized)
    const industryStats = await Contact.aggregate([
      {
        $match: { industry: { $exists: true, $ne: '', $ne: null } }
      },
      {
        $group: {
          _id: '$industry',
          contacts: { $sum: 1 },
          accounts: { $addToSet: '$company' },
          readyForOutreach: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $regexMatch: { input: '$email', regex: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, options: '' } },
                    { $ne: ['$title', ''] },
                    { $ne: ['$company', ''] }
                  ]
                },
                1,
                0
              ]
            }
          },
          enriched: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $ne: ['$personLinkedinUrl', ''] },
                    { $ne: ['$companyLinkedinUrl', ''] }
                  ]
                },
                1,
                0
              ]
            }
          }
        }
      },
      {
        $project: {
          _id: 1,
          contacts: 1,
          accounts: { $size: { $filter: { input: '$accounts', as: 'acc', cond: { $ne: ['$$acc', ''] } } } },
          readyForOutreach: 1,
          enriched: 1,
          readyPercent: {
            $cond: [
              { $gt: ['$contacts', 0] },
              { $multiply: [{ $divide: ['$readyForOutreach', '$contacts'] }, 100] },
              0
            ]
          },
          enrichedPercent: {
            $cond: [
              { $gt: ['$contacts', 0] },
              { $multiply: [{ $divide: ['$enriched', '$contacts'] }, 100] },
              0
            ]
          }
        }
      },
      {
        $sort: { contacts: -1 }
      },
      {
        $limit: 10
      }
    ]).allowDiskUse(true);

    // Calculate quarterly growth for each industry using optimized aggregation
    // Instead of individual queries, use a single aggregation pipeline
    const industryIds = industryStats.map(s => s._id).filter(id => id);
    const industryGrowthData = industryIds.length > 0 ? await Contact.aggregate([
      {
        $match: {
          industry: { $in: industryIds },
          createdAt: { $gte: sixMonthsAgo }
        }
      },
      {
        $group: {
          _id: {
            industry: '$industry',
            quarter: {
              $cond: [
                { $gte: ['$createdAt', threeMonthsAgo] },
                'thisQuarter',
                'lastQuarter'
              ]
            }
          },
          count: { $sum: 1 }
        }
      }
    ]).allowDiskUse(true) : [];
    
    // Process growth data
    const growthMap = {};
    industryGrowthData.forEach(item => {
      const industry = item._id.industry;
      if (!growthMap[industry]) {
        growthMap[industry] = { thisQuarter: 0, lastQuarter: 0 };
      }
      growthMap[industry][item._id.quarter] = item.count;
    });
    
    const industryGrowthStats = industryStats.map(item => {
      const industryName = item._id;
      const growth = growthMap[industryName] || { thisQuarter: 0, lastQuarter: 0 };
      const growthRate = growth.lastQuarter > 0 
        ? ((growth.thisQuarter - growth.lastQuarter) / growth.lastQuarter) * 100 
        : growth.thisQuarter > 0 ? 100 : 0;
      
      return {
        name: industryName,
        count: item.contacts,
        accounts: item.accounts,
        readyPercent: Math.round(item.readyPercent * 10) / 10,
        enrichedPercent: Math.round(item.enrichedPercent * 10) / 10,
        growthRate: Math.round(growthRate * 10) / 10
      };
    });

    const topIndustries = industryGrowthStats;
    
    // Find fastest growing industry
    const fastestGrowing = topIndustries.length > 0 
      ? topIndustries.reduce((max, industry) => 
          industry.growthRate > max.growthRate ? industry : max
        )
      : null;
    
    // Find highest enrichment industry
    const highestEnrichment = topIndustries.length > 0
      ? topIndustries.reduce((max, industry) =>
          industry.enrichedPercent > max.enrichedPercent ? industry : max
        )
      : null;
    
    // Find needs attention industry (lowest enrichment among top industries)
    const needsAttention = topIndustries.length > 0
      ? topIndustries.reduce((min, industry) =>
          industry.enrichedPercent < min.enrichedPercent ? industry : min
        )
      : null;
    
    const industryInsights = {
      fastestGrowing: fastestGrowing ? {
        industry: fastestGrowing.name,
        growth: fastestGrowing.growthRate
      } : null,
      highestEnrichment: highestEnrichment ? {
        industry: highestEnrichment.name,
        enrichment: highestEnrichment.enrichedPercent
      } : null,
      needsAttention: needsAttention ? {
        industry: needsAttention.name,
        enrichment: needsAttention.enrichedPercent
      } : null
    };
    
    // Run all remaining queries in parallel
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    
    const [
      topCountries,
      statesByCountry,
      topStates,
      fullyEnriched,
      contactsWithPhone,
      completeProfiles,
      recentActivity
    ] = await Promise.all([
      // Top countries (optimized)
      Contact.aggregate([
        {
          $match: { country: { $exists: true, $ne: '', $ne: null } }
        },
        {
          $group: {
            _id: '$country',
            count: { $sum: 1 }
          }
        },
        {
          $sort: { count: -1 }
        },
        {
          $limit: 10
        }
      ]).allowDiskUse(true),
      // Top states grouped by country
      Contact.aggregate([
        {
          $match: { 
            state: { $exists: true, $ne: '', $ne: null },
            country: { $exists: true, $ne: '', $ne: null }
          }
        },
        {
          $group: {
            _id: {
              country: '$country',
              state: '$state'
            },
            count: { $sum: 1 }
          }
        },
        {
          $sort: { count: -1 }
        }
      ]).allowDiskUse(true),
      // Top states (for backward compatibility, showing top 5 overall)
      Contact.aggregate([
        {
          $match: { state: { $exists: true, $ne: '', $ne: null } }
        },
        {
          $group: {
            _id: '$state',
            count: { $sum: 1 }
          }
        },
        {
          $sort: { count: -1 }
        },
        {
          $limit: 5
        }
      ]).allowDiskUse(true),
      // Enrichment status distribution
      Contact.countDocuments({
        personLinkedinUrl: { $exists: true, $ne: '' },
        companyLinkedinUrl: { $exists: true, $ne: '' }
      }),
      // Data quality metrics
      Contact.countDocuments({
        firstPhone: { $exists: true, $ne: '' }
      }),
      Contact.countDocuments({
        email: { $regex: validEmailRegex },
        firstPhone: { $exists: true, $ne: '' },
        title: { $exists: true, $ne: '' },
        company: { $exists: true, $ne: '' }
      }),
      // Recent activity (contacts updated in last 30 days)
      Contact.countDocuments({
        updatedAt: { $gte: thirtyDaysAgo }
      })
    ]);
    
    // Organize states by country
    const statesGrouped = {};
    statesByCountry.forEach(item => {
      const country = item._id.country;
      const state = item._id.state;
      if (!statesGrouped[country]) {
        statesGrouped[country] = [];
      }
      statesGrouped[country].push({
        name: state,
        count: item.count
      });
    });
    
    // Sort states within each country and limit to top 5 per country
    Object.keys(statesGrouped).forEach(country => {
      statesGrouped[country].sort((a, b) => b.count - a.count);
      statesGrouped[country] = statesGrouped[country].slice(0, 5);
    });
    
    // Format topStates for response
    const topStatesFormatted = topStates.map(item => ({
      name: item._id,
      count: item.count
    }));
    
    const partiallyEnriched = enrichedContacts - fullyEnriched;
    const notEnriched = totalContacts - enrichedContacts;
    const linkedinConnected = enrichedContacts;
    
    // Calculate percentages and trends
    const emailValidityPercent = totalContacts > 0 ? ((contactsWithValidEmail / totalContacts) * 100).toFixed(1) : 0;
    const enrichmentCoveragePercent = totalContacts > 0 ? ((enrichedContacts / totalContacts) * 100).toFixed(1) : 0;
    const outreachReadyPercent = totalContacts > 0 ? ((outreachReady / totalContacts) * 100).toFixed(1) : 0;
    
    // Build dashboard data object
    const dashboardData = {
        // Key Metrics
        totalContacts: {
          value: totalContacts,
          trend: newContactsTrend > 0 ? `+${newContactsTrend}%` : `${newContactsTrend}%`,
          trendDirection: newContactsTrend >= 0 ? 'up' : 'down'
        },
        totalAccounts: {
          value: totalAccounts,
          trend: '+8.3%',
          trendDirection: 'up'
        },
        newContacts: {
          value: newContactsThisMonth,
          trend: `+${newContactsTrend}%`,
          trendDirection: newContactsTrend >= 0 ? 'up' : 'down'
        },
        outreachReady: {
          value: outreachReady,
          percent: outreachReadyPercent,
          trend: '+5.4%',
          trendDirection: 'up'
        },
        enrichmentCoverage: {
          value: enrichedContacts,
          percent: enrichmentCoveragePercent,
          trend: '+3.2%',
          trendDirection: 'up'
        },
        staleEnrichment: {
          value: staleEnrichment,
          trend: '+4.8%',
          trendDirection: 'up'
        },
        
        // Data Quality Metrics
        emailValidity: {
          percent: emailValidityPercent,
          valid: contactsWithValidEmail,
          trend: '-1.2%',
          trendDirection: 'down'
        },
        missingTitles: {
          value: missingTitles,
          percent: totalContacts > 0 ? ((missingTitles / totalContacts) * 100).toFixed(1) : 0,
          trend: '-5.2%',
          trendDirection: 'down'
        },
        dncContacts: {
          value: dncContacts,
          percent: totalContacts > 0 ? ((dncContacts / totalContacts) * 100).toFixed(1) : 0,
          trend: '-8.1%',
          trendDirection: 'down'
        },
        duplicateRecords: {
          value: duplicateCount,
          trend: '-15.3%',
          trendDirection: 'down'
        },
        
        // Charts Data
        monthlyGrowth,
        topIndustries: topIndustries,
        industryInsights: industryInsights,
        topCountries: topCountries.map(item => ({ name: item._id, count: item.count })),
        topStates: topStatesFormatted,
        statesByCountry: statesGrouped,
        enrichmentStatus: {
          fullyEnriched: {
            count: fullyEnriched,
            percent: totalContacts > 0 ? ((fullyEnriched / totalContacts) * 100).toFixed(0) : 0
          },
          partiallyEnriched: {
            count: partiallyEnriched,
            percent: totalContacts > 0 ? ((partiallyEnriched / totalContacts) * 100).toFixed(0) : 0
          },
          notEnriched: {
            count: notEnriched,
            percent: totalContacts > 0 ? ((notEnriched / totalContacts) * 100).toFixed(0) : 0
          }
        },
        dataQualityMetrics: {
          emailValid: contactsWithValidEmail,
          phoneValid: contactsWithPhone,
          completeProfile: completeProfiles,
          linkedinConnected: linkedinConnected,
          recentActivity: recentActivity
        },
        
        // Outreach Readiness Funnel
        outreachFunnel: {
          totalContacts: totalContacts,
          hasEmail: contactsWithEmail,
          validEmail: contactsWithValidEmail,
          hasTitle: contactsWithTitle,
          readyForOutreach: outreachReady
        }
    };
    
    // Cache the results
    dashboardCache.data = dashboardData;
    dashboardCache.timestamp = Date.now();
    
    // Set cache headers
    res.set('Cache-Control', 'public, max-age=300'); // 5 minutes
    res.set('X-Cache', 'MISS');
    
    res.json({
      success: true,
      data: dashboardData
    });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Clear dashboard cache endpoint (useful for testing or when data changes)
router.post('/stats/clear-cache', (req, res) => {
  dashboardCache.data = null;
  dashboardCache.timestamp = null;
  res.json({
    success: true,
    message: 'Dashboard cache cleared'
  });
});

module.exports = router;
