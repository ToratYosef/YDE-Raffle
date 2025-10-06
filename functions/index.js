const functions = require('firebase-functions');
const admin = require('firebase-admin');
const cors = require('cors'); 

// IMPORTANT: Initialize the Firebase Admin SDK
admin.initializeApp();

// NOTE: It's crucial that the 'stripe' config variable is correctly set in your Firebase environment
const stripe = require('stripe')(functions.config().stripe.secret_key);

const corsHandler = cors({
    origin: [
        'https://yderaffle.web.app',
        'https://www.yderaffle.web.app'
    ],
});

// --- Utility Functions ---

/**
 * Rounds a number to exactly two decimal places for financial calculations.
 * Used to prevent floating point math errors during summation and storage.
 * @param {number} value The number to round.
 * @returns {number} The rounded number.
 */
function cleanAmount(value) {
    const num = parseFloat(value);
    if (isNaN(num)) return 0;
    return Math.round(num * 100) / 100;
}

/**
 * Ensures a value is a safe integer for ticket counting.
 * @param {*} value The value to convert.
 * @returns {number} A clean integer.
 */
function cleanTicketCount(value) {
    const num = parseInt(value, 10);
    if (isNaN(num)) return 0;
    return Math.max(0, num);
}


// --- SECURITY AND ROLE CHECKERS ---

/**
 * Checks if the user is authorized as a super admin.
 */
function isSuperAdmin(context) {
    // Check for 'superAdmin' claim set by the admin creation script
    return context.auth && context.auth.token.superAdmin === true;
}

/**
 * Checks if the user is authorized as an admin (referrer, general admin, or super admin).
 */
function isAdmin(context) {
    return context.auth && (
        context.auth.token.superAdmin === true || 
        context.auth.token.referrer === true || 
        context.auth.token.admin === true
    );
}

// --- NEW ADMIN CSV EXPORT FUNCTION (Simple and Targeted) ---

/**
 * Callable function to fetch raw data for administrative CSV export, bypassing complex queries.
 * Requires Admin or Super Admin role.
 */
exports.getAdminExportData = functions.https.onCall(async (data, context) => {
    if (!isAdmin(context)) { 
        throw new functions.https.HttpsError('permission-denied', 'Access denied. Requires Admin or Super Admin role.');
    }
    const { dataType } = data;
    const db = admin.firestore();
    let collectionRef;

    switch (dataType) {
        case 'raffle':
            // Split The Pot Tickets (using amountPaid which is the base amount)
            collectionRef = db.collection('splitThePotTickets');
            break;
        case 'rolex':
            // Rolex Raffle Entries (using amountPaid which is the base amount)
            collectionRef = db.collection('rolex_entries');
            break;
        case 'donations':
            // Donations (using amount which is the base amount)
            collectionRef = db.collection('stripe_donation_payment_intents').where('status', '==', 'succeeded');
            break;
        case 'referrers':
            // Referrers table (includes all totals)
            collectionRef = db.collection('referrers');
            break;
        default:
            throw new functions.https.HttpsError('invalid-argument', 'Invalid data type specified for export.');
    }

    try {
        const snapshot = await collectionRef.get();
        const exportData = [];

        snapshot.forEach(doc => {
            // Get data and ensure the document ID is included as 'id' for tracking
            const entry = { id: doc.id, ...doc.data() };
            exportData.push(entry);
        });

        return { exportData };
    } catch (error) {
        console.error(`Error fetching export data for ${dataType}:`, error);
        throw new functions.https.HttpsError('internal', 'Failed to fetch export data.', error.message);
    }
});


// --- USER MANAGEMENT FUNCTIONS ---

/**
 * Callable function to fetch all users from Firebase Auth, excluding anonymous users.
 * Requires Super Admin role.
 */
exports.getAllAuthUsers = functions.https.onCall(async (data, context) => {
    if (!isSuperAdmin(context)) {  
        throw new functions.https.HttpsError('permission-denied', 'Access denied. Requires Super Admin role.');
    }

    let users = [];
    let nextPageToken;
    let totalUsersFetched = 0;

    try {
        // Fetch users in batches of 1000
        do {
            const listUsersResult = await admin.auth().listUsers(1000, nextPageToken);
            
            listUsersResult.users.forEach(userRecord => {
                
                // --- FIX: Exclude Anonymous Users by requiring an email ---
                if (!userRecord.email) {
                    return; // Skip this user
                }
                // --- END FIX ---
                
                const claims = userRecord.customClaims || {};
                
                // Construct a lighter object with useful fields
                users.push({
                    uid: userRecord.uid,
                    email: userRecord.email, // Guaranteed to exist by the filter
                    displayName: userRecord.displayName || 'N/A',
                    disabled: userRecord.disabled,
                    emailVerified: userRecord.emailVerified,
                    createdAt: userRecord.metadata.creationTime,
                    lastSignInTime: userRecord.metadata.lastSignInTime,
                    isSuperAdmin: claims.superAdmin || false,
                    isReferrer: claims.referrer || false,
                    isAdmin: claims.admin || false,
                    refId: claims.refId || null
                });
            });

            nextPageToken = listUsersResult.pageToken;
            totalUsersFetched = users.length;

        } while (nextPageToken && totalUsersFetched < 10000); // Stop after 10000 identifiable users for safety

        return { users };

    } catch (error) {
        console.error('Error fetching all users:', error);
        throw new functions.https.HttpsError('internal', 'Failed to fetch user list.', error.message);
    }
});

/**
 * Callable function to batch reset passwords for multiple users.
 * Requires Super Admin role.
 */
exports.adminResetMultiPassword = functions.https.onCall(async (data, context) => {
    if (!isSuperAdmin(context)) {  
        throw new functions.https.HttpsError('permission-denied', 'Access denied. Requires Super Admin role.');
    }

    const { uids, newPassword } = data;

    if (!uids || !Array.isArray(uids) || uids.length === 0 || !newPassword || newPassword.length < 6) {
        throw new functions.https.HttpsError('invalid-argument', 'Missing or invalid UIDs array or new password (min 6 chars).');
    }

    let successfulResets = [];
    let failedResets = [];

    // Use Promise.all to reset passwords concurrently
    const resetPromises = uids.map(uid => 
        admin.auth().updateUser(uid, { password: newPassword })
            .then(() => {
                successfulResets.push(uid);
            })
            .catch(error => {
                console.error(`Failed to reset password for UID ${uid}: ${error.message}`);
                failedResets.push({ uid, error: error.message });
            })
    );

    await Promise.all(resetPromises);

    return {
        success: true,
        message: `Successfully reset ${successfulResets.length} password(s). Failed: ${failedResets.length}.`,
        successfulResets,
        failedResets
    };
});

// --- NEW CLICK TRACKING FUNCTION ---

/**
 * Callable function to track a click on a referral link.
 */
exports.trackRefLinkClick = functions.https.onCall(async (data, context) => {
    const { refId } = data;

    if (!refId) {
        return { success: true, message: "Click not tracked: Missing refId." };
    }

    const db = admin.firestore();
    
    try {
        const referrerQuerySnapshot = await db.collection('referrers')
            .where('refId', '==', refId)
            .limit(1)
            .get();

        if (referrerQuerySnapshot.empty) {
            console.warn(`Click tracked for unknown refId: ${refId}`);
            return { success: true, message: "Click recorded (Ref ID not found in database)." };
        }

        const referrerDocRef = referrerQuerySnapshot.docs[0].ref;
        
        // Atomically increment the clickCount field
        await referrerDocRef.set({
            clickCount: admin.firestore.FieldValue.increment(1),
            // FIX: Use a new field for the last click time to avoid overwriting the original referrer doc timestamp/metadata
            lastClickTimestamp: admin.firestore.FieldValue.serverTimestamp() 
        }, { merge: true });

        return { success: true, message: `Click tracked for referrer: ${refId}` };

    } catch (error) {
        console.error(`Error tracking click for ${refId}:`, error);
        return { success: false, message: "Failed to track click due to server error." };
    }
});


// --- TICKET CLEANUP FUNCTIONS ---

/**
 * Scheduled function to remove reserved Rolex tickets older than 5 minutes.
 * NOTE: This cleanup function is now LEGACY as the client side creates rolex_entries, but kept for cleanup of old data/test data.
 */
