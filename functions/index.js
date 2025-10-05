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

// --- USER MANAGEMENT FUNCTIONS (NEW) ---

/**
 * Callable function to fetch all users from Firebase Auth, excluding anonymous users.
 * Only fetches users with an email address (email/password or federated identity users).
 * Requires Super Admin role. This uses the listUsers method with pagination.
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
                // Anonymous users, unlike email/password or OAuth users, do not have an email address.
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
 */
exports.cleanupReservedTickets = functions.pubsub.schedule('every 5 minutes').onRun(async (context) => {
    const db = admin.firestore();
    const fiveMinutesInMs = 5 * 60 * 1000; 
    const fiveMinutesAgo = new Date(Date.now() - fiveMinutesInMs); 

    try {
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
        console.error('Error during reserved ticket cleanup:', error);
        return null;
    }
});

/**
 * Callable function to retrieve counts of reserved and expired tickets for the admin tool.
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
        console.error('Error during manual reserved ticket cleanup:', error);
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


// --- NEW ADMIN PASSWORD RESET ENDPOINT ---

/**
 * HTTP Function endpoint for Super Admins to directly reset a user's password 
 * based on their email, bypassing the password reset email requirement.
 * NOTE: SECURITY WARNING - This MUST be secured via API Key/App Check/Session Cookie.
 */
