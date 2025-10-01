const functions = require('firebase-functions');
const admin = require('firebase-admin');
const cors = require('cors'); 

const stripe = require('stripe')(functions.config().stripe.secret_key);

admin.initializeApp();

const corsHandler = cors({
  origin: [
    'https://yderaffle.web.app',
    'https://www.yderaffle.web.app'
  ],
});

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

// --- NEW CLICK TRACKING FUNCTION ---

/**
 * Callable function to track a click on a referral link.
 * NOTE: This function allows unauthenticated calls to track public clicks.
 */
exports.trackRefLinkClick = functions.https.onCall(async (data, context) => {
    const { refId } = data;

    if (!refId) {
        // Return success but log a warning if refId is missing
        return { success: true, message: "Click not tracked: Missing refId." };
    }

    const db = admin.firestore();
    
    try {
        // Find the referrer by refId in the 'referrers' collection
        // CRITICAL: This query requires a composite index on ['refId']
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
            lastClickTimestamp: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        return { success: true, message: `Click tracked for referrer: ${refId}` };

    } catch (error) {
        console.error(`Error tracking click for ${refId}:`, error);
        // Do not throw HttpsError for tracking, just return a benign message
        return { success: false, message: "Failed to track click due to server error." };
    }
});


// --- TICKET CLEANUP FUNCTIONS ---

/**
 * Scheduled function to remove reserved Rolex tickets older than 5 minutes.
 * Runs every 5 minutes to clean up stale reservations.
 */