exports.cleanupReservedTickets = functions.pubsub.schedule('every 5 minutes').onRun(async (context) => {
    const db = admin.firestore();
    const fiveMinutesInMs = 5 * 60 * 1000; 
    const fiveMinutesAgo = new Date(Date.now() - fiveMinutesInMs); 

    try {
        // Checking the old rolex_tickets collection which may still contain reserved entries from old code
        const reservedTicketsSnapshot = await db.collection('rolex_tickets')
            .where('status', '==', 'reserved')
            .where('timestamp', '<', fiveMinutesAgo) 
            .get();

        if (reservedTicketsSnapshot.empty) {
            return null;
        }

        const batch = db.batch();
        reservedTicketsSnapshot.forEach(doc => {
            batch.delete(doc.ref);
        });

        await batch.commit();
        return null;

    } catch (error) {
        console.error('Error during reserved ticket cleanup (rolex_tickets):', error);
        return null;
    }
});

/**
 * Callable function to retrieve counts of reserved and expired tickets for the admin tool.
 * NOTE: This function relies on the LEGACY 'rolex_tickets' collection and is only for cleanup tool status.
 * Requires Super Admin role.
 */
exports.getReservedTicketCounts = functions.https.onCall(async (data, context) => {
    if (!isSuperAdmin(context)) { 
        throw new functions.https.HttpsError('permission-denied', 'Access denied. Requires Super Admin role.');
    }

    const db = admin.firestore();
    const fiveMinutesInMs = 5 * 60 * 1000;
    const tenMinutesInMs = 10 * 60 * 1000;
    const fiveMinutesAgo = new Date(Date.now() - fiveMinutesInMs);
    const tenMinutesAgo = new Date(Date.now() - tenMinutesInMs);
    
    let totalReserved = 0;
    let expired5Min = 0;
    let expired10Min = 0;

    try {
        // Querying LEGACY collection 'rolex_tickets' for old reserved status cleanup check
        const allReservedSnapshot = await db.collection('rolex_tickets')
            .where('status', '==', 'reserved')
            .get();

        totalReserved = allReservedSnapshot.size;

        allReservedSnapshot.forEach(doc => {
            const ticket = doc.data();
            // Ensure timestamp is converted correctly if it's a Firestore Timestamp object
            const timestamp = ticket.timestamp.toDate ? ticket.timestamp.toDate() : ticket.timestamp;

            if (timestamp < fiveMinutesAgo) {
                expired5Min++;
            }
            if (timestamp < tenMinutesAgo) {
                expired10Min++;
            }
        });

        return { totalReserved, expired5Min, expired10Min };

    } catch (error) {
        console.error('Error fetching reserved ticket counts:', error);
        throw new functions.https.HttpsError('internal', 'Failed to retrieve ticket counts.', error.message);
    }
});

/**
 * Callable function to manually delete reserved tickets older than 5 minutes.
 * NOTE: This function relies on the LEGACY 'rolex_tickets' collection.
 * Requires Super Admin role.
 */
exports.deleteExpiredReservedTickets = functions.https.onCall(async (data, context) => {
    if (!isSuperAdmin(context)) {
        throw new functions.https.HttpsError('permission-denied', 'Access denied. Requires Super Admin role.');
    }

    const db = admin.firestore();
    const fiveMinutesInMs = 5 * 60 * 1000;
    const fiveMinutesAgo = new Date(Date.now() - fiveMinutesInMs); 

    try {
        // Querying LEGACY collection 'rolex_tickets'
        const reservedTicketsSnapshot = await db.collection('rolex_tickets')
            .where('status', '==', 'reserved')
            .where('timestamp', '<', fiveMinutesAgo) 
            .get();

        if (reservedTicketsSnapshot.empty) {
            return { deletedCount: 0, message: 'No reserved tickets older than 5 minutes found to delete.' };
        }

        const batch = db.batch();
        reservedTicketsSnapshot.forEach(doc => {
            batch.delete(doc.ref);
        });

        await batch.commit();
        
        return { deletedCount: reservedTicketsSnapshot.size, message: `Successfully deleted ${reservedTicketsSnapshot.size} reserved tickets older than 5 minutes.` };

    } catch (error) {
        console.error('Error during manual reserved ticket cleanup (rolex_tickets):', error);
        throw new functions.https.HttpsError('internal', 'Failed to perform manual cleanup.', error.message);
    }
});

// --- CORE ADMIN PASSWORD RESET LOGIC ---

/**
 * Retrieves a user's unique UID from their email address.
 * @param {string} email The user's registered email.
 * @returns {Promise<string|null>} The user's UID or null if not found/error.
 */
