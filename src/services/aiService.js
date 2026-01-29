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
 * Return template-specific instructions for email generation (Introduction / Follow-up / Value Proposition).
 * Uses the user-provided template structures; AI must personalize using prospect's name, title, company, industry, location, keywords, website, LinkedIn.
 * When not chosen, default to Introduction.
 */
function getTemplateInstructions(templateType, hasActivityContext) {
  let normalized = (templateType || '').toLowerCase().trim();
  if (normalized === '' || normalized === 'no-template') {
    normalized = 'introduction-email';
  }
  if (normalized === 'introduction-email' || normalized === 'introduction') {
    return {
      label: 'Introduction',
      instructions: `
INTRODUCTION TEMPLATE: Generate an email that follows this structure and tone closely. Use the prospect's actual name (never {{Name}}). Personalize the bracketed parts using their title, company, industry, location, keywords, website, and LinkedIn.

Structure to follow (adapt the content to the prospect's profile—e.g. replace "residential projects and leasing" / "property work" with their industry/role; replace "Terabits" with the sender's company from Project Context; replace "rentals, billing, and maintenance in one place" with the relevant value from the project):

Hi [Prospect's actual name],

I work closely with people involved in [their domain: e.g. their industry, or type of work from title/company] and I enjoy staying connected with those who are close to the day-to-day side of [their type of work].

At [Our company from project], we focus on making [their-relevant operations] a little easier by [specific value proposition—e.g. keeping X, Y, and Z in one place, or similar benefit tied to their industry/role].

Happy to connect.

RULES: Same paragraph count (4 short paragraphs). Same friendly, low-pressure tone. No hype. Personalize every bracket using CONTACT INFORMATION and Project Context. Subject line: 4–8 words, relevant to an introduction.`
    };
  }
  if (normalized === 'follow-up-email' || normalized === 'follow-up') {
    return {
      label: 'Follow-up',
      instructions: `
FOLLOW-UP TEMPLATE: Generate a follow-up email that follows ONE of the structures below. Each time you generate, you may pick a different variation so follow-ups feel fresh. Use the prospect's actual name (never {{Name}}). Personalize using their title, company, industry, location, keywords, website, and LinkedIn. Replace "property teams" with their type of team/role; replace "rentals, maintenance, and billing" with their relevant operations/workflows; replace "Terabits" with the sender's company from Project Context.

VARIATION A (short, "last note" + who we speak with):
Hi [Name],
Just wanted to follow up on my last note.
We usually speak with [their type of teams—e.g. property teams → use their industry/role] who want a bit more clarity in their daily workflows without changing how they already operate.
Always good to stay in touch.

VARIATION B (short follow-up + discussions revolve around):
Hi [Name],
Just sharing a short follow-up.
Most of our discussions with [their type of teams] revolve around simplifying [their relevant operations—e.g. rentals, maintenance, billing] without adding extra complexity to daily work.
Happy to stay in touch.

VARIATION C (discussions + where we step in):
Hi [Name],
Most of our discussions with [their type of teams] revolve around simplifying [their relevant operations].
This is where [Our company] usually steps in—we focus on making those everyday operations feel less like a chore so you can focus on the bigger picture.

VARIATION D (that's where we come in + messy parts):
Hi [Name],
That's usually where we come in. At [Our company], we focus on making those messy parts—like [their relevant operations]—feel a lot more manageable.
We try to keep the tech simple so it actually helps the team instead of adding more work to their day.
Happy to stay in touch,

VARIATION E (small improvements in visibility):
Hi [Name],
One thing we often notice is that small improvements in visibility can make day-to-day [their type of work] feel much more manageable.
Thought I'd share that with you.

VARIATION F (small clarity in systems):
Hi [Name],
One thing I often hear is that even small clarity in systems can make a big difference in day-to-day [their type of operations].
Thought I'd share that with you.

VARIATION G (clarity + we help by automating):
Hi [Name],
One thing I often hear is that small clarity in systems makes a big difference.
Specifically, we help by automating the repetitive stuff—like [their relevant tasks, e.g. tracking maintenance requests or streamlining billing workflows]—without adding extra complexity to your day-to-day work.

VARIATION H (clarity to X can save hours + automating in background):
Hi [Name],
One thing I've noticed is that just adding a bit of clarity to [their relevant area—e.g. maintenance tracking or billing] can save a lot of hours.
We mostly help by automating those repetitive tasks so they just happen in the background. It's a small change that usually makes the day-to-day much smoother.
Thought I'd share that.

RULES: Pick exactly ONE variation (A–H). Vary which one you pick so different generations feel different. Keep that variation's paragraph count and tone. Personalize all bracketed parts from CONTACT INFORMATION and Project Context. Subject line: 4–8 words, relevant to a follow-up.`
    };
  }
  if (normalized === 'value-proposition-email' || normalized === 'value-proposition') {
    return {
      label: 'Value Proposition',
      instructions: `
VALUE PROPOSITION TEMPLATE: Generate an email that follows this structure and tone. Use the prospect's actual name. Personalize using their title, company, industry, location, keywords, website, and LinkedIn.

Structure to follow (adapt [property operations or workflows] to their domain—e.g. their industry, role, or keywords):

Hi [Prospect's actual name],

I'll leave it here for now.

If at any point it feels useful to exchange notes around [their relevant area—e.g. their industry operations, their team's workflows, or similar], I'm always happy to connect.

Wishing you a great week ahead.

RULES: Same paragraph count (4 short paragraphs). Same polite, leave-the-ball-in-their-court tone. Personalize the "exchange notes around X" part from CONTACT INFORMATION. Subject line: 4–8 words, relevant to value/check-in.`
    };
  }
  return {
    label: 'Introduction (default)',
    instructions: `
Use the INTRODUCTION template structure and tone (see Introduction template above): Hi [Name], I work closely with people in [their domain]... At [Our company], we focus on... Happy to connect. Personalize using prospect's name, title, company, industry, location, keywords, website, LinkedIn.`
  };
}

