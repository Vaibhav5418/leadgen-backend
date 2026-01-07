// Simple mock LinkedIn fetcher. Replace with real API integration as needed.
const https = require('https');
const http = require('http');

function extractLinkedInId(url) {
  if (!url) return null;
  const patterns = [
    /linkedin\.com\/in\/([^\/\?]+)/i,
    /linkedin\.com\/profile\/view\?id=([^&]+)/i,
    /linkedin\.com\/pub\/([^\/\?]+)/i
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// Function to fetch LinkedIn profile picture
// Attempts to extract profile picture URL from LinkedIn profile page
async function fetchLinkedInProfilePicture(linkedinUrl) {
  try {
    const linkedinId = extractLinkedInId(linkedinUrl);
    if (!linkedinId) {
      console.log('Could not extract LinkedIn ID from URL:', linkedinUrl);
      return null;
    }

    console.log('Fetching LinkedIn profile picture for:', linkedinId);

    // Method 1: Try to fetch the LinkedIn profile page and extract image from Open Graph meta tags
    const profilePageUrl = `https://www.linkedin.com/in/${linkedinId}/`;
    
    try {
      const html = await new Promise((resolve, reject) => {
        const url = new URL(profilePageUrl);
        const options = {
          hostname: url.hostname,
          path: url.pathname,
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
          },
          timeout: 8000
        };

        let data = '';
        const req = https.request(options, (res) => {
          // Handle redirects
          if (res.statusCode === 301 || res.statusCode === 302) {
            const location = res.headers.location;
            if (location) {
              console.log('Redirected to:', location);
              // Try the redirect URL
              return fetchLinkedInProfilePicture(location);
            }
          }

          res.on('data', (chunk) => {
            data += chunk.toString();
            // Limit response size
            if (data.length > 1000000) {
              req.destroy();
              reject(new Error('Response too large'));
            }
          });
          
          res.on('end', () => {
            resolve(data);
          });
        });

        req.on('error', (err) => {
          console.log('Request error:', err.message);
          reject(err);
        });
        
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Request timeout'));
        });
        
        req.setTimeout(8000);
        req.end();
      });

      // Extract image URL from Open Graph meta tags
      const ogImageMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
      if (ogImageMatch && ogImageMatch[1]) {
        let imageUrl = ogImageMatch[1].trim();
        // Clean up the URL
        imageUrl = imageUrl.replace(/\\u002F/g, '/');
        if (imageUrl.startsWith('http')) {
          console.log('Found profile picture from Open Graph:', imageUrl);
          return imageUrl;
        }
      }

      // Try other meta tag patterns
      const metaPatterns = [
        /<meta\s+name=["']image["']\s+content=["']([^"']+)["']/i,
        /<meta\s+property=["']twitter:image["']\s+content=["']([^"']+)["']/i,
        /"profilePicture":"([^"]+)"/i,
        /"image":"([^"]+media\.licdn\.com[^"]+)"/i,
        /<img[^>]*class="[^"]*profile-photo[^"]*"[^>]*src=["']([^"']+)["']/i
      ];

      for (const pattern of metaPatterns) {
        const match = html.match(pattern);
        if (match && match[1]) {
          let imageUrl = match[1].trim();
          imageUrl = imageUrl.replace(/\\u002F/g, '/');
          if (imageUrl.startsWith('http') && imageUrl.includes('media.licdn.com')) {
            console.log('Found profile picture from HTML:', imageUrl);
            return imageUrl;
          }
        }
      }

      console.log('Could not find profile picture in HTML');
    } catch (err) {
      console.log('Could not fetch LinkedIn page HTML:', err.message);
    }

    // Method 2: Fallback - construct URL with common hash patterns
    // LinkedIn profile pictures often use these hash patterns
    // We'll return the most common one - the browser will handle loading/fallback
    const imageSize = '200_200';
    const imageUrl = `https://media.licdn.com/dms/image/C4E03AQ/${linkedinId}/profile-displayphoto-shrink_${imageSize}/0/${linkedinId}?e=1721865600&v=beta&t=placeholder`;
    
    console.log('Returning LinkedIn image URL (browser will handle if unavailable):', imageUrl);
    return imageUrl;
  } catch (error) {
    console.error('Error fetching LinkedIn profile picture:', error.message);
    return null;
  }
}

function extractCompanyLinkedInId(url) {
  if (!url) return null;
  const patterns = [
    /linkedin\.com\/company\/([^\/\?]+)/i,
    /linkedin\.com\/company\/view\?id=([^&]+)/i
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

async function fetchLinkedInDataMock(linkedinUrl) {
  const linkedinId = extractLinkedInId(linkedinUrl);
  const companyLinkedInId = extractCompanyLinkedInId(linkedinUrl);
  
  // Check if it's a company LinkedIn URL
  const isCompanyUrl = companyLinkedInId !== null;
  
  const baseData = {
    profileId: linkedinId || companyLinkedInId,
    headline: 'Mock headline from LinkedIn',
    location: 'Mock location',
    industry: 'Mock industry',
    summary: 'This is mock LinkedIn data. Replace with real API calls.',
    companyAbout: 'Mock about-this-company text.',
    experience: [
      { title: 'Role', company: 'Company', duration: '2020 - Present' }
    ],
    education: [
      { school: 'School Name', degree: 'Degree', field: 'Field' }
    ],
    skills: ['Skill 1', 'Skill 2'],
    services: ['Service A', 'Service B', 'Service C'],
    connections: '500+',
    fetchedAt: new Date()
  };

  // Base64 encoded placeholder images (SVG)
  const profilePlaceholder = 'data:image/svg+xml;base64,' + Buffer.from(
    '<svg width="120" height="120" xmlns="http://www.w3.org/2000/svg"><rect width="120" height="120" fill="#e5e7eb"/><text x="50%" y="50%" font-family="Arial, sans-serif" font-size="14" fill="#9ca3af" text-anchor="middle" dy=".3em">Profile</text></svg>'
  ).toString('base64');
  
  const companyPlaceholder = 'data:image/svg+xml;base64,' + Buffer.from(
    '<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg"><rect width="200" height="200" fill="#e5e7eb"/><text x="50%" y="50%" font-family="Arial, sans-serif" font-size="16" fill="#9ca3af" text-anchor="middle" dy=".3em">Company Logo</text></svg>'
  ).toString('base64');

  // Try to fetch actual LinkedIn profile picture for personal profiles
  let profilePicture = profilePlaceholder;
  if (!isCompanyUrl && linkedinUrl) {
    try {
      const fetchedImageUrl = await fetchLinkedInProfilePicture(linkedinUrl);
      if (fetchedImageUrl && !fetchedImageUrl.includes('data:image/svg')) {
        profilePicture = fetchedImageUrl;
        console.log('Using fetched LinkedIn profile picture:', fetchedImageUrl);
      } else {
        console.log('Using placeholder image - could not fetch LinkedIn profile picture');
      }
    } catch (error) {
      console.error('Error fetching LinkedIn profile picture, using placeholder:', error.message);
    }
  }

  if (isCompanyUrl) {
    // Company LinkedIn data
    return {
      ...baseData,
      companyLogo: companyPlaceholder,
      companyPicture: companyPlaceholder,
      companyName: 'Mock Company Name',
      companyDescription: 'Mock company description from LinkedIn'
    };
  } else {
    // Personal LinkedIn data
    return {
      ...baseData,
      profilePicture: profilePicture
    };
  }
}

module.exports = {
  fetchLinkedInDataMock,
  extractLinkedInId,
  extractCompanyLinkedInId,
  fetchLinkedInProfilePicture
};