async function getUidByEmail(email) {
    try {
        // Uses the globally initialized admin SDK
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
        // Uses the globally initialized admin SDK
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


// --- ADMIN PASSWORD RESET ENDPOINT ---

/**
 * HTTP Function endpoint for Super Admins to directly reset a user's password 
 * based on their email, bypassing the password reset email requirement. 
 */
exports.adminResetPasswordByEmail = functions.https.onRequest((req, res) => {
    // NOTE: This uses the existing corsHandler defined in the file
    corsHandler(req, res, async () => {
        
        // !!! CRITICAL SECURITY CHECK PLACEHOLDER !!!
        const ADMIN_SECRET_KEY = functions.config().admin?.api_key;
        const providedKey = req.headers['x-admin-api-key'];

        if (!providedKey || providedKey !== ADMIN_SECRET_KEY) {
            // Return HTTP 403 Forbidden for security
            return res.status(403).send({ message: 'Forbidden. Invalid Admin API Key.' });
        }
        // !!! END CRITICAL SECURITY CHECK PLACEHOLDER !!!

        if (req.method !== 'POST') {
            return res.status(405).send({ message: 'Method Not Allowed. Use POST.' });
        }

        const { email, newPassword } = req.body;

        if (!email || !newPassword) {
            return res.status(400).json({ 
                success: false, 
                message: 'Email and newPassword are required in the request body.' 
            });
        }

        try {
            // 1. Find the UID using the provided email
            const uid = await getUidByEmail(email);

            if (!uid) {
                return res.status(404).json({ 
                    success: false, 
                    message: `User not found for email: ${email}.` 
                });
            }

            // 2. Directly reset the password using the Admin SDK
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
            console.error("Admin Reset Endpoint execution error:", error.message);
            return res.status(500).json({ 
                success: false, 
                message: 'A general server error occurred.' 
            });
        }
    });
});


// --- PAYMENT INTENT FUNCTIONS ---

/**
 * Firebase Callable Function to create a Stripe PaymentIntent for the Rolex Raffle (quantity-based $150 tickets).
 * This function handles quantity-based sales and reserves a single entry document.
 */
exports.createRolexPaymentIntent = functions.https.onCall(async (data, context) => {
    const SOURCE_APP_TAG = 'YDE Rolex Raffle';

    try {
        const { name, email, phone, referral, quantity, amount } = data;
        
        if (!name || !email || !phone || !quantity || !amount) {
            throw new functions.https.HttpsError('invalid-argument', 'Missing required fields: name, email, phone, quantity, or amount.');
        }

        const cleanedQuantity = cleanTicketCount(quantity);
        const cleanedAmount = cleanAmount(amount);

        if (cleanedQuantity < 1 || cleanedAmount <= 0) {
            throw new functions.https.HttpsError('invalid-argument', 'Invalid ticket quantity or amount.');
        }

        // amount is the amount sent from client (base + fees, if applicable)
        const amountInCents = Math.round(cleanedAmount * 100);

        // Calculate base amount (assuming TICKET_PRICE = 150)
        const TICKET_PRICE = 150;
        const baseAmount = cleanAmount(cleanedQuantity * TICKET_PRICE);

        const paymentIntent = await stripe.paymentIntents.create({
            amount: amountInCents,
            currency: 'usd',
            description: `YDE Rolex Raffle - ${cleanedQuantity} Tickets`, 
            payment_method_types: ['card'],
            metadata: {
                name,
                email,
                phone,
                ticketsBought: cleanedQuantity.toString(), // Quantity is crucial here
                baseAmount: baseAmount.toString(), // Base price excluding fees
                entryType: 'rolex_raffle', // Use new entry type
                sourceApp: SOURCE_APP_TAG,
                referrerRefId: referral || null
            },
        });

        // Store PI creation details in a dedicated collection
        await admin.firestore().collection('stripe_rolex_payment_intents').doc(paymentIntent.id).set({
            chargedAmount: cleanedAmount,
            baseAmount: baseAmount,
            ticketsBought: cleanedQuantity,
            name,
            email,
            phone,
            referrerRefId: referral || null,
            status: 'created',
            sourceApp: SOURCE_APP_TAG,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return { clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id };

    } catch (error) {
        console.error('Error creating Stripe PaymentIntent for Rolex Raffle:', error);
        if (error.code && error.message) {
             throw new functions.https.HttpsError(error.code, error.message);
        } else {
            const stripeError = error.raw && error.raw.message ? error.raw.message : 'Failed to create PaymentIntent.';
            throw new functions.https.HttpsError('internal', stripeError);
        }
    }
});


/**
 * Firebase Callable Function to create a Stripe PaymentIntent for the raffle (Split The Pot).
 */
exports.createStripePaymentIntent = functions.https.onCall(async (data, context) => {
    const SOURCE_APP_TAG = 'YDE Split The Pot'; 

    try {
        const { chargedAmount, baseAmount, ticketsBought, name, email, phone, referral } = data;
        const cleanedTicketsBought = cleanTicketCount(ticketsBought);

        if (!chargedAmount || !baseAmount || !cleanedTicketsBought || !name || !email || !phone) {
            throw new functions.https.HttpsError('invalid-argument', 'Missing required fields: chargedAmount, baseAmount, ticketsBought, name, email, or phone.');
        }

        // chargedAmount is the amount sent to Stripe (baseAmount + fee, if fee is included)
        const amountToChargeInCents = Math.round(parseFloat(chargedAmount) * 100);

        const paymentIntent = await stripe.paymentIntents.create({
            amount: amountToChargeInCents,
            currency: 'usd',
            description: `YDE Split The Pot - ${cleanedTicketsBought} Tickets`, 
            payment_method_types: ['card'],
            metadata: {
                name,
                email,
                phone,
                // Use cleaned integer ticketsBought
                ticketsBought: cleanedTicketsBought.toString(), 
                // baseAmount is the price excluding fees (e.g., 86, not 88.88)
                baseAmount: cleanAmount(baseAmount).toString(), 
                referrerRefId: referral || '',
                entryType: 'raffle',
                sourceApp: SOURCE_APP_TAG 
            },
        });

        // Store PI creation details, including both charged and base amounts
        await admin.firestore().collection('stripe_payment_intents').doc(paymentIntent.id).set({
            chargedAmount: chargedAmount,
            baseAmount: cleanAmount(baseAmount),
            ticketsBought: cleanedTicketsBought,
            name,
            email,
            phone,
            referrerRefId: referral || null,
            status: 'created',
            sourceApp: SOURCE_APP_TAG, 
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return { clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id };

    } catch (error) {
        console.error('Error creating Stripe PaymentIntent (Raffle):', error);
        throw new functions.https.HttpsError('internal', 'Failed to create PaymentIntent.');
    }
});

/**
 * Firebase Callable Function to create a Stripe PaymentIntent for a general donation.
 */
exports.createDonationPaymentIntent = functions.https.onCall(async (data, context) => {
    const SOURCE_APP_TAG = 'YDE Donation'; 

    try {
        // Updated to accept the referral/refId
        const { amount, name, email, phone, referral } = data;
        const cleanedAmount = cleanAmount(amount);

        if (!cleanedAmount || !name || !email || !phone) {
            throw new functions.https.HttpsError('invalid-argument', 'Missing required fields: amount, name, email, or phone.');
        }
        
        // Assume 'amount' here is the total charged (Base Amount + Fee, if user pays the fee).
        const amountInCents = Math.round(cleanedAmount * 100);

        const paymentIntent = await stripe.paymentIntents.create({
            amount: amountInCents,
            currency: 'usd',
            description: `YDE Donation`, 
            payment_method_types: ['card'],
            metadata: {
                name,
                email,
                phone,
                amount: cleanedAmount.toString(), // Ensure amount in metadata is cleaned
                entryType: 'donation',
                sourceApp: SOURCE_APP_TAG,
                // Add referral ID to Stripe metadata
                referrerRefId: referral || null
            },
        });

        // Store PI creation details
        await admin.firestore().collection('stripe_donation_payment_intents').doc(paymentIntent.id).set({
            name,
            email,
            phone,
            // Storing the charged amount here
            amount: cleanedAmount, 
            status: 'created',
            sourceApp: SOURCE_APP_TAG, 
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            // Add referral ID to Firestore document
            referrerRefId: referral || null
        });

        return { clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id };

    } catch (error) {
        console.error('Error creating Stripe PaymentIntent for donation:', error);
        throw new functions.https.HttpsError('internal', 'Failed to create donation PaymentIntent.');
    }
});

/**
 * Stripe Webhook Listener (HTTP Request Function).
 * Unified handler for Raffle, Rolex Raffle, and Donation success events.
 */
exports.stripeWebhook = functions.https.onRequest(async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = functions.config().stripe.webhook_secret;
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
    } catch (err) {
      console.error(`Webhook signature verification failed: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'payment_intent.succeeded') {
      const paymentIntent = event.data.object;

      // Metadata extraction
      const { name, email, phone, ticketsBought, baseAmount, referrerRefId, entryType, sourceApp } = paymentIntent.metadata;

      const firstName = name.split(' ')[0] || name;
      
      try {
        const db = admin.firestore();

        // 1. Determine which document to check/update (raffle or donation PI status document)
        let docRefToCheck = db.collection('stripe_payment_intents').doc(paymentIntent.id);
        let entriesCollection;

        if (entryType === 'donation') {
            docRefToCheck = db.collection('stripe_donation_payment_intents').doc(paymentIntent.id);
        } else if (entryType === 'rolex_raffle') {
            docRefToCheck = db.collection('stripe_rolex_payment_intents').doc(paymentIntent.id);
            entriesCollection = 'rolex_entries'; // New collection for Rolex sales
        } else if (entryType === 'raffle') {
            entriesCollection = 'splitThePotTickets'; // Collection for Split The Pot sales
        }

        const docSnapshot = await docRefToCheck.get();
        if (docSnapshot.data() && docSnapshot.data().webhookProcessed) {
          return res.status(200).send('Webhook event already processed.');
        }
        
        // --- Shared variables ---
        const amountCharged = cleanAmount(paymentIntent.amount / 100); 

        // Base amount (excluding fees) to be recorded as the revenue/sale value
        let amountForSaleRecord = cleanAmount(baseAmount) || 0; 
        
        let referrerUid = null;
        let referrerName = null;
        const ticketCount = cleanTicketCount(ticketsBought);

        if (referrerRefId) {
            const referrerQuerySnapshot = await db.collection('referrers')
                .where('refId', '==', referrerRefId)
                .limit(1)
                .get();

            if (!referrerQuerySnapshot.empty) {
                referrerUid = referrerQuerySnapshot.docs[0].id;
                referrerName = referrerQuerySnapshot.docs[0].data().name;
            }
        }
        
        // --- Sales Processing (Raffle or Rolex Raffle) ---
        if (entriesCollection) {
            
            const newEntry = {
                fullName: name, 
                firstName: firstName, 
                phoneNumber: phone, 
                email: email, 
                referrerRefId: referrerRefId || null,
                referrerUid: referrerUid || null,
                referrerName: referrerName,
                amountPaid: amountForSaleRecord, // Use fee-excluded base amount
                ticketCount: ticketCount, 
                paymentMethod: 'Stripe', 
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                entryType: 'stripe',
                sourceApp: sourceApp || `${entriesCollection} (Webhook)` 
            };

            // For Rolex Raffle, we need to create multiple documents if ticketsBought > 1.
            // For Split the Pot, one entry documents the multiple tickets.
            if (entryType === 'rolex_raffle') {
                for (let i = 0; i < ticketCount; i++) {
                    // Create an entry document for each ticket
                    await db.collection(entriesCollection).add({
                        ...newEntry,
                        // Override values specific to single Rolex ticket context
                        amountPaid: cleanAmount(amountForSaleRecord / ticketCount), // Price per ticket
                        ticketCount: 1,
                        // Add original PI ID for tracking
                        paymentIntentId: paymentIntent.id
                    });
                }
            } else { // 'raffle' (Split The Pot)
                // Add one entry documenting the batch purchase
                await db.collection(entriesCollection).add(newEntry);
            }


            // Update overall global totals counter (Split The Pot pot is calculated client-side from this)
            if (entryType === 'raffle') {
                 const raffleTotalsRef = db.collection('counters').doc('raffle_totals');
                 await raffleTotalsRef.set({
                     totalTickets: admin.firestore.FieldValue.increment(ticketCount),
                     totalAmount: admin.firestore.FieldValue.increment(amountForSaleRecord)
                 }, { merge: true });
            }

            // Update Referrer Stats
            if (referrerUid) {
                const referrerRef = db.collection('referrers').doc(referrerUid);
                let updateData = {
                    totalAmount: admin.firestore.FieldValue.increment(amountForSaleRecord) // Combined total for all sales
                };

                if (entryType === 'raffle') {
                    // Split the Pot contributes to totalTickets
                    updateData.totalTickets = admin.firestore.FieldValue.increment(ticketCount);
                } else if (entryType === 'rolex_raffle') {
                    // Rolex Raffle contributes to rolexTicketsTotal (count of tickets/entries)
                    updateData.rolexTicketsTotal = admin.firestore.FieldValue.increment(ticketCount);
                }

                await referrerRef.set(updateData, { merge: true });
            }
        } 
        
        // --- Donation Processing ---
        else if (entryType === 'donation') {
            // Update the stripe_donation_payment_intents document
            const donationIntentRef = db.collection('stripe_donation_payment_intents').doc(paymentIntent.id);
            await donationIntentRef.update({
                status: 'succeeded',
                amountPaid: amountCharged, // Store actual charged amount for PI tracking
                webhookProcessed: true,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                sourceApp: sourceApp || 'YDE Donation (Webhook)' 
            });
        }

        // 2. Update the main payment intent document status (all types)
        await docRefToCheck.update({
          status: 'succeeded',
          webhookProcessed: true,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        res.status(200).send('Webhook processed successfully.');

      } catch (error) {
        console.error('Error processing payment_intent.succeeded webhook:', error);
        res.status(500).send('Internal Server Error during webhook processing.');
      }
    } else {
      res.status(200).send('Webhook event ignored (uninteresting type).');
    }
});


// --- ADMIN/REFERRER MANAGEMENT FUNCTIONS ---

/**
 * Callable function to create a new Admin account (non-SuperAdmin, non-Referrer viewer).
 * Requires Super Admin role.
 */
exports.createAdmin = functions.https.onCall(async (data, context) => {
    if (!isSuperAdmin(context)) {
        throw new functions.https.HttpsError('permission-denied', 'Only Super Admins can create new admins.');
    }
    const { email, password, name } = data;

    if (!email || !password || !name) {
        throw new functions.https.HttpsError('invalid-argument', 'Missing required fields.');
    }

    try {
        const userRecord = await admin.auth().createUser({ email, password, displayName: name });
        const uid = userRecord.uid;

        // Set custom claims for general admin access (can view dashboard, run cleanup, etc.)
        await admin.auth().setCustomUserClaims(uid, { admin: true });

        return { success: true, message: `Admin ${name} created successfully.` };
    } catch (error) {
        console.error('Error creating new admin:', error);
        throw new functions.https.HttpsError('internal', 'Failed to create admin.', error.message);
    }
});


/**
 * Callable function to get dashboard data based on user role.
 * NOTE: This function is the primary source of the composite index error due to complex queries.
 * Requires Admin role.
 */
exports.getAdminDashboardData = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated.');
    }

    const uid = context.auth.uid;
    const isSuperAdminUser = isSuperAdmin(context);
    const isReferrerUser = context.auth.token.referrer === true;

    if (!isAdmin(context)) {
        throw new functions.https.HttpsError('permission-denied', 'User is not authorized as Admin, Super Admin, or Referrer.');
    }

    const db = admin.firestore();
    let rolexEntries = [];
    let raffleEntries = [];
    let donationEntries = [];
    let referrers = [];
    let userData = {};

    try {
        // 1. Fetch User/Referrer Data (needed for referrer name, goal, and filtering)
        if (isReferrerUser || isSuperAdminUser) {
            const userDoc = await db.collection('referrers').doc(uid).get();
            if (userDoc.exists) {
                userData = { uid, ...userDoc.data() };
            }
        }
        
        // 2. Determine Query scope
        let raffleQuery = db.collection('splitThePotTickets');
        // FIX: Point Rolex query to the new collection
        let rolexQuery = db.collection('rolex_entries');
        
        // If a standard referrer, filter sales to only show their own
        if (isReferrerUser && !isSuperAdminUser) {
            const refId = userData.refId || 'INVALID_REF_ID';
            // Filter by UIDs for raffle (more reliable)
            raffleQuery = raffleQuery.where('referrerUid', '==', uid); 
            // Filter by Ref ID for Rolex 
            rolexQuery = rolexQuery.where('referrerRefId', '==', refId); 
        } else if (!isSuperAdminUser) {
             // General Admin: Show all raffle sales, but hide rolex/donations
             // Filter Split the Pot by existence of ticketCount (ensures only actual sales)
             raffleQuery = raffleQuery.where('ticketCount', '>', 0);
             // Hide Rolex by intentionally querying a non-existent status
             rolexQuery = rolexQuery.where('status', '==', 'invalid_status_to_hide_from_general_admin');
             
        }

        // 3. Fetch Transaction Data
        // The error likely occurs here because the Firestore SDK forces a single orderBy if a where() is used
        // and we have no indexes for complex queries. Using a single orderBy on timestamp for safety.
        
        const rolexSnapshot = await rolexQuery
            // Only need paid or claimed entries
            .where('status', 'in', ['paid', 'claimed'])
            .orderBy('timestamp', 'desc').get();
            
        const raffleSnapshot = await raffleQuery
            .orderBy('timestamp', 'desc').get();

        rolexEntries = rolexSnapshot.docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
            // Further filter out free claims that don't belong to a referrer (only affects Super Admin view)
            .filter(entry => isSuperAdminUser || entry.referrerRefId); 

        // Ensure raffle entries include the document ID for the assignment/transfer feature
        raffleEntries = raffleSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })); 

        if (isSuperAdminUser) {
            // Super Admin: Fetch all referrers and all donations
            const referrerSnapshot = await db.collection('referrers').get();
            referrers = referrerSnapshot.docs.map(doc => ({ uid: doc.id, ...doc.data() }));

            // Donations should be simple: filter by status, order by date
            const donationSnapshot = await db.collection('stripe_donation_payment_intents')
                                             .where('status', '==', 'succeeded')
                                             .orderBy('createdAt', 'desc').get();
            donationEntries = donationSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        }

        return {
            isSuperAdmin: isSuperAdminUser,
            isReferrer: isReferrerUser,
            userData: userData,
            referrers: referrers,
            rolexEntries: rolexEntries,
            raffleEntries: raffleEntries,
            donationEntries: donationEntries 
        };

    } catch (error) {
        console.error("Error in getAdminDashboardData:", error);
        // Throw a specific error that instructs the user on index creation (or use a better generic message)
        throw new functions.https.HttpsError('internal', 'An internal error occurred while fetching dashboard data. This is often caused by a missing Firestore composite index.', error.message);
    }
});


/**
 * Callable function to assign or transfer a batch of raffle sales (SplitThePot) to a specific referrer.
 * Requires Super Admin role.
 */
exports.assignReferrerToSales = functions.https.onCall(async (data, context) => {
    // 1. Security Check
    if (!isSuperAdmin(context)) {
        throw new functions.https.HttpsError('permission-denied', 'Access denied. Requires Super Admin role.');
    }

    const { saleIds, refId } = data;
    if (!saleIds || !Array.isArray(saleIds) || saleIds.length === 0 || !refId) {
        throw new functions.https.HttpsError('invalid-argument', 'Missing sales IDs or target referrer ID.');
    }

    const db = admin.firestore();
    const chunkSize = 400; // Batch write limit is 500.

    let targetReferrerUid = null;
    let targetReferrerName = null;

    // Aggregates for final update on the TARGET referrer
    let targetTicketsIncrement = 0;
    let targetAmountIncrement = 0;

    // Map to track decrements for OLD referrers (Uid -> {tickets: number, amount: number})
    const oldReferrerDecrementMap = new Map();

    try {
        // 2. Get Target Referrer Info (UID and Name)
        const targetReferrerQuerySnapshot = await db.collection('referrers')
            .where('refId', '==', refId)
            .limit(1)
            .get();

        if (targetReferrerQuerySnapshot.empty) {
            throw new functions.https.HttpsError('not-found', `Target Referrer with ID ${refId} not found.`);
        }
        
        const referrerDoc = targetReferrerQuerySnapshot.docs[0];
        targetReferrerUid = referrerDoc.id;
        targetReferrerName = referrerDoc.data().name;

        // 3. Process updates in batches
        for (let i = 0; i < saleIds.length; i += chunkSize) {
            const batch = db.batch();
            const chunk = saleIds.slice(i, i + chunkSize);

            // Fetch the documents to calculate the current state BEFORE updating
            const salePromises = chunk.map(id => db.collection('splitThePotTickets').doc(id).get());
            const saleSnapshots = await Promise.all(salePromises);
            
            let updatedCount = 0;

            saleSnapshots.forEach(snapshot => {
                if (snapshot.exists) {
                    const sale = snapshot.data();
                    const oldRefId = sale.referrerRefId;
                    const oldRefUid = sale.referrerUid;
                    
                    // Only process if the sale is currently assigned to a DIFFERENT referrer 
                    // OR if it is unassigned. Do nothing if already assigned to the target.
                    if (oldRefId !== refId) { 
                        // IMPORTANT: Use amountPaid from the sale document (which holds baseAmount)
                        const tickets = cleanTicketCount(sale.ticketCount); // Ensure ticket count is clean
                        const amount = cleanAmount(sale.amountPaid) || 0; // Use cleanAmount
                        
                        // A) Decrement (Transfer scenario)
                        if (oldRefUid) {
                            // Add to decrement map for atomic update later
                            const currentDecrement = oldReferrerDecrementMap.get(oldRefUid) || { tickets: 0, amount: 0 };
                            currentDecrement.tickets += tickets;
                            currentDecrement.amount = cleanAmount(currentDecrement.amount + amount); // Clean intermediate sum
                            oldReferrerDecrementMap.set(oldRefUid, currentDecrement);
                        }

                        // B) Increment (Always happens for the target referrer)
                        targetTicketsIncrement += tickets;
                        targetAmountIncrement = cleanAmount(targetAmountIncrement + amount); // Clean intermediate sum

                        // C) Update Sale Document in the Batch
                        batch.update(snapshot.ref, {
                            referrerRefId: refId,
                            referrerUid: targetReferrerUid,
                            referrerName: targetReferrerName,
                            updatedAt: admin.firestore.FieldValue.serverTimestamp() // Use new updatedAt field
                        });

                        updatedCount++;
                    }
                }
            });

            if (updatedCount > 0) {
                 await batch.commit();
            }
        }
        
        // 4. Update Referrer Totals (Atomic Updates)
        const totalBatch = db.batch();

        // 4.1 Decrement Old Referrers
        oldReferrerDecrementMap.forEach((totals, uid) => {
            if (uid !== targetReferrerUid) { // Skip decrementing if old and new are the same
                const oldReferrerRef = db.collection('referrers').doc(uid);
                // totalTickets and totalAmount are for Split the Pot sales
                totalBatch.set(oldReferrerRef, {
                    totalTickets: admin.firestore.FieldValue.increment(-totals.tickets),
                    totalAmount: admin.firestore.FieldValue.increment(-totals.amount)
                }, { merge: true });
            }
        });

        // 4.2 Increment Target Referrer
        if (targetTicketsIncrement > 0) {
            const targetReferrerRef = db.collection('referrers').doc(targetReferrerUid);
            // totalTickets and totalAmount here are for Split the Pot sales
            totalBatch.set(targetReferrerRef, {
                totalTickets: admin.firestore.FieldValue.increment(targetTicketsIncrement),
                totalAmount: admin.firestore.FieldValue.increment(targetAmountIncrement)
            }, { merge: true });
        }

        await totalBatch.commit();


        return { 
            success: true, 
            message: `Successfully assigned/transferred ${targetTicketsIncrement} Split The Pot tickets to ${targetReferrerName} (${refId}).` 
        };

    } catch (error) {
        console.error("Error assigning/transmitting raffle sales:", error);
        if (error.code) {
            throw new functions.https.HttpsError(error.code, error.message);
        }
        throw new functions.https.HttpsError('internal', 'Failed to assign/transfer sales due to server error.', error.message);
    }
});


/**
 * Callable function to assign or transfer a batch of Rolex Raffle (Rolex) sales to a specific referrer.
 * FIX: Updated to use the 'rolex_entries' collection.
 * Requires Super Admin role.
 */
exports.assignReferrerToRolexTickets = functions.https.onCall(async (data, context) => {
    if (!isSuperAdmin(context)) {
        throw new functions.https.HttpsError('permission-denied', 'Access denied. Requires Super Admin role.');
    }

    const { ticketIds, refId } = data;
    if (!ticketIds || !Array.isArray(ticketIds) || ticketIds.length === 0 || !refId) {
        throw new functions.https.HttpsError('invalid-argument', 'Missing ticket IDs or target referrer ID.');
    }

    const db = admin.firestore();
    const chunkSize = 400; // Batch write limit is 500.

    let targetReferrerUid = null;
    let targetReferrerName = null;

    // Aggregates for final update on the TARGET referrer
    let targetAmountIncrement = 0;
    let targetTicketCount = 0; 

    // Map to track decrements for OLD referrers (RefId -> {tickets: number, amount: number})
    const oldReferrerDecrementMap = new Map();

    try {
        // 2. Get Target Referrer Info (UID and Name)
        const targetReferrerQuerySnapshot = await db.collection('referrers')
            .where('refId', '==', refId)
            .limit(1)
            .get();

        if (targetReferrerQuerySnapshot.empty) {
            throw new functions.https.HttpsError('not-found', `Target Referrer with ID ${refId} not found.`);
        }
        
        const referrerDoc = targetReferrerQuerySnapshot.docs[0];
        targetReferrerUid = referrerDoc.id;
        targetReferrerName = referrerDoc.data().name;
        const targetReferrerRef = db.collection('referrers').doc(targetReferrerUid);


        // 3. Process updates in batches
        for (let i = 0; i < ticketIds.length; i += chunkSize) {
            const batch = db.batch();
            const chunk = ticketIds.slice(i, i + chunkSize);

            // Fetch the documents to calculate the current state BEFORE updating
            // FIX: Using rolex_entries collection
            const ticketPromises = chunk.map(id => db.collection('rolex_entries').doc(id).get());
            const ticketSnapshots = await Promise.all(ticketPromises);
            
            let updatedCount = 0;

            ticketSnapshots.forEach(snapshot => {
                if (snapshot.exists) {
                    const ticket = snapshot.data();
                    // Rolex entries must be 'paid' or 'claimed' 
                    if (ticket.status !== 'paid' && ticket.status !== 'claimed') {
                        return;
                    }
                    // CRITICAL FIX: Ignore free claimed tickets for referral assignment/transfer
                    if (ticket.isFreeClaim === true) {
                        return;
                    }
                    
                    const oldRefId = ticket.referrerRefId;
                    const amount = cleanAmount(ticket.amountPaid) || 0; // amountPaid stores the base amount

                    // Only process if the ticket is currently assigned to a DIFFERENT referrer 
                    // OR if it is unassigned (oldRefId is null).
                    if (oldRefId !== refId) { 
                        
                        // A) Decrement (Transfer scenario)
                        if (oldRefId) {
                            // Add to decrement map for atomic update later (Rolex tickets are always 1 ticket count)
                            const currentDecrement = oldReferrerDecrementMap.get(oldRefId) || { tickets: 0, amount: 0 };
                            currentDecrement.tickets += 1;
                            currentDecrement.amount = cleanAmount(currentDecrement.amount + amount); // Clean intermediate sum
                            oldReferrerDecrementMap.set(oldRefId, currentDecrement);
                        }

                        // B) Increment (Always happens for the target referrer)
                        targetAmountIncrement = cleanAmount(targetAmountIncrement + amount); // Clean intermediate sum
                        targetTicketCount += 1;

                        // C) Update Ticket Document in the Batch
                        // FIX: Update rolex_entries collection
                        batch.update(snapshot.ref, {
                            referrerRefId: refId,
                            updatedAt: admin.firestore.FieldValue.serverTimestamp() // Use new updatedAt field
                        });

                        updatedCount++;
                    }
                }
            });

            if (updatedCount > 0) {
                 await batch.commit();
            }
        }
        
        // 4. Update Referrer Totals (Atomic Updates)
        const totalBatch = db.batch();

        // 4.1 Decrement Old Referrers
        for (const [oldRefId, totals] of oldReferrerDecrementMap.entries()) {
            if (oldRefId !== refId) { 
                // Need to look up UID for the old referrer since the Rolex ticket only stores RefId
                const oldReferrerQuerySnapshot = await db.collection('referrers')
                    .where('refId', '==', oldRefId)
                    .limit(1)
                    .get();

                if (!oldReferrerQuerySnapshot.empty) {
                    const oldReferrerUid = oldReferrerQuerySnapshot.docs[0].id;
                    const oldReferrerRef = db.collection('referrers').doc(oldReferrerUid);
                    
                    totalBatch.set(oldReferrerRef, {
                        rolexTicketsTotal: admin.firestore.FieldValue.increment(-totals.tickets), // Decrement rolex ticket count
                        totalAmount: admin.firestore.FieldValue.increment(-totals.amount) // Decrement general total amount
                    }, { merge: true });
                }
            }
        }
        
        // 4.2 Increment Target Referrer
        if (targetTicketCount > 0) {
            totalBatch.set(targetReferrerRef, {
                rolexTicketsTotal: admin.firestore.FieldValue.increment(targetTicketCount),
                totalAmount: admin.firestore.FieldValue.increment(targetAmountIncrement)
            }, { merge: true });
        }

        await totalBatch.commit();


        return { 
            success: true, 
            message: `Successfully assigned/transferred ${targetTicketCount} Rolex Raffle tickets to ${targetReferrerName} (${refId}).` 
        };

    } catch (error) {
        console.error("Error assigning/transferring Rolex sales:", error);
        if (error.code) {
            throw new functions.https.HttpsError(error.code, error.message);
        }
        throw new functions.https.HttpsError('internal', 'Failed to assign/transfer sales due to server error.', error.message);
    }
});


// --- SHARED RECALCULATION LOGIC ---

/**
 * Shared internal function to rebuild all three sales totals (Split The Pot count, Rolex count, and combined amount)
 * for all referrers from scratch based on current sales documents.
 */
async function _rebuildAllReferrerTotals(db) {
    // --- 1. Aggregate NEW Rolex Totals (from rolex_entries) by RefId ---
    // FIX: Using rolex_entries collection
    const rolexTicketsSnapshot = await db.collection('rolex_entries')
        .where('status', 'in', ['paid', 'claimed'])
        .get();

    // Map: { refId: { amount: number, tickets: number } }
    const rolexAggregatesByRefId = new Map();
    
    rolexTicketsSnapshot.forEach(ticketDoc => {
        const ticket = ticketDoc.data();
        const refId = ticket.referrerRefId;
        // FIX: Ensure free claims are IGNORED during referral recalculation
        if (ticket.isFreeClaim === true) {
            return;
        }

        // Uses amountPaid which is the fee-excluded amount
        const amountPaid = ticket.amountPaid || 0; 
        
        // FIX: Ensure retrieved amount is rounded to prevent float errors during summation
        const cleanedAmount = cleanAmount(amountPaid);

        if (refId) {
            const current = rolexAggregatesByRefId.get(refId) || { amount: 0, tickets: 0 };
            current.amount = cleanAmount(current.amount + cleanedAmount); // Use cleaned intermediate sum
            current.tickets += 1;
            rolexAggregatesByRefId.set(refId, current);
        }
    });
    
    // --- 2. Prepare Updates by Iterating ALL Referrers ---
    const referrersSnapshot = await db.collection('referrers').get();
    const updateBatch = db.batch();
    let totalUpdatedReferrers = 0;

    // Collect all referrer UIDs and RefIDs for processing
    const referrerData = new Map();
    referrersSnapshot.forEach(doc => {
        referrerData.set(doc.id, {
            ref: doc.ref,
            refId: doc.data().refId,
        });
    });

    // Process all referrers
    for (const [uid, data] of referrerData.entries()) {
        const { ref: referrerRef, refId } = data;

        // 2a. Get NEW Rolex Totals for this referrer
        const newRolexTotals = rolexAggregatesByRefId.get(refId) || { amount: 0, tickets: 0 };
        
        // 2b. Re-read the Split The Pot totals for this referrer (to ensure accuracy)
        const splitPotSales = await db.collection('splitThePotTickets')
            // FIX: This query requires an index on referrerUid
            .where('referrerUid', '==', uid)
            .get();
        
        let newSplitPotAmount = 0;
        let newSplitPotTickets = 0;
        splitPotSales.forEach(saleDoc => {
            const amountPaid = saleDoc.data().amountPaid || 0;
            // FIX: Ensure retrieved amount is rounded to prevent float errors during summation
            const cleanedAmount = cleanAmount(amountPaid);

            newSplitPotAmount = cleanAmount(newSplitPotAmount + cleanedAmount); // Use cleaned intermediate sum
            newSplitPotTickets += cleanTicketCount(saleDoc.data().ticketCount); // Ensure ticket count is clean
        });

        // 2c. Calculate the FINAL Combined Total Amount (base amounts only)
        const newCombinedTotalAmount = cleanAmount(newSplitPotAmount + newRolexTotals.amount); // Final rounding
        
        // 2d. Set the complete, accurate data in the batch
        // We SET the new values; no dangerous incrementing/decrementing is needed.
        updateBatch.set(referrerRef, {
            // Split The Pot data
            totalTickets: newSplitPotTickets,
            // Rolex data
            rolexTicketsTotal: newRolexTotals.tickets,
            // Combined total is rebuilt from fresh data
            totalAmount: newCombinedTotalAmount
        }, { merge: true });
        
        totalUpdatedReferrers++;
    }

    // --- 3. Commit the Final Batch of Updates ---
    await updateBatch.commit();
    
    return {
        totalUpdatedReferrers,
        totalRolexTicketsAnalyzed: rolexTicketsSnapshot.size
    };
}


// --- RECALCULATION FUNCTIONS (Public) ---

/**
 * Callable function to recalculate the Rolex Raffle (Rolex) totals for all referrers.
 * This function now uses the shared rebuild logic.
 */
exports.recalculateRolexTotals = functions.https.onCall(async (data, context) => {
    if (!isSuperAdmin(context)) {
        throw new functions.https.HttpsError('permission-denied', 'You must be a super admin to run this function.');
    }

    const db = admin.firestore();
    
    try {
        const result = await _rebuildAllReferrerTotals(db);

        return {
            success: true,
            message: `Rolex and Combined Totals successfully rebuilt for ${result.totalUpdatedReferrers} referrers. Total Rolex tickets analyzed: ${result.totalRolexTicketsAnalyzed}.`
        };
        
    } catch (error) {
        console.error('Error in recalculateRolexTotals:', error);
        throw new functions.https.HttpsError('internal', 'Failed to recalculate Rolex totals due to server error.', error.message);
    }
});

/**
 * Callable function to recalculate ALL referrer numbers (Rolex count, Split The Pot count, and combined sales total).
 */
exports.recalculateAllReferrerTotals = functions.https.onCall(async (data, context) => {
    if (!isSuperAdmin(context)) {
        throw new functions.https.HttpsError('permission-denied', 'You must be a super admin to run this function.');
    }

    const db = admin.firestore();

    try {
        const result = await _rebuildAllReferrerTotals(db);

        return {
            success: true,
            message: `All Referrer totals successfully rebuilt for ${result.totalUpdatedReferrers} referrers. Data integrity verified.`
        };
    } catch (error) {
        console.error('Error in recalculateAllReferrerTotals:', error);
        throw new functions.https.HttpsError('internal', 'Failed to recalculate all referrer totals due to server error.', error.message);
    }
});


/**
 * Firebase Callable Function to recalculate the global counters (Split The Pot).
 */
exports.recalculateRaffleTotals = functions.https.onCall(async (data, context) => {
    if (!isSuperAdmin(context)) {
        throw new functions.https.HttpsError('permission-denied', 'You must be a super admin to run this function.');
    }

    const db = admin.firestore();
    let totalTickets = 0;
    let totalAmount = 0;

    try {
        // 1. Recalculate global totals for Split The Pot
        const raffleEntriesSnapshot = await db.collection('splitThePotTickets').get();
        if (raffleEntriesSnapshot.empty) {
            console.log("No raffle entries found to recalculate totals.");
        } else {
            raffleEntriesSnapshot.forEach(doc => {
                const entry = doc.data();
                const tickets = cleanTicketCount(entry.ticketCount); // Use cleanTicketCount
                totalTickets += tickets;

                const amountPaid = entry.amountPaid || 0;
                // FIX: Ensure retrieved amount is rounded to prevent float errors during summation
                const cleanedAmount = cleanAmount(amountPaid);
                totalAmount = cleanAmount(totalAmount + cleanedAmount); // Clean intermediate sum
            });
        }
        
        // FIX: Round the final global amount before saving
        totalAmount = cleanAmount(totalAmount);


        const raffleTotalsRef = db.collection('counters').doc('raffle_totals');
        await raffleTotalsRef.set({
            totalTickets: totalTickets,
            totalAmount: totalAmount
        }, { merge: true });

        // 2. Also recalculate all referrer totals to update their Split Pot contribution
        const referrerResult = await _rebuildAllReferrerTotals(db);

        return {
            success: true,
            message: `Global Counters successfully updated. Total tickets: ${totalTickets}, Total amount: $${totalAmount.toFixed(2)}. Also rebuilt totals for ${referrerResult.totalUpdatedReferrers} referrers.`
        };

    } catch (error) {
        console.error('Error in recalculateRaffleTotals:', error);
        throw new functions.https.HttpsError('internal', 'Failed to recalculate totals...', error.message);
    }
});

/**
 * Callable function to add a manual raffle entry.
 */
exports.addManualSale = functions.https.onCall(async (data, context) => {
    const SOURCE_APP_TAG = 'YDE Manual Sale'; 

    if (!isAdmin(context)) {
        throw new functions.https.HttpsError('permission-denied', 'You must be an admin to add a manual entry.');
    }

    const { name, email, phone, ticketsBought, amount, refId } = data;
    if (!name || !ticketsBought || !amount) {
        throw new functions.https.HttpsError('invalid-argument', 'Missing required fields.');
    }

    const db = admin.firestore();
    const ticketCount = cleanTicketCount(ticketsBought); // Use cleanTicketCount
    let amountPaid = cleanAmount(amount); // This acts as the baseAmount for manual sales and is now rounded
    
    const firstName = name.split(' ')[0] || name;

    let referrerUid = null;
    let referrerName = "N/A";
    let actualRefId = refId;
    
    // Logic to determine who the sale is credited to
    if (actualRefId) {
        // If refId is provided in the call, find the corresponding referrer
        const referrerQuerySnapshot = await db.collection('referrers')
            .where('refId', '==', actualRefId)
            .limit(1)
            .get();

        if (!referrerQuerySnapshot.empty) {
            referrerUid = referrerQuerySnapshot.docs[0].id;
            referrerName = referrerQuerySnapshot.docs[0].data().name;
        }
    } else if (context.auth.token.referrer) {
        // If no refId provided, but the caller is a referrer, credit them
        referrerUid = context.auth.uid;
        // Need to fetch referrer name/refId from the 'referrers' collection 
        const callerDoc = await db.collection('referrers').doc(referrerUid).get();
        if (callerDoc.exists) {
            referrerName = callerDoc.data().name;
            actualRefId = callerDoc.data().refId;
        }
    }


    const newEntry = {
        fullName: name, 
        firstName: firstName, 
        email: email || null,
        phoneNumber: phone || null, 
        ticketCount: ticketCount, 
        amountPaid: amountPaid, // Base amount (fee-excluded and rounded)
        paymentMethod: "Manual",
        referrerRefId: actualRefId || null,
        referrerUid: referrerUid || null,
        referrerName: referrerName,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        entryType: "manual",
        sourceApp: SOURCE_APP_TAG 
    };

    try {
        await db.collection('splitThePotTickets').add(newEntry);

        // Update overall raffle totals (using new field names)
        const raffleTotalsRef = db.collection('counters').doc('raffle_totals');
        await raffleTotalsRef.set({
            totalTickets: admin.firestore.FieldValue.increment(ticketCount),
            totalAmount: admin.firestore.FieldValue.increment(amountPaid)
        }, { merge: true });

        // Update referrer stats
        if (referrerUid) {
            const referrerRef = db.collection('referrers').doc(referrerUid);
            // totalTickets and totalAmount here are for Split the Pot sales
            await referrerRef.set({
                totalTickets: admin.firestore.FieldValue.increment(ticketCount),
                totalAmount: admin.firestore.FieldValue.increment(amountPaid)
            }, { merge: true });
        }

        return { success: true, message: "Manual entry added successfully." };
    } catch (error) {
        console.error("Error adding manual sale:", error);
        throw new functions.https.HttpsError('internal', 'An internal error occurred.', error.message);
    }
});


/**
 * Callable function to update a raffle entry.
 * Requires Super Admin role.
 */
exports.updateRaffleEntry = functions.https.onCall(async (data, context) => {
    if (!isSuperAdmin(context)) {
        throw new functions.https.HttpsError('permission-denied', 'You must be a super admin to update entries.');
    }
    
    const { entryId, updatedData } = data;
    const db = admin.firestore();

    try {
        const docRef = db.collection('splitThePotTickets').doc(entryId);
        const docSnapshot = await docRef.get();
        if (!docSnapshot.exists) {
            throw new functions.https.HttpsError('not-found', 'Entry not found.');
        }

        const originalData = docSnapshot.data();
        
        // Use clean functions for original data
        const originalTickets = cleanTicketCount(originalData.ticketCount);
        const originalAmount = cleanAmount(originalData.amountPaid) || 0; // Base amount

        // Use clean functions for updated data
        const updatedTickets = cleanTicketCount(updatedData.ticketCount);
        let updatedAmount = cleanAmount(updatedData.amountPaid); // New base amount and rounded
        
        const updatedFullName = updatedData.fullName || (updatedData.name ? updatedData.name.split(' ')[0] : originalData.firstName); 

        // Calculate differences using cleaned numbers
        const ticketDiff = updatedTickets - originalTickets;
        const amountDiff = cleanAmount(updatedAmount - originalAmount); // Clean the difference

        // FIX: Completed the update payload
        await docRef.update({
            fullName: updatedFullName, 
            firstName: updatedData.firstName,
            email: updatedData.email,
            phoneNumber: updatedData.phoneNumber,
            ticketCount: updatedTickets, // Store clean integer
            amountPaid: updatedAmount, // Store clean amount
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        const raffleTotalsRef = db.collection('counters').doc('raffle_totals');
        await raffleTotalsRef.set({
            totalTickets: admin.firestore.FieldValue.increment(ticketDiff),
            totalAmount: admin.firestore.FieldValue.increment(amountDiff)
        }, { merge: true });

        if (originalData.referrerUid) {
            const referrerRef = db.collection('referrers').doc(originalData.referrerUid);
            // totalTickets and totalAmount here are for Split the Pot sales
            await referrerRef.set({
                totalTickets: admin.firestore.FieldValue.increment(ticketDiff),
                totalAmount: admin.firestore.FieldValue.increment(amountDiff)
            }, { merge: true });
        }

        return { success: true, message: "Entry updated successfully." };
    } catch (error) {
        console.error("Error updating entry:", error);
        if (error.code) {
            throw error;
        }
        throw new functions.https.HttpsError('internal', 'An internal error occurred.', error.message);
    }
});


/**
 * Callable function to delete a raffle entry.
 * Requires Super Admin role.
 */
exports.deleteRaffleEntry = functions.https.onCall(async (data, context) => {
    if (!isSuperAdmin(context)) {
        throw new functions.https.HttpsError('permission-denied', 'You must be a super admin to delete entries.');
    }
    
    const { entryId } = data;
    const db = admin.firestore();

    try {
        const docRef = db.collection('splitThePotTickets').doc(entryId);
        const docSnapshot = await docRef.get();
        if (!docSnapshot.exists) {
            throw new functions.https.HttpsError('not-found', 'Entry not found.');
        }

        const entryData = docSnapshot.data();
        const tickets = cleanTicketCount(entryData.ticketCount); // Use cleanTicketCount
        const amount = cleanAmount(entryData.amountPaid) || 0; // Base amount
        const referrerUid = entryData.referrerUid;

        await docRef.delete();

        const raffleTotalsRef = db.collection('counters').doc('raffle_totals');
        await raffleTotalsRef.set({
            totalTickets: admin.firestore.FieldValue.increment(-tickets),
            totalAmount: admin.firestore.FieldValue.increment(-amount)
        }, { merge: true });

        if (referrerUid) {
            const referrerRef = db.collection('referrers').doc(referrerUid);
            // totalTickets and totalAmount here are for Split the Pot sales
            await referrerRef.set({
                totalTickets: admin.firestore.FieldValue.increment(-tickets),
                totalAmount: admin.firestore.FieldValue.increment(-amount)
            }, { merge: true });
        }

        return { success: true, message: "Entry deleted successfully." };
    } catch (error) {
        console.error("Error deleting entry:", error);
        if (error.code) {
            throw error;
        }
        throw new functions.https.HttpsError('internal', 'An internal error occurred.', error.message);
    }
});

/**
 * Callable function to claim a free spin-to-win ticket.
 */
exports.claimSpinTicket = functions.https.onCall(async (data, context) => {
    const SOURCE_APP_TAG = 'YDE Free Spin Claim'; 

    // --- FIX 1: Require Authentication (Anonymous or credentialed) ---
    if (!context.auth) {
        // Updated error message to guide client toward anonymous authentication
        throw new functions.https.HttpsError('unauthenticated', 'Authentication required. Please ensure the user is signed in, even anonymously (using signInAnonymously), to claim a one-time ticket.');
    }
    const uid = context.auth.uid;
    const db = admin.firestore();
    const TOTAL_TICKETS = 650;
    
    let ticketNumber;
    let foundUniqueTicket = false;
    let userName = data.name || 'Anonymous Claim'; // Use provided name for the ticket if available

    try {
        const userClaimRef = db.collection('user_claims').doc(uid);
        const userClaimSnapshot = await userClaimRef.get();

        // --- FIX 2: Check for existing claim ---
        if (userClaimSnapshot.exists && userClaimSnapshot.data().freeSpinClaimed) {
            throw new functions.https.HttpsError('failed-precondition', 'You have already claimed your free spin ticket.');
        }

        // Retry loop to find an available ticket number
        for (let i = 0; i < TOTAL_TICKETS * 2; i++) {
            const randomTicket = Math.floor(Math.random() * TOTAL_TICKETS) + 1;
            const ticketRef = db.collection('rolex_entries').doc(randomTicket.toString()); // FIX: Using rolex_entries for claim reservation

            try {
                await db.runTransaction(async (transaction) => {
                    const docSnapshot = await transaction.get(ticketRef);
                    if (!docSnapshot.exists) {
                        transaction.set(ticketRef, {
                            status: 'claimed', // Directly claimed (free ticket)
                            timestamp: admin.firestore.FieldValue.serverTimestamp(), // Original creation time
                            name: userName,
                            uid: uid, // FIX: Store the claiming user's UID
                            // Free ticket has $0.00 amountPaid
                            amountPaid: 0, 
                            sourceApp: SOURCE_APP_TAG,
                            isFreeClaim: true, // FIX: Flag as a free claim
                        });
                        // Also update the user's claim status inside the same transaction
                        transaction.set(userClaimRef, {
                            freeSpinClaimed: true,
                            claimedTicketNumber: randomTicket,
                            claimedAt: admin.firestore.FieldValue.serverTimestamp(),
                            claimedName: userName
                        }, { merge: true });

                        foundUniqueTicket = true;
                    }
                });

                if (foundUniqueTicket) {
                    ticketNumber = randomTicket;
                    break;
                }
            } catch (e) {
                console.error(`Transaction failed during free ticket claim for UID ${uid}: `, e);
                // Ignore transient transaction failures and retry
            }
        }

        if (!foundUniqueTicket) {
            throw new functions.https.HttpsError('resource-exhausted', 'All tickets have been claimed. Please try again later.');
        }

        return { success: true, ticketNumber };
        
    } catch (error) {
        console.error("Error in claimSpinTicket:", error);
        if (error.code && error.message) {
             throw new functions.https.HttpsError(error.code, error.message);
        } else {
            throw new functions.https.HttpsError('internal', 'An unexpected error occurred during claim process.');
        }
    }
});

/**
 * Callable function to create a new referrer account.
 */
exports.createReferrer = functions.https.onCall(async (data, context) => {
    if (!isSuperAdmin(context)) {
        throw new functions.https.HttpsError('permission-denied', 'Only Super Admins can create new referrers.');
    }
    const { email, password, name, goal, intendedRefId } = data; 

    if (!email || !password || !name || !intendedRefId) { 
        throw new functions.https.HttpsError('invalid-argument', 'Missing required fields (email, password, name, or intendedRefId).');
    }

    try {
        const userRecord = await admin.auth().createUser({ email, password, displayName: name });
        const uid = userRecord.uid;

        // Set custom claims for referrer access and store the refId as a claim
        await admin.auth().setCustomUserClaims(uid, { referrer: true, refId: intendedRefId }); 
        
        const refIdToSave = intendedRefId; 

        await admin.firestore().collection('referrers').doc(uid).set({
            name,
            email,
            refId: refIdToSave, 
            goal: cleanAmount(goal) || 0, // Ensure goal is rounded
            totalTickets: 0, // Split the Pot Tickets
            totalAmount: 0, // Combined Amount (Split the Pot + Rolex) (Base amounts only)
            rolexTicketsTotal: 0, // NEW: Rolex Raffle Tickets
            clickCount: 0, 
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return { success: true, message: `Referrer ${name} created successfully with Ref ID: ${refIdToSave}.` };
    } catch (error) {
        console.error('Error creating new referrer:', error);
        throw new functions.https.HttpsError('internal', 'Failed to create referrer.', error.message);
    }
});

exports.setSuperAdminClaim = functions.https.onCall(async (data, context) => {
    if (!isSuperAdmin(context)) {
        throw new functions.https.HttpsError('permission-denied', 'Access denied. Only a Super Admin can promote another user.');
    }

    const { uid } = data;

    if (!uid) {
        throw new functions.https.HttpsError('invalid-argument', 'Missing target user ID (uid).');
    }

    try {
        // Get existing claims to avoid overwriting (e.g., if they were a 'referrer')
        const user = await admin.auth().getUser(uid);
        const existingClaims = user.customClaims || {};

        // Set the new claims: keep existing claims, and explicitly set 'superAdmin' to true.
        const updatedClaims = {
            ...existingClaims,
            admin: true, // Ensure they also have general admin access
            superAdmin: true
        };

        // Set the custom claim on the Firebase user object
        await admin.auth().setCustomUserClaims(uid, updatedClaims);

        // Force user to re-authenticate on their device to pick up the new claims immediately
        await admin.auth().revokeRefreshTokens(uid);

        return { 
            success: true, 
            message: `User ${uid} successfully promoted to Super Admin status. Tokens revoked.` 
        };

    } catch (error) {
        console.error(`Error promoting user ${uid} to Super Admin:`, error);
        throw new functions.https.HttpsError('internal', 'Failed to update user claims.', error.message);
    }
});