/**
 * Build context prompt for email generation
 * templateType: 'introduction-email' | 'follow-up-email' | 'value-proposition-email' | null/other
 */
function buildEmailPrompt(contactData, baseTemplate = null, templateType = null) {
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

  // Template-specific instructions for enterprise-level, personalized content
  const templateInstructions = getTemplateInstructions(templateType, !!activityContext);

  const prompt = `
You are an expert B2B sales email writer. Generate an enterprise-level, personalized cold email based on the following information.

SELECTED TEMPLATE TYPE: ${templateInstructions.label}
${templateInstructions.instructions}

CONTACT INFORMATION (use these to personalize the email):
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

REQUIREMENTS (apply to all templates):
1. Use the contact's name naturally in the greeting (e.g., "Hi ${contactInfo.name}," or "Dear ${contactInfo.name},").
2. Reference their company, industry, role, or location to show research—enterprise-level personalization.
3. Keep it concise: 3-4 short paragraphs maximum; professional and polished.
4. Do NOT use placeholders like {{Name}}—use the actual name and data above.
5. Subject line: 4-8 words, <= 60 characters, no emojis, no ALL CAPS; relevant to the template type and content.
6. Email body format:
   - Greeting line: "Hi [Name]," or "Dear [Name],"
   - 2-4 short paragraphs separated by blank lines
   - Closing: "Regards," then "[Your Name]" or similar

OUTPUT FORMAT:
Return ONLY plain text in this exact format (no JSON, no markdown):

Subject: <your subject>
Body:
<your email body>

Body must start directly with the greeting.`;

  return prompt;
}

