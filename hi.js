const admin = require('firebase-admin');

// 1. Initialize Firebase Admin SDK using your service account key
// Make sure 'serviceAccountKey.json' is in the same directory as this script.
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

// --- Configuration for the First SuperAdmin ---
const SUPER_ADMIN_EMAIL = 'saul@ydeseniors.com';
const SUPER_ADMIN_PASSWORD = 'SaulSetton1708!'; 
const SUPER_ADMIN_NAME = 'Saul Setton'; // Optional: Name for the Super Admin

/**
 * Creates a new Firebase user and assigns them the 'superAdmin' custom claim.
 */
async function createSuperAdmin() {
    console.log(`Attempting to create SuperAdmin user: ${SUPER_ADMIN_EMAIL}`);

    try {
        // Create the user in Firebase Authentication
        const userRecord = await admin.auth().createUser({
            email: SUPER_ADMIN_EMAIL,
            emailVerified: true,
            password: SUPER_ADMIN_PASSWORD,
            displayName: SUPER_ADMIN_NAME,
            disabled: false,
        });

        const uid = userRecord.uid;

        // Set the custom claim
        await admin.auth().setCustomUserClaims(uid, { superAdmin: true, admin: true });
        
        // Optional: Create a referrer entry for the Super Admin as well, using a custom Ref ID
        const refId = 'SaulS';
        await admin.firestore().collection('referrers').doc(uid).set({
            name: SUPER_ADMIN_NAME,
            email: SUPER_ADMIN_EMAIL,
            refId: refId,
            goal: 0,
            totalTickets: 0,
            totalAmount: 0,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });


        console.log('--------------------------------------------------');
        console.log('✅ SuperAdmin User Created Successfully!');
        console.log(`Email: ${SUPER_ADMIN_EMAIL}`);
        console.log(`Password: ${SUPER_ADMIN_PASSWORD}`);
        console.log(`UID: ${uid}`);
        console.log('Custom Claim: { superAdmin: true, admin: true }');
        console.log('--------------------------------------------------');

    } catch (error) {
        if (error.code === 'auth/email-already-exists') {
            console.warn(`⚠️ User with email ${SUPER_ADMIN_EMAIL} already exists. Skipping creation.`);
            // You can optionally fetch the existing user and update their claims here if needed.
        } else {
            console.error('❌ Error creating SuperAdmin:', error.message);
        }
    }
}

// Run the script
createSuperAdmin().then(() => process.exit(0));
