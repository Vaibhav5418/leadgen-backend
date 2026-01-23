const Groq = require('groq-sdk');
const ProspectContact = require('../models/ProspectContact');
const Contact = require('../models/Contact');
const Activity = require('../models/Activity');
const Project = require('../models/Project');

// Initialize Groq client
let groq = null;

function getGroqClient() {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('Groq API key is not configured');
  }
  
  if (!groq) {
    groq = new Groq({
      apiKey: process.env.GROQ_API_KEY
    });
  }
  
  return groq;
}

/**
 * Gather all relevant data for personalization
 */
async function gatherContactData(contactId, projectId) {
  try {
    // Try ProspectContact first, then Contact
    let contact = await ProspectContact.findById(contactId).lean();
    if (!contact) {
      contact = await Contact.findById(contactId).lean();
    }

    if (!contact) {
      throw new Error('Contact not found');
    }

    // Get project data if projectId is provided
    let project = null;
    if (projectId) {
      project = await Project.findById(projectId).lean();
    }

    // Get previous activities for this contact
    let previousActivities = [];
    if (contactId && projectId) {
      previousActivities = await Activity.find({
        contactId: contactId,
        projectId: projectId,
        type: { $in: ['email', 'call', 'linkedin'] }
      })
        .sort({ createdAt: -1 })
        .limit(5)
        .lean();
    }

    return {
      contact,
      project,
      previousActivities
    };
  } catch (error) {
    throw new Error(`Failed to gather contact data: ${error.message}`);
  }
}

/**
 * Build context prompt for email generation
 */
function buildEmailPrompt(contactData, baseTemplate = null) {
  const { contact, project, previousActivities } = contactData;

  // Extract contact information
  const contactInfo = {
    name: contact.name || 'there',
    title: contact.title || '',
    company: contact.company || '',
    industry: contact.industry || '',
    location: contact.city || contact.state || contact.country || '',
    keywords: contact.keywords || '',
    website: contact.website || '',
    linkedInUrl: contact.personLinkedinUrl || contact.companyLinkedinUrl || '',
    email: contact.email || '',
    technologies: contact.technologies || '',
    seoDescription: contact.seoDescription || '',
    employees: contact.employees || '',
    annualRevenue: contact.annualRevenue || ''
  };

  // Extract project information
  let projectInfo = '';
  if (project) {
    projectInfo = `
Project Context:
- Company: ${project.companyName || ''}
- Industry: ${project.industry || ''}
- Services Offered: ${project.campaignDetails?.servicesOffered ? Object.keys(project.campaignDetails.servicesOffered).filter(k => project.campaignDetails.servicesOffered[k]).join(', ') : ''}
- Expectations: ${project.campaignDetails?.expectationsFromUs || ''}
`;
  }

  // Extract previous activity context
  let activityContext = '';
  if (previousActivities && previousActivities.length > 0) {
    const recentActivity = previousActivities[0];
    activityContext = `
Previous Interaction Context:
- Last Activity Type: ${recentActivity.type || 'N/A'}
- Last Status: ${recentActivity.status || 'N/A'}
- Last Conversation Notes: ${recentActivity.conversationNotes || 'N/A'}
- Last Template Used: ${recentActivity.template || 'N/A'}
`;
  }

  // Build the prompt
  const prompt = `
You are an expert B2B sales email writer. Generate a personalized, professional cold email based on the following information:

CONTACT INFORMATION:
- Name: ${contactInfo.name}
- Title: ${contactInfo.title}
- Company: ${contactInfo.company}
- Industry: ${contactInfo.industry}
- Location: ${contactInfo.location}
- Keywords: ${contactInfo.keywords}
- Company Website: ${contactInfo.website}
- LinkedIn URL: ${contactInfo.linkedInUrl}
- Technologies Used: ${contactInfo.technologies}
- Company Description: ${contactInfo.seoDescription}
- Company Size: ${contactInfo.employees}
- Annual Revenue: ${contactInfo.annualRevenue}

${projectInfo}

${activityContext}

${baseTemplate ? `BASE TEMPLATE TO FOLLOW:\n${baseTemplate}\n\n` : ''}

REQUIREMENTS:
1. Write a professional, personalized cold email
2. Use the contact's name naturally in the greeting
3. Reference their company, industry, or role to show you've done research
4. Keep it concise (3-4 short paragraphs maximum)
5. Include a clear value proposition relevant to their industry/role
6. End with a soft call-to-action (not pushy)
7. Use a professional but friendly tone
8. Personalize based on available information (location, industry, technologies, etc.)
9. If previous activity context exists, acknowledge it naturally
10. Do NOT use placeholder text like {{Name}} - use the actual name

OUTPUT FORMAT:
Return ONLY the email body text (no subject line, no metadata). Start directly with the greeting (e.g., "Hi [Name]," or "Hello [Name],").`;

  return prompt;
}

