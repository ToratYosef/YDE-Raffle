// --- Instructions ---
// 1. Place your downloaded Firebase service account key file in the same directory and name it "serviceAccountKey.json".
// 2. IMPORTANT: Change the TARGET_EMAIL_TO_UPGRADE constant below to the email of the user you wish to upgrade.
// 3. To run this script, open your terminal and type: node upgrade_super_admin.js

const admin = require('firebase-admin');

// 1. Initialize Firebase Admin SDK using your service account key
// Make sure 'serviceAccountKey.json' is in the same directory as this script.
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const referrersCollectionPath = 'referrers';

// --- Configuration for the User to Upgrade ---
const TARGET_EMAIL_TO_UPGRADE = 'JackB@ydeseniors.com';

/**
 * Generates the Referrer ID (RefID) based on the format:
 * [First Name] + [Last Name Initial, capitalized] (e.g., Jack Beyda -> JackB)
 * This is used if a referrer document needs to be created for the admin user.
 * @param {string} fullName The full name of the user.
 * @returns {string | null} The generated RefID or null if format is invalid.
 */
const generateRefId = (fullName) => {
    if (!fullName) return null;
    const parts = fullName.trim().split(/\s+/).filter(p => p.length > 0);
    if (parts.length < 2) {
        // Handle single-word names by using the whole name plus 'A' as placeholder initial
        if (parts.length === 1) return `${parts[0]}A`; 
        return null;
    }
    const firstName = parts[0];
    const lastName = parts[parts.length - 1];
    return `${firstName}${lastName.charAt(0).toUpperCase()}`;
};

/**
 * Fetches an existing user by email and assigns them the 'superAdmin' custom claim.
 * It also ensures a corresponding document exists in the 'referrers' collection.
 * @param {string} email The email of the user to upgrade.
 */
async function upgradeExistingUserToSuperAdmin(email) {
    console.log(`Attempting to upgrade existing user to SuperAdmin: ${email}`);

    try {
        // 1. Get the user record by email
        const userRecord = await admin.auth().getUserByEmail(email);
        const uid = userRecord.uid;

        // 2. Check current claims to avoid unnecessary writes
        const currentClaims = userRecord.customClaims || {};
        if (currentClaims.superAdmin === true) {
            console.log(`User ${email} is already a Super Admin. Skipping claim update.`);
            return;
        }

        // 3. Set the custom claims (superAdmin and general admin)
        await admin.auth().setCustomUserClaims(uid, { superAdmin: true, admin: true });
        
        // 4. Ensure a referrer entry exists (Crucial for raffle app functionality)
        const referrerDocRef = db.collection(referrersCollectionPath).doc(uid);
        const referrerDoc = await referrerDocRef.get();
        
        if (!referrerDoc.exists) {
            console.log(`Warning: Referrer document not found for UID ${uid}. Creating basic referrer entry.`);
            
            // Generate RefId using display name or a fallback
            const displayName = userRecord.displayName || email.split('@')[0];
            const refId = generateRefId(displayName) || displayName; 

            await referrerDocRef.set({
                name: displayName,
                email: email,
                refId: refId,
                goal: 0,
                totalTickets: 0,
                totalAmount: 0,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
        }


        console.log('--------------------------------------------------');
        console.log(`✅ User ${email} successfully upgraded to SuperAdmin.`);
        console.log(`UID: ${uid}`);
        console.log('Custom Claim: { superAdmin: true, admin: true }');
        console.log('--------------------------------------------------');

    } catch (error) {
        if (error.code === 'auth/user-not-found') {
            console.error(`❌ Error: User with email ${email} not found in Firebase Auth. Please check the email.`);
        } else {
            console.error('❌ General Error upgrading user:', error.message);
        }
    }
}


/* // Kept for reference, but commented out to prioritize the UPGRADE action
async function createAndSetSuperAdmin() { ... }
*/

// --- Main Execution ---
upgradeExistingUserToSuperAdmin(TARGET_EMAIL_TO_UPGRADE).then(() => process.exit(0));
