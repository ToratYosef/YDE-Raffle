// Import the functions you need from the SDKs you need
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const cors = require('cors'); 

// IMPORTANT: Initialize the Firebase Admin SDK
admin.initializeApp();

const stripe = require('stripe')(functions.config().stripe.secret_key);

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


// --- PAYMENT INTENT FUNCTIONS ---

/**
 * Firebase Callable Function to create a Stripe PaymentIntent for the Spin to Win game (Rolex).
 */
exports.createSpinPaymentIntent = functions.https.onCall(async (data, context) => {
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
                        transaction.set(ticketRef, {
                            status: 'reserved',
                            timestamp: admin.firestore.FieldValue.serverTimestamp(), 
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

      const firstName = name.split(' ')[0] || name;
      
      try {
        const db = admin.firestore();

        const intentDocRef = db.collection('stripe_payment_intents').doc(paymentIntent.id);
        const intentDoc = await intentDocRef.get();
        if (intentDoc.data() && intentDoc.data().webhookProcessed) {
          return res.status(200).send('Webhook event already processed.');
        }
        
        // --- Shared variables ---
        const amountPaid = paymentIntent.amount / 100;
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
        
        // --- Rolex Ticket Processing ---
        if (entryType === 'rolex') {
            const rolexTicketRef = db.collection('rolex_tickets').doc(ticketNumber);
            
            await rolexTicketRef.update({
                status: 'paid',
                paymentIntentId: paymentIntent.id,
                name,
                firstName: firstName, 
                email,
                phoneNumber: phone, 
                amountPaid: amountPaid, 
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                sourceApp: sourceApp || 'YDE Spin The Wheel (Webhook)',
                referrerRefId: referrerRefId || null 
            });

            // NEW: Update Referrer Stats for Rolex Ticket
            if (referrerUid) {
                const referrerRef = db.collection('referrers').doc(referrerUid);
                
                // Atomically increment the rolexTicketsTotal (new dedicated field) and the general totalAmount
                await referrerRef.set({
                    rolexTicketsTotal: admin.firestore.FieldValue.increment(1), 
                    totalAmount: admin.firestore.FieldValue.increment(amountPaid) 
                }, { merge: true });
            }
        } 
        
        // --- Raffle (Split The Pot) Processing ---
        else if (entryType === 'raffle') {
            const ticketCount = parseInt(ticketsBought); 
            const amountForPot = parseFloat(baseAmount);

            await db.collection('splitThePotTickets').add({
              fullName: name, 
              firstName: firstName, 
              phoneNumber: phone, 
              email: email, 
              referrerRefId: referrerRefId || null,
              referrerUid,
              referrerName,
              amountPaid: amountPaid, 
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
                // totalTickets and totalAmount here are for Split the Pot sales
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
                amountPaid: amountPaid, 
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
                        const tickets = sale.ticketCount || 0;
                        const amount = sale.amountPaid || 0; // Note: For Split the Pot, baseAmount is often used here, but using amountPaid for consistency/simplicity.

                        // A) Decrement (Transfer scenario)
                        if (oldRefUid) {
                            // Add to decrement map for atomic update later
                            const currentDecrement = oldReferrerDecrementMap.get(oldRefUid) || { tickets: 0, amount: 0 };
                            currentDecrement.tickets += tickets;
                            currentDecrement.amount += amount;
                            oldReferrerDecrementMap.set(oldRefUid, currentDecrement);
                        }

                        // B) Increment (Always happens for the target referrer)
                        targetTicketsIncrement += tickets;
                        targetAmountIncrement += amount;

                        // C) Update Sale Document in the Batch
                        batch.update(snapshot.ref, {
                            referrerRefId: refId,
                            referrerUid: targetReferrerUid,
                            referrerName: targetReferrerName,
                            updatedAt: admin.firestore.FieldValue.serverTimestamp()
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
            // totalTickets and totalAmount are for Split the Pot sales
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
    // 1. Security Check
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
                    const amount = ticket.amountPaid || 0;

                    // Only process if the ticket is currently assigned to a DIFFERENT referrer 
                    // OR if it is unassigned (oldRefId is null).
                    if (oldRefId !== refId) { 
                        
                        // A) Decrement (Transfer scenario)
                        if (oldRefId) {
                            // Add to decrement map for atomic update later (Rolex tickets are always 1 ticket count)
                            const currentDecrement = oldReferrerDecrementMap.get(oldRefId) || { tickets: 0, amount: 0 };
                            currentDecrement.tickets += 1;
                            currentDecrement.amount += amount;
                            oldReferrerDecrementMap.set(oldRefId, currentDecrement);
                        }

                        // B) Increment (Always happens for the target referrer)
                        targetAmountIncrement += amount;
                        targetTicketCount += 1;

                        // C) Update Ticket Document in the Batch
                        batch.update(snapshot.ref, {
                            referrerRefId: refId,
                            updatedAt: admin.firestore.FieldValue.serverTimestamp()
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


/**
 * Callable function to recalculate the Spin The Wheel (Rolex) totals for all referrers.
 * This should run only for Super Admin.
 */
exports.recalculateRolexTotals = functions.https.onCall(async (data, context) => {
    if (!isSuperAdmin(context)) {
        throw new functions.https.HttpsError('permission-denied', 'You must be a super admin to run this function.');
    }

    const db = admin.firestore();
    const batch = db.batch();
    
    // Step 1: Clear existing Rolex totals on all referrer documents
    const referrersSnapshot = await db.collection('referrers').get();
    
    referrersSnapshot.forEach(doc => {
        const referrerRef = doc.ref;
        // We set the Rolex fields to 0, and subtract the existing total from the general totalAmount
        const currentData = doc.data();
        const currentRolexTotal = currentData.rolexTicketsTotal || 0;
        
        // Setting fields to 0, and decrementing the amount by the Rolex portion
        batch.set(referrerRef, {
            rolexTicketsTotal: 0,
            totalAmount: admin.firestore.FieldValue.increment(-currentRolexTotal * 100) // Assuming each ticket is $100 for simplicity in recalculation, adjust if necessary
        }, { merge: true });
    });
    
    await batch.commit();

    // Step 2: Recalculate and aggregate new totals
    const rolexTicketsSnapshot = await db.collection('rolex_tickets')
        .where('status', 'in', ['paid', 'claimed'])
        .get();

    // Map to hold new aggregated totals for each referrer's refId: { totalAmount: number, rolexTickets: number }
    const referrerAggregates = new Map();
    
    rolexTicketsSnapshot.forEach(ticketDoc => {
        const ticket = ticketDoc.data();
        const refId = ticket.referrerRefId;
        const amountPaid = ticket.amountPaid || 0; // Use actual amount paid

        if (refId) {
            const current = referrerAggregates.get(refId) || { amount: 0, tickets: 0 };
            current.amount += amountPaid;
            current.tickets += 1;
            referrerAggregates.set(refId, current);
        }
    });

    // Step 3: Apply aggregated totals to referrer documents
    const updateBatch = db.batch();
    let totalUpdatedReferrers = 0;
    
    for (const [refId, totals] of referrerAggregates.entries()) {
        const referrerQuerySnapshot = await db.collection('referrers')
            .where('refId', '==', refId)
            .limit(1)
            .get();

        if (!referrerQuerySnapshot.empty) {
            const referrerRef = referrerQuerySnapshot.docs[0].ref;
            
            updateBatch.set(referrerRef, {
                rolexTicketsTotal: admin.firestore.FieldValue.increment(totals.tickets),
                totalAmount: admin.firestore.FieldValue.increment(totals.amount)
            }, { merge: true });
            totalUpdatedReferrers++;
        }
    }
    
    await updateBatch.commit();


    return {
        success: true,
        message: `Rolex Totals successfully updated for ${totalUpdatedReferrers} referrers. Total Rolex tickets found: ${rolexTicketsSnapshot.size}.`
    };
});

/**
 * Firebase Callable Function to recalculate the global counters.
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
        fullName: name, 
        firstName: firstName, 
        email: email || null,
        phoneNumber: phone || null, 
        ticketCount: ticketCount, 
        amountPaid: amountPaid, 
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

                const originalData = docSnapshot.data();
                const originalTickets = originalData.ticketCount || 0;
                const originalAmount = originalData.amountPaid || 0;

                const updatedTickets = updatedData.ticketCount;
                const updatedAmount = updatedData.amountPaid;
                const updatedFullName = updatedData.fullName || updatedData.name.split(' ')[0] || updatedData.name; 

                const ticketDiff = updatedTickets - originalTickets;
                const amountDiff = updatedAmount - originalAmount;

                await docRef.update({
                    fullName: updatedFullName, 
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
                    // totalTickets and totalAmount here are for Split the Pot sales
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
    if (!isSuperAdmin(context)) {
        throw new functions.https.HttpsError('permission-denied', 'You must be a super admin to delete entries.');
    }
    
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
                    // totalTickets and totalAmount here are for Split the Pot sales
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
            goal: goal || 0, 
            totalTickets: 0, // Split the Pot Tickets
            totalAmount: 0, // Combined Amount (Split the Pot + Rolex)
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