/**
 * Generate personalized email using AI
 */
async function generatePersonalizedEmail(contactId, projectId, baseTemplate = null) {
  try {
    if (!process.env.GROQ_API_KEY) {
      throw new Error('Groq API key is not configured');
    }

    // Gather all contact data
    const contactData = await gatherContactData(contactId, projectId);

    // Build the prompt
    const prompt = buildEmailPrompt(contactData, baseTemplate);

    // Get Groq client
    const groqClient = getGroqClient();

    // Call Groq API
    const modelCandidates = [
      'llama-3.3-70b-versatile',
      'llama-3.2-11b-text-preview'
    ];

    let completion;
    let lastErr;
    for (const model of modelCandidates) {
      try {
        completion = await groqClient.chat.completions.create({
          model,
          messages: [
            {
              role: 'system',
              content: 'You are an expert B2B sales email writer. You create personalized, professional cold emails that are concise, relevant, and effective. You always use actual contact information and never use placeholders.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          max_tokens: 1000,
          temperature: 0.7
        });
        lastErr = null;
        break;
      } catch (modelErr) {
        lastErr = modelErr;
        if (!(modelErr?.message?.includes('model') || modelErr?.code === 'model_decommissioned')) {
          break;
        }
      }
    }

    if (!completion && lastErr) {
      throw lastErr;
    }

    const emailContent = completion.choices[0].message.content.trim();

    return {
      success: true,
      emailContent,
      contactInfo: {
        name: contactData.contact.name,
        company: contactData.contact.company,
        email: contactData.contact.email
      }
    };
  } catch (error) {
    console.error('Error generating personalized email:', error);
    throw error;
  }
}

/**
 * Build context prompt for LinkedIn message generation
 */
function buildLinkedInPrompt(contactData, baseTemplate = null) {
  const { contact, project, previousActivities } = contactData;

  // Extract contact information
  const contactInfo = {
    name: contact.name || 'there',
    title: contact.title || '',
    company: contact.company || '',
    industry: contact.industry || '',
    location: contact.city || contact.state || contact.country || '',
    keywords: contact.keywords || '',
    website: contact.website || '',
    linkedInUrl: contact.personLinkedinUrl || contact.companyLinkedinUrl || '',
    email: contact.email || '',
    technologies: contact.technologies || '',
    seoDescription: contact.seoDescription || '',
    employees: contact.employees || '',
    annualRevenue: contact.annualRevenue || ''
  };

  // Extract project information
  let projectInfo = '';
  if (project) {
    projectInfo = `
Project Context:
- Company: ${project.companyName || ''}
- Industry: ${project.industry || ''}
- Services Offered: ${project.campaignDetails?.servicesOffered ? Object.keys(project.campaignDetails.servicesOffered).filter(k => project.campaignDetails.servicesOffered[k]).join(', ') : ''}
- Expectations: ${project.campaignDetails?.expectationsFromUs || ''}
`;
  }

  // Extract previous activity context
  let activityContext = '';
  if (previousActivities && previousActivities.length > 0) {
    const recentActivity = previousActivities[0];
    activityContext = `
Previous Interaction Context:
- Last Activity Type: ${recentActivity.type || 'N/A'}
- Last Status: ${recentActivity.status || 'N/A'}
- Last Conversation Notes: ${recentActivity.conversationNotes || 'N/A'}
- Last Template Used: ${recentActivity.template || 'N/A'}
- Connection Status: ${recentActivity.connected || 'N/A'}
`;
  }

  // Build the prompt
  const prompt = `
You are an expert B2B LinkedIn outreach specialist. Generate a SHORT, personalized LinkedIn message based on the following information:

CONTACT INFORMATION:
- Name: ${contactInfo.name}
- Title: ${contactInfo.title}
- Company: ${contactInfo.company}
- Industry: ${contactInfo.industry}
- Location: ${contactInfo.location}
- Keywords: ${contactInfo.keywords}
- Company Website: ${contactInfo.website}
- LinkedIn URL: ${contactInfo.linkedInUrl}
- Technologies Used: ${contactInfo.technologies}
- Company Description: ${contactInfo.seoDescription}
- Company Size: ${contactInfo.employees}
- Annual Revenue: ${contactInfo.annualRevenue}

${projectInfo}

${activityContext}

${baseTemplate ? `BASE TEMPLATE TO FOLLOW:\n${baseTemplate}\n\n` : ''}

CRITICAL REQUIREMENTS - BREVITY IS ESSENTIAL:
1. Keep the message EXTREMELY SHORT - maximum 2-3 sentences or 1 very brief paragraph (50-100 words total)
2. People on LinkedIn are busy - they don't have time to read long messages
3. Get straight to the point - no fluff, no unnecessary words
4. Use the contact's name in the greeting
5. Include ONE key personalization detail (their company, industry, or role)
6. Include ONE clear value proposition or benefit
7. End with a simple question or soft call-to-action
8. Use a friendly, conversational tone (more casual than email)
9. Do NOT use placeholder text like {{Name}} - use the actual name
10. Focus on the most important information only - cut everything else
11. If previous activity context exists, reference it briefly in 1 sentence

OUTPUT FORMAT:
Return ONLY the LinkedIn message text (no subject line, no metadata). Start directly with the greeting (e.g., "Hi [Name]," or "Hello [Name],"). Keep it under 100 words.`;

  return prompt;
}

/**
 * Generate personalized LinkedIn message using AI
 */
async function generatePersonalizedLinkedInMessage(contactId, projectId, baseTemplate = null) {
  try {
    if (!process.env.GROQ_API_KEY) {
      throw new Error('Groq API key is not configured');
    }

    // Gather all contact data
    const contactData = await gatherContactData(contactId, projectId);

    // Build the prompt
    const prompt = buildLinkedInPrompt(contactData, baseTemplate);

    // Get Groq client
    const groqClient = getGroqClient();

    // Call Groq API
    const modelCandidates = [
      'llama-3.3-70b-versatile',
      'llama-3.2-11b-text-preview'
    ];

    let completion;
    let lastErr;
    for (const model of modelCandidates) {
      try {
        completion = await groqClient.chat.completions.create({
          model,
          messages: [
            {
              role: 'system',
              content: 'You are an expert B2B LinkedIn outreach specialist. You create SHORT, personalized LinkedIn messages that are extremely concise (50-100 words), relevant, and effective. Brevity is critical - people on LinkedIn are busy and don\'t have time to read long messages. You always use actual contact information and never use placeholders. LinkedIn messages should be more conversational and less formal than emails. Focus on the most important information only.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          max_tokens: 200,
          temperature: 0.7
        });
        lastErr = null;
        break;
      } catch (modelErr) {
        lastErr = modelErr;
        if (!(modelErr?.message?.includes('model') || modelErr?.code === 'model_decommissioned')) {
          break;
        }
      }
    }

    if (!completion && lastErr) {
      throw lastErr;
    }

    const linkedInMessage = completion.choices[0].message.content.trim();

    return {
      success: true,
      linkedInMessage,
      contactInfo: {
        name: contactData.contact.name,
        company: contactData.contact.company,
        linkedInUrl: contactData.contact.personLinkedinUrl || contactData.contact.companyLinkedinUrl
      }
    };
  } catch (error) {
    console.error('Error generating personalized LinkedIn message:', error);
    throw error;
  }
}

module.exports = {
  generatePersonalizedEmail,
  generatePersonalizedLinkedInMessage,
  gatherContactData,
  buildEmailPrompt,
  buildLinkedInPrompt
};