exports.cleanupReservedTickets = functions.pubsub.schedule('every 5 minutes').onRun(async (context) => {
    const db = admin.firestore();
    // 5 minutes in milliseconds (Cleanup duration)
    const fiveMinutesInMs = 5 * 60 * 1000; 
    const fiveMinutesAgo = new Date(Date.now() - fiveMinutesInMs); 

    try {
        // NOTE: This query requires a composite index on ['status', 'timestamp']
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
 * Requires Super Admin role. (Security updated)
 */
exports.getReservedTicketCounts = functions.https.onCall(async (data, context) => {
    if (!isSuperAdmin(context)) { // REQUIRES SUPER ADMIN
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
            const timestamp = ticket.timestamp.toDate();

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
 * Requires Super Admin role. (Security updated)
 */
exports.deleteExpiredReservedTickets = functions.https.onCall(async (data, context) => {
    if (!isSuperAdmin(context)) { // REQUIRES SUPER ADMIN
        throw new functions.https.HttpsError('permission-denied', 'Access denied. Requires Super Admin role.');
    }

    const db = admin.firestore();
    const fiveMinutesInMs = 5 * 60 * 1000;
    const fiveMinutesAgo = new Date(Date.now() - fiveMinutesInMs); 

    try {
        // CRITICAL: This query requires a composite index on ['status', 'timestamp']
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


// --- PAYMENT INTENT FUNCTIONS ---

/**
 * Firebase Callable Function to create a Stripe PaymentIntent for the Spin to Win game (Rolex).
 * UPDATED: Uses firstName, phoneNumber, and amountPaid data structure.
 */
exports.createSpinPaymentIntent = functions.https.onCall(async (data, context) => {
    let ticketNumber;
    const SOURCE_APP_TAG = 'YDE Spin The Wheel';

    try {
        const { name, email, phone, referral } = data;
        const TOTAL_TICKETS = 650;
        
        // Extract first name for new structure
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
                        transaction.set(ticketRef, {
                            status: 'reserved',
                            timestamp: admin.firestore.FieldValue.serverTimestamp(), 
                            name: name,
                            firstName: firstName, // New field based on requested structure
                            email: email,
                            phoneNumber: phone, // Renamed field
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
                console.error("Transaction failed: ", e);
            }
        }

        if (!foundUniqueTicket) {
            throw new functions.https.HttpsError('resource-exhausted', 'All tickets have been claimed. Please try again later.');
        }

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
                ticketsBought: 1,
                ticketNumber: ticketNumber,
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
                // If payment creation fails, remove the reserved ticket immediately
                await admin.firestore().collection('rolex_tickets').doc(ticketNumber.toString()).delete();
            } catch (cleanupError) {
                console.error('Failed to clean up reserved ticket:', cleanupError);
            }
        }
        if (error.code && error.message) {
             throw new functions.https.HttpsError(error.code, error.message);
        } else {
             throw new functions.https.HttpsError('internal', 'Failed to create PaymentIntent.');
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

        if (!chargedAmount || !baseAmount || !ticketsBought || !name || !email || !phone) {
            throw new functions.https.HttpsError('invalid-argument', 'Missing required fields: chargedAmount, baseAmount, ticketsBought, name, email, or phone.');
        }

        const amountToChargeInCents = Math.round(parseFloat(chargedAmount) * 100);

        const paymentIntent = await stripe.paymentIntents.create({
            amount: amountToChargeInCents,
            currency: 'usd',
            description: `YDE Split The Pot - ${ticketsBought} Tickets`, 
            payment_method_types: ['card'],
            metadata: {
                name,
                email,
                phone,
                ticketsBought,
                baseAmount,
                referrerRefId: referral || '',
                entryType: 'raffle',
                sourceApp: SOURCE_APP_TAG 
            },
        });

        await admin.firestore().collection('stripe_payment_intents').doc(paymentIntent.id).set({
            chargedAmount: chargedAmount,
            baseAmount: baseAmount,
            ticketsBought,
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
        const { amount, name, email, phone } = data;

        if (!amount || !name || !email || !phone) {
            throw new functions.https.HttpsError('invalid-argument', 'Missing required fields: amount, name, email, or phone.');
        }

        const amountInCents = Math.round(parseFloat(amount) * 100);

        const paymentIntent = await stripe.paymentIntents.create({
            amount: amountInCents,
            currency: 'usd',
            description: `YDE Donation`, 
            payment_method_types: ['card'],
            metadata: {
                name,
                email,
                phone,
                amount,
                entryType: 'donation',
                sourceApp: SOURCE_APP_TAG 
            },
        });

        await admin.firestore().collection('stripe_donation_payment_intents').doc(paymentIntent.id).set({
            name,
            email,
            phone,
            amount,
            status: 'created',
            sourceApp: SOURCE_APP_TAG, 
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return { clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id };

    } catch (error) {
        console.error('Error creating Stripe PaymentIntent for donation:', error);
        throw new functions.https.HttpsError('internal', 'Failed to create donation PaymentIntent.');
    }
});

/**
 * Stripe Webhook Listener (HTTP Request Function).
 * UPDATED: Raffle processing now saves the customer's full name under the 'fullName' field.
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

      const { name, email, phone, ticketsBought, baseAmount, referrerRefId, ticketNumber, entryType, sourceApp } = paymentIntent.metadata;

      // Extract first name for the new structure (used for Spin Wheel and kept for consistency)
      const firstName = name.split(' ')[0] || name;
      
      try {
        const db = admin.firestore();

        const intentDocRef = db.collection('stripe_payment_intents').doc(paymentIntent.id);
        const intentDoc = await intentDocRef.get();
        if (intentDoc.data() && intentDoc.data().webhookProcessed) {
          return res.status(200).send('Webhook event already processed.');
        }

        // --- Rolex Ticket Processing ---
        if (entryType === 'rolex') {
            const rolexTicketRef = db.collection('rolex_tickets').doc(ticketNumber);
            await rolexTicketRef.update({
                status: 'paid',
                paymentIntentId: paymentIntent.id,
                name,
                firstName: firstName, // Added for consistency
                email,
                phoneNumber: phone, // Renamed field
                amountPaid: paymentIntent.amount / 100, // Renamed field
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                sourceApp: sourceApp || 'YDE Spin The Wheel (Webhook)',
                referrerRefId: referrerRefId || null 
            });
        } 
        
        // --- Raffle (Split The Pot) Processing ---
        else if (entryType === 'raffle') {
            const ticketCount = parseInt(ticketsBought); // New field name
            const amountPaid = paymentIntent.amount / 100; // New field name

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

            // Using the requested new document structure for splitThePotTickets
            await db.collection('splitThePotTickets').add({
              fullName: name, // ADDED: Saves the full name from Stripe metadata
              firstName: firstName, // Kept for consistency
              phoneNumber: phone, // New field name
              email: email, // Added for completeness, if available
              referrerRefId: referrerRefId || null,
              referrerUid,
              referrerName,
              amountPaid: amountPaid, // New field name
              ticketCount: ticketCount, // New field name
              paymentMethod: 'Stripe', // Added paymentMethod
              timestamp: admin.firestore.FieldValue.serverTimestamp(),
              entryType: 'stripe',
              sourceApp: sourceApp || 'YDE Split The Pot (Webhook)' 
            });

            const amountForPot = parseFloat(baseAmount);
            const raffleTotalsRef = db.collection('counters').doc('raffle_totals');
            await raffleTotalsRef.set({
                totalTickets: admin.firestore.FieldValue.increment(ticketCount),
                totalAmount: admin.firestore.FieldValue.increment(amountForPot)
            }, { merge: true });

            if (referrerUid) {
                const referrerRef = db.collection('referrers').doc(referrerUid);
                await referrerRef.set({
                    totalTickets: admin.firestore.FieldValue.increment(ticketCount),
                    totalAmount: admin.firestore.FieldValue.increment(amountForPot)
                }, { merge: true });
            }
        } 
        
        // --- Donation Processing ---
        else if (entryType === 'donation') {
            const donationIntentRef = db.collection('stripe_donation_payment_intents').doc(paymentIntent.id);
            await donationIntentRef.update({
                status: 'succeeded',
                amountPaid: paymentIntent.amount / 100, // New field name
                webhookProcessed: true,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                sourceApp: sourceApp || 'YDE Donation (Webhook)' 
            });
        }

        await intentDocRef.update({
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
 * Callable function to create a new referrer account.
 * Requires Super Admin role.
 */
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


// --- DASHBOARD DATA FUNCTION (REPLACING getReferrerDashboardData) ---

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
        }

        // 3. Fetch Transaction Data
        // Filter to only show 'paid' or 'claimed' entries for display, ignoring 'reserved'
        // CRITICAL: All these complex queries require composite indexes (see step 2 below)
        const rolexSnapshot = await rolexQuery
            .where('status', 'in', ['paid', 'claimed'])
            .orderBy('timestamp', 'desc').get();
            
        const raffleSnapshot = await raffleQuery
            .orderBy('timestamp', 'desc').get();

        rolexEntries = rolexSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
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
        // The error here is likely due to a missing index, which presents as an 'internal' error.
        throw new functions.https.HttpsError('internal', 'An internal error occurred while fetching dashboard data. This is often caused by a missing Firestore composite index.', error.message);
    }
});


/**
 * Firebase Callable Function to recalculate the global counters.
 * Requires Super Admin role.
 */
exports.recalculateRaffleTotals = functions.https.onCall(async (data, context) => {
    if (!isSuperAdmin(context)) {
        throw new functions.https.HttpsError('permission-denied', 'You must be a super admin to run this function.');
    }

    const db = admin.firestore();
    let totalTickets = 0;
    let totalAmount = 0;

    try {
        const raffleEntriesSnapshot = await db.collection('splitThePotTickets').get();
        if (raffleEntriesSnapshot.empty) {
            console.log("No raffle entries found to recalculate totals.");
        } else {
            raffleEntriesSnapshot.forEach(doc => {
                const entry = doc.data();
                if (typeof entry.ticketCount === 'number') {
                    totalTickets += entry.ticketCount;
                }
                if (typeof entry.amountPaid === 'number') {
                    totalAmount += entry.amountPaid;
                }
            });
        }
        
        const raffleTotalsRef = db.collection('counters').doc('raffle_totals');
        await raffleTotalsRef.set({
            totalTickets: totalTickets,
            totalAmount: totalAmount
        }, { merge: true });

        return {
            success: true,
            message: `Counters successfully updated. Total tickets: ${totalTickets}, Total amount: $${totalAmount.toFixed(2)}.`
        };

    } catch (error) {
        console.error('Error in recalculateRaffleTotals:', error);
        throw new functions.https.HttpsError('internal', 'Failed to recalculate totals...', error.message);
    }
});

/**
 * Callable function to add a manual raffle entry.
 * UPDATED: Now saves the customer's full name under the 'fullName' field.
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
    const ticketCount = parseInt(ticketsBought, 10);
    const amountPaid = parseFloat(amount);
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
        fullName: name, // ADDED: Saves the full name from the manual form input
        firstName: firstName, // Kept for consistency
        email: email || null,
        phoneNumber: phone || null, // New field name
        ticketCount: ticketCount, // New field name
        amountPaid: amountPaid, // New field name
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
    // UPDATED: Use isSuperAdmin check
    if (!isSuperAdmin(context)) {
        throw new functions.https.HttpsError('permission-denied', 'You must be a super admin to update entries.');
    }
    
    // Implementation uses old security helper, wrapping in corsHandler for compatibility.
    return new Promise((resolve, reject) => {
        corsHandler(context.req, context.res, async () => {
            if (!isSuperAdmin(context)) {
                return reject(new functions.https.HttpsError('permission-denied', 'You must be a super admin to update entries.'));
            }
            
            const { entryId, updatedData } = data;
            const db = admin.firestore();

            try {
                const docRef = db.collection('splitThePotTickets').doc(entryId);
                const docSnapshot = await docRef.get();
                if (!docSnapshot.exists) {
                    return reject(new functions.https.HttpsError('not-found', 'Entry not found.'));
                }

                // NOTE: This original code uses old field names ('Tickets', '$'). 
                // Updating to use new field names ('ticketCount', 'amountPaid').
                const originalData = docSnapshot.data();
                const originalTickets = originalData.ticketCount || 0;
                const originalAmount = originalData.amountPaid || 0;

                const updatedTickets = updatedData.ticketCount;
                const updatedAmount = updatedData.amountPaid;
                const updatedFullName = updatedData.fullName || updatedData.name.split(' ')[0] || updatedData.name; // Ensure full name is preserved if possible

                const ticketDiff = updatedTickets - originalTickets;
                const amountDiff = updatedAmount - originalAmount;

                await docRef.update({
                    fullName: updatedFullName, // Added to update logic
                    firstName: updatedData.firstName,
                    email: updatedData.email,
                    phoneNumber: updatedData.phoneNumber,
                    ticketCount: updatedTickets,
                    amountPaid: updatedAmount,
                });

                const raffleTotalsRef = db.collection('counters').doc('raffle_totals');
                await raffleTotalsRef.set({
                    totalTickets: admin.firestore.FieldValue.increment(ticketDiff),
                    totalAmount: admin.firestore.FieldValue.increment(amountDiff)
                }, { merge: true });

                if (originalData.referrerUid) {
                    const referrerRef = db.collection('referrers').doc(originalData.referrerUid);
                    await referrerRef.set({
                        totalTickets: admin.firestore.FieldValue.increment(ticketDiff),
                        totalAmount: admin.firestore.FieldValue.increment(amountDiff)
                    }, { merge: true });
                }

                resolve({ success: true, message: "Entry updated successfully." });
            } catch (error) {
                console.error("Error updating entry:", error);
                reject(new functions.https.HttpsError('internal', 'An internal error occurred.', error.message));
            }
        });
    });
});


/**
 * Callable function to delete a raffle entry.
 * Requires Super Admin role.
 */
exports.deleteRaffleEntry = functions.https.onCall(async (data, context) => {
    // UPDATED: Use isSuperAdmin check
    if (!isSuperAdmin(context)) {
        throw new functions.https.HttpsError('permission-denied', 'You must be a super admin to delete entries.');
    }
    
    // Implementation uses old security helper, wrapping in corsHandler for compatibility.
    return new Promise((resolve, reject) => {
        corsHandler(context.req, context.res, async () => {
            if (!isSuperAdmin(context)) {
                return reject(new functions.https.HttpsError('permission-denied', 'You must be a super admin to delete entries.'));
            }
            
            const { entryId } = data;
            const db = admin.firestore();

            try {
                const docRef = db.collection('splitThePotTickets').doc(entryId);
                const docSnapshot = await docRef.get();
                if (!docSnapshot.exists) {
                    return reject(new functions.https.HttpsError('not-found', 'Entry not found.'));
                }

                // NOTE: This original code uses old field names ('Tickets', '$'). 
                // Updating to use new field names ('ticketCount', 'amountPaid').
                const entryData = docSnapshot.data();
                const tickets = entryData.ticketCount || 0;
                const amount = entryData.amountPaid || 0;
                const referrerUid = entryData.referrerUid;

                await docRef.delete();

                const raffleTotalsRef = db.collection('counters').doc('raffle_totals');
                await raffleTotalsRef.set({
                    totalTickets: admin.firestore.FieldValue.increment(-tickets),
                    totalAmount: admin.firestore.FieldValue.increment(-amount)
                }, { merge: true });

                if (referrerUid) {
                    const referrerRef = db.collection('referrers').doc(referrerUid);
                    await referrerRef.set({
                        totalTickets: admin.firestore.FieldValue.increment(-tickets),
                        totalAmount: admin.firestore.FieldValue.increment(-amount)
                    }, { merge: true });
                }

                resolve({ success: true, message: "Entry deleted successfully." });
            } catch (error) {
                console.error("Error deleting entry:", error);
                reject(new functions.https.HttpsError('internal', 'An internal error occurred.', error.message));
            }
        });
    });
});

/**
 * Callable function to claim a free spin-to-win ticket.
 */
exports.claimSpinTicket = functions.https.onCall(async (data, context) => {
    const SOURCE_APP_TAG = 'YDE Free Spin Claim'; 

    return new Promise((resolve, reject) => {
        corsHandler(context.req, context.res, async () => {
            const { name } = data;
            const TOTAL_TICKETS = 650;

            if (!name) {
                return reject(new functions.https.HttpsError('invalid-argument', 'Missing required field: name.'));
            }

            const db = admin.firestore();
            let ticketNumber;
            let foundUniqueTicket = false;

            for (let i = 0; i < TOTAL_TICKETS * 2; i++) {
                const randomTicket = Math.floor(Math.random() * TOTAL_TICKETS) + 1;
                const ticketRef = db.collection('rolex_tickets').doc(randomTicket.toString());

                try {
                    const doc = await db.runTransaction(async (transaction) => {
                        const docSnapshot = await transaction.get(ticketRef);
                        if (!docSnapshot.exists) {
                            transaction.set(ticketRef, {
                                status: 'claimed',
                                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                                name: name,
                                sourceApp: SOURCE_APP_TAG 
                            });
                            foundUniqueTicket = true;
                            return docSnapshot;
                        } else {
                            return null;
                        }
                    });

                    if (foundUniqueTicket) {
                        ticketNumber = randomTicket;
                        break;
                    }
                } catch (e) {
                    console.error("Transaction failed: ", e);
                }
            }

            if (!foundUniqueTicket) {
                return reject(new functions.https.HttpsError('resource-exhausted', 'All tickets have been claimed. Please try again later.'));
            }

            resolve({ success: true, ticketNumber });
        });
    });
});
/**
 * Callable function to create a new referrer account.
 * ***CRITICAL FIX: Now saves the client-provided intendedRefId (e.g., SaulS)***
 */
exports.createReferrer = functions.https.onCall(async (data, context) => {
    if (!isSuperAdmin(context)) {
        throw new functions.https.HttpsError('permission-denied', 'Only Super Admins can create new referrers.');
    }
    // PULL the intendedRefId from the client tool's payload
    const { email, password, name, goal, intendedRefId } = data; 

    if (!email || !password || !name || !intendedRefId) { // Check that the intendedRefId is present
        throw new functions.https.HttpsError('invalid-argument', 'Missing required fields (email, password, name, or intendedRefId).');
    }

    try {
        const userRecord = await admin.auth().createUser({ email, password, displayName: name });
        const uid = userRecord.uid;

        // Set custom claims for referrer access
        await admin.auth().setCustomUserClaims(uid, { referrer: true });
        
        // --- FIX IMPLEMENTED HERE ---
        const refIdToSave = intendedRefId; // Use the value passed from the bulk creator (e.g., 'SaulS')

        await admin.firestore().collection('referrers').doc(uid).set({
            name,
            email,
            refId: refIdToSave, // This is now the name-based RefID
            goal: goal || 0, // Goal tracking
            totalTickets: 0,
            totalAmount: 0,
            clickCount: 0, // NEW: Initialize click count
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Return the correct Ref ID to the client tool for display
        return { success: true, message: `Referrer ${name} created successfully with Ref ID: ${refIdToSave}.` };
    } catch (error) {
        console.error('Error creating new referrer:', error);
        throw new functions.https.HttpsError('internal', 'Failed to create referrer.', error.message);
    }
});