exports.adminResetPasswordByEmail = functions.https.onRequest((req, res) => {
    // NOTE: This uses the existing corsHandler defined in the file
    corsHandler(req, res, async () => {
        
        // !!! CRITICAL SECURITY CHECK PLACEHOLDER !!!
        // You MUST implement a strong authentication check here (e.g., validating 
        // a secret API key passed in headers, or Firebase App Check). 
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
 * Firebase Callable Function to create a Stripe PaymentIntent for the Spin to Win game (Rolex).
 * This function also reserves a ticket in Firestore.
 */
exports.createRolexPaymentIntent = functions.https.onCall(async (data, context) => {
    let ticketNumber;
    const SOURCE_APP_TAG = 'YDE Spin The Wheel';

    try {
        const { name, email, phone, referral } = data;
        const TOTAL_TICKETS = 650;
        
        const firstName = name.split(' ')[0] || name; 

        if (!name || !email || !phone) {
            throw new functions.https.HttpsError('invalid-argument', 'Missing required fields: name, email, or phone.');
        }

        const db = admin.firestore();
        let foundUniqueTicket = false;

        for (let i = 0; i < TOTAL_TICKETS * 2; i++) { 
            const randomTicket = Math.floor(Math.random() * TOTAL_TICKETS) + 1;
            const ticketRef = db.collection('rolex_tickets').doc(randomTicket.toString());

            try {
                await db.runTransaction(async (transaction) => {
                    const docSnapshot = await transaction.get(ticketRef);
                    if (!docSnapshot.exists) {
                        // Set initial ticket reservation data
                        transaction.set(ticketRef, {
                            status: 'reserved',
                            timestamp: admin.firestore.FieldValue.serverTimestamp(), // Original creation time
                            name: name,
                            firstName: firstName, 
                            email: email,
                            phoneNumber: phone, 
                            sourceApp: SOURCE_APP_TAG,
                            referrerRefId: referral || null
                        });
                        foundUniqueTicket = true;
                    }
                });

                if (foundUniqueTicket) {
                    ticketNumber = randomTicket;
                    break;
                }
            } catch (e) {
                // Ignore transient transaction failures and retry
                console.error("Transaction failed during ticket reservation: ", e);
            }
        }

        if (!foundUniqueTicket) {
            throw new functions.https.HttpsError('resource-exhausted', 'All tickets have been claimed. Please try again later.');
        }

        // IMPORTANT: ticketNumber (1-650) is the base price in USD.
        // We charge the equivalent amount in cents.
        const amountInCents = ticketNumber * 100;

        const paymentIntent = await stripe.paymentIntents.create({
            amount: amountInCents,
            currency: 'usd',
            description: `YDE Spin The Wheel - Ticket ${ticketNumber}`, 
            payment_method_types: ['card'],
            metadata: {
                name,
                email,
                phone,
                ticketsBought: '1', // Ensure ticketsBought is a string for metadata
                // ticketNumber serves as the base amount for Rolex sales
                baseAmount: ticketNumber.toString(), 
                ticketNumber: ticketNumber.toString(), 
                entryType: 'rolex',
                sourceApp: SOURCE_APP_TAG,
                referrerRefId: referral || null 
            },
        });

        return { clientSecret: paymentIntent.client_secret, ticketNumber };

    } catch (error) {
        console.error('Error creating Stripe PaymentIntent for spin game:', error);
        if (ticketNumber) {
            try {
                // Clean up reserved ticket if PI creation fails
                await admin.firestore().collection('rolex_tickets').doc(ticketNumber.toString()).delete();
            } catch (cleanupError) {
                console.error('Failed to clean up reserved ticket:', cleanupError);
            }
        }
        if (error.code && error.message) {
             throw new functions.https.HttpsError(error.code, error.message);
        } else {
            // Check for Stripe specific error object structure
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
        console.error('Error creating Stripe PaymentIntent:', error);
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
      const { name, email, phone, ticketsBought, baseAmount, referrerRefId, ticketNumber, entryType, sourceApp } = paymentIntent.metadata;

      const firstName = name.split(' ')[0] || name;
      
      try {
        const db = admin.firestore();

        // 1. Determine which document to check/update (raffle or donation PI status document)
        let docRefToCheck = db.collection('stripe_payment_intents').doc(paymentIntent.id);
        if (entryType === 'donation') {
            docRefToCheck = db.collection('stripe_donation_payment_intents').doc(paymentIntent.id);
        }
        
        const docSnapshot = await docRefToCheck.get();
        if (docSnapshot.data() && docSnapshot.data().webhookProcessed) {
          return res.status(200).send('Webhook event already processed.');
        }
        
        // --- Shared variables ---
        const amountCharged = cleanAmount(paymentIntent.amount / 100); 

        // Base amount (excluding fees) to be recorded as the revenue/sale value
        let amountForSaleRecord;
        if (entryType === 'raffle') {
            // Use metadata baseAmount for fee-excluded value, ensure it is cleaned
            amountForSaleRecord = cleanAmount(baseAmount); 
        } else if (entryType === 'rolex') {
            // Use ticketNumber, which is the base price in USD, ensure it is cleaned
            amountForSaleRecord = cleanAmount(ticketNumber); 
        } else if (entryType === 'donation') {
             // Use the 'amount' field from donation PI metadata, which should be the base donation amount
             amountForSaleRecord = cleanAmount(paymentIntent.metadata.amount) || amountCharged;
        } else {
            amountForSaleRecord = 0;
        }
        
        amountForSaleRecord = cleanAmount(amountForSaleRecord); // Final sanity round

        let referrerUid = null;
        let referrerName = null;

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
        
        // --- Rolex Ticket Processing (Spin to Win) ---
        if (entryType === 'rolex') {
            // Use cleanAmount on the ticketNumber (which is the document ID/base price)
            const rolexTicketRef = db.collection('rolex_tickets').doc(ticketNumber); 
            
            await rolexTicketRef.update({
                status: 'paid',
                paymentIntentId: paymentIntent.id,
                name,
                firstName: firstName, 
                email,
                phoneNumber: phone, 
                // Store fee-excluded amount (now cleaned)
                amountPaid: amountForSaleRecord, 
                updatedAt: admin.firestore.FieldValue.serverTimestamp(), // FIX: Use new updatedAt field
                sourceApp: sourceApp || 'YDE Spin The Wheel (Webhook)',
                referrerRefId: referrerRefId || null 
            });

            // Update Referrer Stats for Rolex Ticket
            if (referrerUid) {
                const referrerRef = db.collection('referrers').doc(referrerUid);
                
                // Use fee-excluded amount for total calculation
                await referrerRef.set({
                    rolexTicketsTotal: admin.firestore.FieldValue.increment(1), 
                    totalAmount: admin.firestore.FieldValue.increment(amountForSaleRecord) 
                }, { merge: true });
            }
        } 
        
        // --- Raffle (Split The Pot) Processing ---
        else if (entryType === 'raffle') {
            const ticketCount = cleanTicketCount(ticketsBought); // Use cleanTicketCount
            // Use fee-excluded amount (baseAmount)
            const amountForPot = amountForSaleRecord; 

            // Add the entry to the splitThePotTickets collection
            await db.collection('splitThePotTickets').add({
                fullName: name, 
                firstName: firstName, 
                phoneNumber: phone, 
                email: email, 
                referrerRefId: referrerRefId || null,
                referrerUid,
                referrerName,
                // Store fee-excluded amount (now cleaned)
                amountPaid: amountForPot, 
                ticketCount: ticketCount, 
                paymentMethod: 'Stripe', 
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                entryType: 'stripe',
                sourceApp: sourceApp || 'YDE Split The Pot (Webhook)' 
            });

            
            const raffleTotalsRef = db.collection('counters').doc('raffle_totals');
            await raffleTotalsRef.set({
                totalTickets: admin.firestore.FieldValue.increment(ticketCount),
                totalAmount: admin.firestore.FieldValue.increment(amountForPot)
            }, { merge: true });

            if (referrerUid) {
                const referrerRef = db.collection('referrers').doc(referrerUid);
                // Use fee-excluded amount for referrer totals
                await referrerRef.set({
                    totalTickets: admin.firestore.FieldValue.increment(ticketCount),
                    totalAmount: admin.firestore.FieldValue.increment(amountForPot)
                }, { merge: true });
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
                // The referrerRefId is already in the PI doc from the callable function
            });
        }

        // 2. Update the main payment intent document status (whether raffle or donation PI status document)
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
        let rolexQuery = db.collection('rolex_tickets');
        
        // If a standard referrer, filter sales to only show their own
        if (isReferrerUser && !isSuperAdminUser) {
            const refId = userData.refId || 'INVALID_REF_ID';
            // Filter by UIDs for raffle (more reliable)
            raffleQuery = raffleQuery.where('referrerUid', '==', uid); 
            // Filter by Ref ID for Rolex (stored as referrerRefId)
            rolexQuery = rolexQuery.where('referrerRefId', '==', refId); 
        } else if (!isSuperAdminUser) {
             // General Admin: Show all raffle sales, but hide rolex/donations
             rolexQuery = rolexQuery.where('status', '==', 'invalid_status_to_hide_from_general_admin');
             
        }

        // 3. Fetch Transaction Data
        const rolexSnapshot = await rolexQuery
            .where('status', 'in', ['paid', 'claimed'])
            .orderBy('timestamp', 'desc').get();
            
        const raffleSnapshot = await raffleQuery
            .orderBy('timestamp', 'desc').get();

        rolexEntries = rolexSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        // Ensure raffle entries include the document ID for the assignment/transfer feature
        raffleEntries = raffleSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })); 

        if (isSuperAdminUser) {
            // Super Admin: Fetch all referrers and all donations
            const referrerSnapshot = await db.collection('referrers').get();
            referrers = referrerSnapshot.docs.map(doc => ({ uid: doc.id, ...doc.data() }));

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
        throw new functions.https.HttpsError('internal', 'An internal error occurred while fetching dashboard data. This is often caused by a missing Firestore composite index.', error.message);
    }
});

/**
 * Callable function to assign or transfer a batch of raffle sales (SplitThePot) to a specific referrer.
 * Requires Super Admin role. This function handles decrementing the old referrer's totals
 * and incrementing the new referrer's totals if a transfer occurs.
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
 * Callable function to assign or transfer a batch of Spin The Wheel (Rolex) sales to a specific referrer.
 * Requires Super Admin role. This function handles decrementing the old referrer's totals
 * and incrementing the new referrer's totals.
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
            const ticketPromises = chunk.map(id => db.collection('rolex_tickets').doc(id).get());
            const ticketSnapshots = await Promise.all(ticketPromises);
            
            let updatedCount = 0;

            ticketSnapshots.forEach(snapshot => {
                if (snapshot.exists) {
                    const ticket = snapshot.data();
                    // Rolex tickets must be 'paid' or 'claimed' (not reserved/expired)
                    if (ticket.status !== 'paid' && ticket.status !== 'claimed') {
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
            message: `Successfully assigned/transferred ${targetTicketCount} Spin The Wheel tickets to ${targetReferrerName} (${refId}).` 
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
    // --- 1. Aggregate NEW Rolex Totals (from rolex_tickets) by RefId ---
    const rolexTicketsSnapshot = await db.collection('rolex_tickets')
        .where('status', 'in', ['paid', 'claimed'])
        .get();

    // Map: { refId: { amount: number, tickets: number } }
    const rolexAggregatesByRefId = new Map();
    
    rolexTicketsSnapshot.forEach(ticketDoc => {
        const ticket = ticketDoc.data();
        const refId = ticket.referrerRefId;
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
 * Callable function to recalculate the Spin The Wheel (Rolex) totals for all referrers.
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
 * This is the function requested for the "recalculate all refers numbers" button.
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
 * FIX: Removed unnecessary Promise and corsHandler wrapper.
 */
exports.claimSpinTicket = functions.https.onCall(async (data, context) => {
    const SOURCE_APP_TAG = 'YDE Free Spin Claim'; 

    const { name } = data;
    const TOTAL_TICKETS = 650;

    if (!name) {
        throw new functions.https.HttpsError('invalid-argument', 'Missing required field: name.');
    }

    const db = admin.firestore();
    let ticketNumber;
    let foundUniqueTicket = false;

    // Retry loop to find an available ticket number
    for (let i = 0; i < TOTAL_TICKETS * 2; i++) {
        const randomTicket = Math.floor(Math.random() * TOTAL_TICKETS) + 1;
        const ticketRef = db.collection('rolex_tickets').doc(randomTicket.toString());

        try {
            await db.runTransaction(async (transaction) => {
                const docSnapshot = await transaction.get(ticketRef);
                if (!docSnapshot.exists) {
                    transaction.set(ticketRef, {
                        status: 'claimed', // Directly claimed (free ticket)
                        timestamp: admin.firestore.FieldValue.serverTimestamp(), // Original creation time
                        name: name,
                        // Free ticket has $0.00 amountPaid
                        amountPaid: 0, 
                        sourceApp: SOURCE_APP_TAG 
                    });
                    foundUniqueTicket = true;
                }
            });

            if (foundUniqueTicket) {
                ticketNumber = randomTicket;
                break;
            }
        } catch (e) {
            console.error("Transaction failed during free ticket claim: ", e);
            // Ignore transient transaction failures and retry
        }
    }

    if (!foundUniqueTicket) {
        throw new functions.https.HttpsError('resource-exhausted', 'All tickets have been claimed. Please try again later.');
    }

    return { success: true, ticketNumber };
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

        // Set custom claims for referrer access
        await admin.auth().setCustomUserClaims(uid, { referrer: true });
        
        const refIdToSave = intendedRefId; 

        await admin.firestore().collection('referrers').doc(uid).set({
            name,
            email,
            refId: refIdToSave, 
            goal: cleanAmount(goal) || 0, // Ensure goal is rounded
            totalTickets: 0, // Split the Pot Tickets
            totalAmount: 0, // Combined Amount (Split the Pot + Rolex) (Base amounts only)
            rolexTicketsTotal: 0, // NEW: Spin the Wheel Tickets
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