function extractEmailSubjectAndBody(raw) {
  const text = (raw || '').trim();
  if (!text) return { subject: '', body: '' };

  // Remove common markdown code fences if present
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  // Preferred format: "Subject: ...\nBody:\n..."
  {
    const lines = unfenced.split(/\r?\n/);
    const subjectLineIdx = lines.findIndex(l => /^subject\s*:/i.test(l));
    const bodyLineIdx = lines.findIndex(l => /^body\s*:/i.test(l));
    if (subjectLineIdx >= 0 && bodyLineIdx >= 0 && bodyLineIdx >= subjectLineIdx) {
      const subject = lines[subjectLineIdx].replace(/^subject\s*:\s*/i, '').trim();
      const body = lines.slice(bodyLineIdx + 1).join('\n').trim();
      if (subject || body) return { subject, body };
    }
  }

  // Try JSON first
  try {
    const parsed = JSON.parse(unfenced);
    const subject = typeof parsed.subject === 'string' ? parsed.subject.trim() : '';
    const body = typeof parsed.body === 'string' ? parsed.body.trim() : '';
    if (subject || body) return { subject, body };
  } catch (_) {
    // fall through
  }

  // Tolerant parse for JSON-like output that may be invalid JSON
  // Example: {"subject":"X","body":"Hi...\n\nRegards,\n[Your Name]"}
  if (unfenced.includes('"subject"') && unfenced.includes('"body"')) {
    const readQuotedValue = (s, startIdx) => {
      // startIdx points at the first quote of the value
      let i = startIdx;
      if (s[i] !== '"') return { value: '', nextIdx: startIdx };
      i += 1;
      let out = '';
      while (i < s.length) {
        const ch = s[i];
        if (ch === '\\') {
          const next = s[i + 1];
          if (next === 'n') out += '\n';
          else if (next === 'r') out += '\r';
          else if (next === 't') out += '\t';
          else if (next === '"' || next === '\\' || next === '/') out += next;
          else out += next || '';
          i += 2;
          continue;
        }
        if (ch === '"') {
          return { value: out, nextIdx: i + 1 };
        }
        out += ch;
        i += 1;
      }
      return { value: out, nextIdx: i };
    };

    const findKey = (key) => {
      const idx = unfenced.indexOf(`"${key}"`);
      if (idx < 0) return null;
      const colon = unfenced.indexOf(':', idx);
      if (colon < 0) return null;
      // find first quote after colon
      const firstQuote = unfenced.indexOf('"', colon + 1);
      if (firstQuote < 0) return null;
      return { firstQuote };
    };

    const subjKey = findKey('subject');
    const bodyKey = findKey('body');
    if (subjKey && bodyKey) {
      const subjectParsed = readQuotedValue(unfenced, subjKey.firstQuote);
      const bodyParsed = readQuotedValue(unfenced, bodyKey.firstQuote);
      const subject = (subjectParsed.value || '').trim();
      const body = (bodyParsed.value || '').trim();
      if (subject || body) return { subject, body };
    }
  }

  // Fallback: try "Subject:" anywhere
  {
    const lines = unfenced.split(/\r?\n/);
    const subjectLineIdx = lines.findIndex(l => /^subject\s*:/i.test(l));
    if (subjectLineIdx >= 0) {
      const subject = lines[subjectLineIdx].replace(/^subject\s*:\s*/i, '').trim();
      const body = lines
        .filter((_, idx) => idx !== subjectLineIdx)
        .join('\n')
        .trim();
      return { subject, body };
    }
  }

  // Last resort: return everything as body
  return { subject: '', body: unfenced };
}

/**
 * Generate personalized email using AI
 * templateType: 'introduction-email' | 'follow-up-email' | 'value-proposition-email' | null
 */
async function generatePersonalizedEmail(contactId, projectId, baseTemplate = null, templateType = null) {
  try {
    if (!process.env.GROQ_API_KEY) {
      throw new Error('Groq API key is not configured');
    }

    // Gather all contact data
    const contactData = await gatherContactData(contactId, projectId);

    // Build the prompt (templateType drives Introduction / Follow-up / Value Proposition style)
    const prompt = buildEmailPrompt(contactData, baseTemplate, templateType);

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

    const raw = completion.choices[0].message.content;
    const { subject: emailSubject, body: emailBody } = extractEmailSubjectAndBody(raw);
    const emailContent = (emailBody || '').trim();

    return {
      success: true,
      emailSubject: emailSubject || '',
      emailBody: emailContent,
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
