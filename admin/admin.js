// This script sets up a secure backend endpoint using Express and the Firebase Admin SDK.
// It must run on a secure server (e.g., local server, Cloud Function, or dedicated VM).

const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');

// --- 1. ADMIN SDK INITIALIZATION ---

// IMPORTANT: Ensure your 'serviceAccountKey.json' is in the root directory.
let serviceAccount;
try {
    serviceAccount = require('/workspaces/YDE-Raffle/serviceAccountKey.json');
} catch (e) {
    console.error("FATAL ERROR: Could not load 'serviceAccountKey.json'. Please ensure it exists and the path is correct.");
    process.exit(1);
}

// Initialize the Firebase Admin SDK
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin SDK initialized successfully.");
}

// --- 2. CORE ADMIN LOGIC ---

/**
 * Retrieves a user's unique UID from their email address.
 * @param {string} email The user's registered email.
 * @returns {Promise<string|null>} The user's UID or null if not found/error.
 */
async function getUidByEmail(email) {
    try {
        const userRecord = await admin.auth().getUserByEmail(email);
        return userRecord.uid;
    } catch (error) {
        if (error.code === 'auth/user-not-found') {
            console.warn(`User not found for email: ${email}`);
        } else {
            console.error(`Error retrieving user by email: ${error.message}`);
        }
        return null;
    }
}

/**
 * Directly resets a user's password using the Firebase Admin SDK.
 * @param {string} uid The unique ID of the user.
 * @param {string} newPassword The temporary new password to assign.
 * @returns {Promise<boolean>} True if successful, false otherwise.
 */
async function adminResetPassword(uid, newPassword) {
    try {
        await admin.auth().updateUser(uid, {
            password: newPassword
        });
        console.log(`Password reset success for UID: ${uid}`);
        return true;
    } catch (error) {
        console.error(`Error resetting password for UID ${uid}:`, error.message);
        return false;
    }
}

// --- 3. EXPRESS SERVER SETUP AND ROUTE ---

const app = express();
const PORT = 3000;

// Middleware to parse JSON bodies from the client
app.use(bodyParser.json());

// Set up CORS (Cross-Origin Resource Sharing)
// WARNING: For production, you must restrict 'Access-Control-Allow-Origin' 
// to only your trusted admin client URL (e.g., 'https://admin.yourdomain.com')
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); // Should be specific URL in production
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// Define the /admin-reset-endpoint POST route
app.post('/admin-reset-endpoint', async (req, res) => {
    const { email, newPassword } = req.body;

    if (!email || !newPassword) {
        return res.status(400).json({ 
            success: false, 
            message: 'Email and newPassword are required in the request body.' 
        });
    }

    try {
        // Step 1: Find the UID using the provided email
        const uid = await getUidByEmail(email);

        if (!uid) {
            return res.status(404).json({ 
                success: false, 
                message: `User not found for email: ${email}.` 
            });
        }

        // Step 2: Directly reset the password using the Admin SDK
        const success = await adminResetPassword(uid, newPassword);

        if (success) {
            // Success response back to the admin client
            return res.status(200).json({ 
                success: true, 
                message: `Password for user ${email} successfully reset. Communicate securely to the user.` 
            });
        } else {
            // Failure during the password update process
            return res.status(500).json({ 
                success: false, 
                message: 'Internal server error during password update.' 
            });
        }

    } catch (error) {
        console.error("Endpoint execution error:", error.message);
        return res.status(500).json({ 
            success: false, 
            message: 'A general server error occurred.' 
        });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Admin Reset Endpoint listening at http://localhost:${PORT}`);
    console.log(`POST to http://localhost:${PORT}/admin-reset-endpoint with { "email": "...", "newPassword": "..." }`);
});
