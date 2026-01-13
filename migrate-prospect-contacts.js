/**
 * Migration Script: Move Prospect Contacts to Separate Collection
 * 
 * This script migrates existing prospect contacts (contacts linked to projects)
 * from the Contact collection to the ProspectContact collection.
 * 
 * Steps:
 * 1. Find all contacts that are linked to projects via ProjectContact
 * 2. Copy them to ProspectContact collection (avoiding duplicates by email)
 * 3. Update ProjectContact references to point to new ProspectContact IDs
 * 
 * Run with: node migrate-prospect-contacts.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

// Import models
const Contact = require('./src/models/Contact');
const ProspectContact = require('./src/models/ProspectContact');
const ProjectContact = require('./src/models/ProjectContact');

async function migrateProspectContacts() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/leadgen-crm';
    await mongoose.connect(mongoUri);
    console.log('✓ Connected to MongoDB');

    // Step 1: Find all unique contact IDs that are linked to projects
    const projectContacts = await ProjectContact.find({})
      .select('contactId')
      .lean();
    
    const uniqueContactIds = [...new Set(
      projectContacts
        .map(pc => pc.contactId?.toString())
        .filter(id => id && mongoose.Types.ObjectId.isValid(id))
    )];

    console.log(`\nFound ${uniqueContactIds.length} unique contacts linked to projects`);

    if (uniqueContactIds.length === 0) {
      console.log('No prospect contacts to migrate.');
      await mongoose.disconnect();
      return;
    }

    // Step 2: Fetch all contacts that need to be migrated
    const contactsToMigrate = await Contact.find({
      _id: { $in: uniqueContactIds.map(id => new mongoose.Types.ObjectId(id)) }
    }).lean();

    console.log(`Found ${contactsToMigrate.length} contacts to migrate`);

    // Step 3: Check which contacts already exist in ProspectContact (by email)
    const emailsToCheck = contactsToMigrate
      .map(c => c.email?.toLowerCase())
      .filter(email => email);
    
    const existingProspectContacts = await ProspectContact.find({
      email: { $in: emailsToCheck }
    }).select('_id email').lean();

    const existingEmailMap = new Map();
    existingProspectContacts.forEach(pc => {
      const emailLower = pc.email?.toLowerCase();
      if (emailLower) {
        existingEmailMap.set(emailLower, pc._id);
      }
    });

    // Step 4: Create mapping of old Contact ID to new ProspectContact ID
    const contactIdMap = new Map(); // old Contact _id -> new ProspectContact _id
    let created = 0;
    let reused = 0;
    let skipped = 0;

    for (const contact of contactsToMigrate) {
      const emailLower = contact.email?.toLowerCase();
      
      // Check if prospect contact already exists by email
      if (emailLower && existingEmailMap.has(emailLower)) {
        // Use existing prospect contact
        const existingProspectId = existingEmailMap.get(emailLower);
        contactIdMap.set(contact._id.toString(), existingProspectId);
        reused++;
        console.log(`  → Reusing existing ProspectContact for ${contact.email || contact.name}`);
      } else {
        // Create new prospect contact
        try {
          // Remove _id and __v from contact to create new document
          const { _id, __v, ...contactData } = contact;
          const newProspectContact = await ProspectContact.create(contactData);
          contactIdMap.set(contact._id.toString(), newProspectContact._id);
          created++;
          console.log(`  ✓ Created ProspectContact for ${contact.email || contact.name}`);
        } catch (error) {
          if (error.code === 11000) {
            // Duplicate key error - try to find existing by email
            if (emailLower) {
              const existing = await ProspectContact.findOne({
                email: { $regex: new RegExp(`^${emailLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
              }).select('_id email').lean();
              
              if (existing) {
                contactIdMap.set(contact._id.toString(), existing._id);
                reused++;
                console.log(`  → Found existing ProspectContact for ${contact.email || contact.name}`);
              } else {
                skipped++;
                console.log(`  ✗ Skipped ${contact.email || contact.name} (duplicate key error)`);
              }
            } else {
              skipped++;
              console.log(`  ✗ Skipped ${contact.name} (no email, duplicate key error)`);
            }
          } else {
            skipped++;
            console.error(`  ✗ Error creating ProspectContact for ${contact.email || contact.name}:`, error.message);
          }
        }
      }
    }

    console.log(`\nMigration Summary:`);
    console.log(`  Created: ${created} new ProspectContacts`);
    console.log(`  Reused: ${reused} existing ProspectContacts`);
    console.log(`  Skipped: ${skipped} contacts`);

    // Step 5: Update ProjectContact references
    console.log(`\nUpdating ProjectContact references...`);
    let updated = 0;
    let notFound = 0;

    for (const projectContact of projectContacts) {
      const oldContactId = projectContact.contactId?.toString();
      if (!oldContactId) continue;

      const newProspectContactId = contactIdMap.get(oldContactId);
      if (!newProspectContactId) {
        notFound++;
        console.log(`  ⚠ No mapping found for Contact ${oldContactId}`);
        continue;
      }

      // Only update if the ID is different
      if (oldContactId !== newProspectContactId.toString()) {
        try {
          await ProjectContact.updateOne(
            { _id: projectContact._id },
            { $set: { contactId: newProspectContactId } }
          );
          updated++;
        } catch (error) {
          console.error(`  ✗ Error updating ProjectContact ${projectContact._id}:`, error.message);
        }
      }
    }

    console.log(`\nProjectContact Update Summary:`);
    console.log(`  Updated: ${updated} ProjectContact references`);
    console.log(`  Not found: ${notFound} references (no mapping)`);

    console.log(`\n✓ Migration completed successfully!`);
    console.log(`\nNote: Original contacts remain in Contact collection (they may be databank contacts too).`);
    console.log(`Prospect contacts are now in ProspectContact collection and linked via ProjectContact.`);

  } catch (error) {
    console.error('✗ Migration failed:', error);
    throw error;
  } finally {
    await mongoose.disconnect();
    console.log('\n✓ Disconnected from MongoDB');
  }
}

// Run migration
if (require.main === module) {
  migrateProspectContacts()
    .then(() => {
      console.log('\n✓ Migration script completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n✗ Migration script failed:', error);
      process.exit(1);
    });
}

module.exports = { migrateProspectContacts };
