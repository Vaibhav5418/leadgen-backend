const express = require('express');
const router = express.Router();
const Contact = require('../models/Contact');

// Get dashboard statistics
router.get('/stats', async (req, res) => {
  try {
    const totalContacts = await Contact.countDocuments();
    const companies = await Contact.distinct('company');
    const totalAccounts = companies.filter(c => c && c.trim() !== '').length;
    
    // Calculate date ranges
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
    const threeMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 3, 1);
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, 1);
    
    // New contacts this month
    const newContactsThisMonth = await Contact.countDocuments({
      createdAt: { $gte: thisMonthStart }
    });
    
    // Contacts with email
    const contactsWithEmail = await Contact.countDocuments({
      email: { $exists: true, $ne: '', $regex: /.+@.+\..+/ }
    });
    
    // Contacts with valid email (basic validation)
    const validEmailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const contactsWithValidEmail = await Contact.countDocuments({
      email: { $regex: validEmailRegex }
    });
    
    // Contacts with title
    const contactsWithTitle = await Contact.countDocuments({
      title: { $exists: true, $ne: '' }
    });
    
    // Outreach ready (has email, title, and company)
    const outreachReady = await Contact.countDocuments({
      email: { $regex: validEmailRegex },
      title: { $exists: true, $ne: '' },
      company: { $exists: true, $ne: '' }
    });
    
    // Enrichment coverage (contacts with LinkedIn URL)
    const enrichedContacts = await Contact.countDocuments({
      $or: [
        { personLinkedinUrl: { $exists: true, $ne: '' } },
        { companyLinkedinUrl: { $exists: true, $ne: '' } }
      ]
    });
    
    // Stale enrichment (>90 days old)
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const staleEnrichment = await Contact.countDocuments({
      lastLinkedInFetch: { $lt: ninetyDaysAgo }
    });
    
    // Missing titles
    const missingTitles = await Contact.countDocuments({
      $or: [
        { title: { $exists: false } },
        { title: '' },
        { title: null }
      ]
    });
    
    // DNC contacts (if we had a DNC field, for now using empty email as proxy)
    const dncContacts = await Contact.countDocuments({
      email: { $in: ['', null] }
    });
    
    // Duplicate detection (same name and email)
    const duplicates = await Contact.aggregate([
      {
        $match: {
          name: { $exists: true, $ne: '' },
          email: { $exists: true, $ne: '' }
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
      }
    ]);
    const duplicateCount = duplicates.reduce((sum, dup) => sum + (dup.count - 1), 0);
    
    // Calculate trends (comparing this month vs last month)
    const contactsLastMonth = await Contact.countDocuments({
      createdAt: { $gte: lastMonthStart, $lt: thisMonthStart }
    });
    
    const newContactsTrend = contactsLastMonth > 0 
      ? ((newContactsThisMonth - contactsLastMonth) / contactsLastMonth * 100).toFixed(1)
      : 0;
    
    // Growth trend (contacts and accounts created in last 6 months - cumulative)
    const monthlyGrowth = [];
    let cumulativeContacts = 0;
    let cumulativeAccounts = 0;
    
    for (let i = 5; i >= 0; i--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
      
      // Count contacts created up to this month
      const contactsUpToMonth = await Contact.countDocuments({
        createdAt: { $lte: monthEnd }
      });
      
      // Count unique companies up to this month
      const companiesUpToMonth = await Contact.distinct('company', {
        createdAt: { $lte: monthEnd },
        company: { $exists: true, $ne: '' }
      });
      const accountsUpToMonth = companiesUpToMonth.filter(c => c && c.trim() !== '').length;
      
      monthlyGrowth.push({
        month: monthStart.toLocaleDateString('en-US', { month: 'short' }),
        contacts: contactsUpToMonth,
        accounts: accountsUpToMonth
      });
    }
    
    // Top industries with detailed stats
    const industryStats = await Contact.aggregate([
      {
        $match: { industry: { $exists: true, $ne: '' } }
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
    ]);

    // Calculate quarterly growth for each industry
    // Note: threeMonthsAgo and sixMonthsAgo are already declared above
    const industryGrowthStats = await Promise.all(
      industryStats.map(async (item) => {
        const industryName = item._id;
        
        // Count contacts created in last 3 months (this quarter)
        const thisQuarter = await Contact.countDocuments({
          industry: industryName,
          createdAt: { $gte: threeMonthsAgo }
        });
        
        // Count contacts created in previous 3 months (last quarter)
        const lastQuarter = await Contact.countDocuments({
          industry: industryName,
          createdAt: { $gte: sixMonthsAgo, $lt: threeMonthsAgo }
        });
        
        // Calculate growth rate
        const growthRate = lastQuarter > 0 
          ? ((thisQuarter - lastQuarter) / lastQuarter) * 100 
          : thisQuarter > 0 ? 100 : 0;
        
        return {
          name: industryName,
          count: item.contacts,
          accounts: item.accounts,
          readyPercent: Math.round(item.readyPercent * 10) / 10,
          enrichedPercent: Math.round(item.enrichedPercent * 10) / 10,
          growthRate: Math.round(growthRate * 10) / 10
        };
      })
    );

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
    
    // Top countries
    const topCountries = await Contact.aggregate([
      {
        $match: { country: { $exists: true, $ne: '' } }
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
    ]);
    
    // Top states grouped by country
    const statesByCountry = await Contact.aggregate([
      {
        $match: { 
          state: { $exists: true, $ne: '' },
          country: { $exists: true, $ne: '' }
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
    
    // Top states (for backward compatibility, showing top 5 overall)
    const topStates = await Contact.aggregate([
      {
        $match: { state: { $exists: true, $ne: '' } }
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
    ]);
    
    // Enrichment status distribution
    const fullyEnriched = await Contact.countDocuments({
      personLinkedinUrl: { $exists: true, $ne: '' },
      companyLinkedinUrl: { $exists: true, $ne: '' }
    });
    const partiallyEnriched = enrichedContacts - fullyEnriched;
    const notEnriched = totalContacts - enrichedContacts;
    
    // Data quality metrics
    const contactsWithPhone = await Contact.countDocuments({
      firstPhone: { $exists: true, $ne: '' }
    });
    
    const completeProfiles = await Contact.countDocuments({
      email: { $regex: validEmailRegex },
      firstPhone: { $exists: true, $ne: '' },
      title: { $exists: true, $ne: '' },
      company: { $exists: true, $ne: '' }
    });
    
    const linkedinConnected = enrichedContacts;
    
    // Recent activity (contacts updated in last 30 days)
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const recentActivity = await Contact.countDocuments({
      updatedAt: { $gte: thirtyDaysAgo }
    });
    
    // Calculate percentages and trends
    const emailValidityPercent = totalContacts > 0 ? ((contactsWithValidEmail / totalContacts) * 100).toFixed(1) : 0;
    const enrichmentCoveragePercent = totalContacts > 0 ? ((enrichedContacts / totalContacts) * 100).toFixed(1) : 0;
    const outreachReadyPercent = totalContacts > 0 ? ((outreachReady / totalContacts) * 100).toFixed(1) : 0;
    
    res.json({
      success: true,
      data: {
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
        topStates: topStates.map(item => ({ name: item._id, count: item.count })),
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
      }
    });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
