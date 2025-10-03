// This code MUST be executed on a secure backend environment (like Node.js,
// a Cloud Function, or a secure server).
// Running this code in a web browser will expose your service account credentials,
// leading to a critical security vulnerability.

// 1. Import the Firebase Admin SDK
const admin = require('firebase-admin');

// 2. Initialization: Load credentials from the specified path
if (!admin.apps.length) {
    try {
        // Loading the Service Account Key from the specified path
        const serviceAccount = require('./serviceAccountKey.json');
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("Firebase Admin SDK initialized successfully.");
    } catch (e) {
        console.error("ERROR: Failed to initialize Admin SDK. Ensure 'serviceAccountKey.json' is in the correct path and accessible.", e);
        process.exit(1); // Exit if initialization fails
    }
}


/**
 * Retrieves a user's unique UID from their email address.
 * This is the first step an administrator takes to find the user.
 * @param {string} email The user's registered (even if fake) email.
 * @returns {Promise<string|null>} The user's UID or null if not found/error.
 */
async function getUidByEmail(email) {
    try {
        const userRecord = await admin.auth().getUserByEmail(email);
        console.log(`Found user: ${userRecord.email} with UID: ${userRecord.uid}`);
        return userRecord.uid;
    } catch (error) {
        if (error.code === 'auth/user-not-found') {
            console.error(`User not found for email: ${email}`);
        } else {
            console.error(`Error retrieving user by email: ${error.message}`);
        }
        return null;
    }
}

/**
 * Directly resets a user's password using the Firebase Admin SDK.
 * This function bypasses the email requirement and should ONLY be called
 * after the user's identity has been verified through an alternative secure method.
 * @param {string} uid The unique ID of the user whose password needs resetting.
 * @param {string} newPassword The temporary new password to assign.
 * @returns {Promise<boolean>} True if successful, false otherwise.
 */
async function adminResetPassword(uid, newPassword) {
    if (!uid || !newPassword) {
        console.error("UID and new password must be provided.");
        return false;
    }

    try {
        // Step 1: Use the Admin SDK to update the user record
        await admin.auth().updateUser(uid, {
            password: newPassword
        });

        console.log(`Successfully reset password for user UID: ${uid}`);
        console.log("Action required: Securely communicate this new password to the user.");
        console.warn("Recommendation: Force the user to change this temporary password immediately upon login.");

        // Optionally, you might want to retrieve the user object and check their details
        const user = await admin.auth().getUser(uid);
        console.log(`User email: ${user.email}, Account Enabled: ${!user.disabled}`);

        return true;

    } catch (error) {
        console.error(`Error resetting password for UID ${uid}:`, error.message);
        return false;
    }
}

// --- Example Admin Workflow Usage ---

async function runAdminResetWorkflow() {
    // 1. Replace with the fake email the user provided when signing up
    const TARGET_EMAIL = 'fakeuser@example.com'; 
    const TEMPORARY_NEW_PASSWORD = 'TempPassword123!';

    // 2. Admin confirms user identity, then finds UID by email.
    console.log(`Attempting to find UID for email: ${TARGET_EMAIL}`);
    const uid = await getUidByEmail(TARGET_EMAIL);

    if (uid) {
        // 3. Admin performs the direct password reset.
        console.log(`\nProceeding to reset password for UID: ${uid}`);
        const success = await adminResetPassword(uid, TEMPORARY_NEW_PASSWORD);

        if (success) {
            console.log("\nADMIN ACTION COMPLETE: Password has been updated. Now communicate the new password securely.");
        } else {
            console.log("\nADMIN ACTION FAILED: Password update failed.");
        }
    } else {
        console.log("Admin reset workflow aborted: User not found.");
    }
}

// // Uncomment the line below to test the full admin workflow in your secure environment:
// runAdminResetWorkflow();

// Export functions if this script is used as a module (e.g., in a Cloud Function)
module.exports = { adminResetPassword, getUidByEmail };
