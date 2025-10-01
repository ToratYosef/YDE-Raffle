/**
 * Node.js script to generate referral links from a list of referrers.
 * * This script now connects to Firestore using the Firebase Admin SDK
 * and generates links in the format: "Full Name = https://ydeseniors.com/?ref=RefTag"
 *
 * MODIFIED to use a single 'name' field (e.g., "David Hamra") from Firestore.
 */

// --- FIREBASE SETUP ---
const admin = require('firebase-admin');

// Load the service account key. Ensure this file is in the same directory.
const serviceAccount = require('./serviceAccountKey.json');

// --- CONFIGURATION ---
const BASE_DOMAIN = 'https://ydeseniors.com/';
const REFERRAL_PARAM = '?ref=';

// Initialize Firebase Admin SDK and Firestore instance
let db;
try {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log("Firebase Admin SDK initialized successfully.");
} catch (error) {
    console.error("❌ Failed to initialize Firebase Admin SDK:", error.message);
    // Exit if initialization fails, as we cannot connect to the database.
    process.exit(1); 
}

// --- DATABASE FUNCTION (UPDATED) ---
/**
 * Fetches referrers data from the Firestore 'referrers' collection.
 * It now assumes each document contains a single 'name' field (e.g., "John Smith").
 * @returns {Promise<Array<{name: string}>>} A promise resolving to an array of referrer objects.
 */
async function fetchReferrersFromDatabase() {
    console.log("Fetching referrers from Firestore collection: 'referrers'...");
    
    try {
        // Query the 'referrers' collection
        const referrersRef = db.collection('referrers');
        const snapshot = await referrersRef.get();
        const referrers = [];

        if (snapshot.empty) {
            console.log('No documents found in the "referrers" collection.');
            return referrers;
        }

        snapshot.forEach(doc => {
            const data = doc.data();
            // Validate that the single 'name' field is present
            if (data.name && typeof data.name === 'string' && data.name.trim().length > 0) {
                referrers.push({
                    name: data.name, // Store the full name string
                });
            } else {
                console.warn(`Skipping document ID ${doc.id}: Missing or invalid 'name' field.`);
            }
        });

        return referrers;

    } catch (error) {
        console.error("❌ Error fetching referrers from Firestore:", error.message);
        // Return an empty array on failure
        return [];
    }
}

/**
 * Creates a unique, URL-safe referral tag based on the name parts.
 * Format: FirstName + LastInitial (e.g., David, Hamra -> DavidH)
 * @param {string} firstName 
 * @param {string} lastName 
 * @returns {string} The generated referral tag
 */
function generateRefTag(firstName, lastName) {
    if (!firstName) {
        return '';
    }
    
    // Get the first initial of the last name, capitalized.
    const lastInitial = (lastName && lastName.length > 0) ? lastName.charAt(0).toUpperCase() : '';
    
    // Combine first name and last initial. Remove spaces from the first name.
    const refTag = `${firstName.replace(/\s/g, '')}${lastInitial}`;

    // Return the final tag, ensuring the first letter is capitalized.
    return refTag.charAt(0).toUpperCase() + refTag.slice(1);
}

/**
 * Main function to generate and print all referral links.
 * This is now an asynchronous function to handle database fetching.
 */
async function generateAllReferralLinks() {
    // Await the database results
    const referrers = await fetchReferrersFromDatabase();
    const results = [];

    if (referrers.length === 0) {
        console.log("No referral links generated.");
        return;
    }

    console.log(`\n--- Generated Referral Links (${referrers.length} Found) ---`);

    for (const referrer of referrers) {
        const fullName = referrer.name;
        
        // Split the full name to get the first and last parts for the ref tag
        const nameParts = fullName.trim().split(/\s+/);
        
        // Assume the first word is the first name
        const firstName = nameParts[0] || '';
        
        // Assume the last word is the last name (handles middle names/initials correctly)
        const lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : '';

        // 1. Generate the unique referral tag
        const refTag = generateRefTag(firstName, lastName);

        // 2. Construct the full URL
        const fullLink = `${BASE_DOMAIN}${REFERRAL_PARAM}${refTag}`;

        // 3. Format the final output string
        const outputLine = `${fullName} = ${fullLink}`;
        
        results.push(outputLine);
        console.log(outputLine);
    }

    console.log("------------------------------------------");
    return results;
}

// Execute the main asynchronous function
(async () => {
    await generateAllReferralLinks();
})();
