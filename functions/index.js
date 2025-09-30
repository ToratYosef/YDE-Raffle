const functions = require('firebase-functions');
const admin = require('firebase-admin');
const cors = require('cors'); // Re-added cors package

// NOTE: Replace this with your actual Stripe initialization if this is not a mock environment
const stripe = require('stripe')(functions.config().stripe.secret_key);

admin.initializeApp();

// The manual CORS handler is re-added as requested for the legacy Promise-wrapped functions.
const corsHandler = cors({
  origin: [
    'https://yderaffle.web.app',
    'https://www.yderaffle.web.app'
  ],
});

/**
 * NEW: Scheduled function to remove reserved Rolex tickets older than 10 minutes.
 * Runs every 5 minutes to clean up stale reservations.
 */
exports.cleanupReservedTickets = functions.pubsub.schedule('every 5 minutes').onRun(async (context) => {
    const db = admin.firestore();
    // 10 minutes in milliseconds
    const tenMinutesInMs = 10 * 60 * 1000; 
    const tenMinutesAgo = new Date(Date.now() - tenMinutesInMs); 

    console.log(`Starting cleanup of reserved tickets older than: ${tenMinutesAgo.toISOString()}`);

    try {
        // Find tickets that are 'reserved' AND were reserved before 10 minutes ago
        const reservedTicketsSnapshot = await db.collection('rolex_tickets')
            .where('status', '==', 'reserved')
            // Firestore must be queried by the timestamp field, which is set as serverTimestamp()
            .where('timestamp', '<', tenMinutesAgo) 
            .get();

        if (reservedTicketsSnapshot.empty) {
            console.log('No expired reserved tickets found.');
            return null;
        }

        const batch = db.batch();
        reservedTicketsSnapshot.forEach(doc => {
            console.log(`Deleting expired reserved ticket: ${doc.id}`);
            batch.delete(doc.ref);
        });

        await batch.commit();
        console.log(`Successfully deleted ${reservedTicketsSnapshot.size} expired reserved tickets.`);
        return null;

    } catch (error) {
        console.error('Error during reserved ticket cleanup:', error);
        return null;
    }
});


/**
 * Firebase Callable Function to create a Stripe PaymentIntent for the Spin to Win game (Rolex).
 * UPDATED: Now handles and saves the referrerRefId to Firestore and Stripe metadata.
 */
exports.createSpinPaymentIntent = functions.https.onCall(async (data, context) => {
    let ticketNumber;
    const SOURCE_APP_TAG = 'YDE Spin The Wheel';

    try {
        // ADDED referral here
        const { name, email, phone, referral } = data;
        const TOTAL_TICKETS = 650;

        if (!name || !email || !phone) {
            throw new functions.https.HttpsError('invalid-argument', 'Missing required fields: name, email, or phone.');
        }

        const db = admin.firestore();
        let foundUniqueTicket = false;

        // Loop to find a unique ticket number
        for (let i = 0; i < TOTAL_TICKETS * 2; i++) { // A safety net loop
            const randomTicket = Math.floor(Math.random() * TOTAL_TICKETS) + 1;
            const ticketRef = db.collection('rolex_tickets').doc(randomTicket.toString());

            try {
                // Check if the ticket number is already taken using a transaction
                await db.runTransaction(async (transaction) => {
                    const docSnapshot = await transaction.get(ticketRef);
                    if (!docSnapshot.exists) {
                        transaction.set(ticketRef, {
                            status: 'reserved',
                            // The serverTimestamp is crucial for the cleanup function to work
                            timestamp: admin.firestore.FieldValue.serverTimestamp(), 
                            name: name,
                            email: email,
                            phone: phone,
                            sourceApp: SOURCE_APP_TAG,
                            referrerRefId: referral || null // SAVING REFERRAL TO RESERVED TICKET
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
                // Continue loop to try again
            }
        }

        if (!foundUniqueTicket) {
            throw new functions.https.HttpsError('resource-exhausted', 'All tickets have been claimed. Please try again later.');
        }

        const amountInCents = ticketNumber * 100;

        const paymentIntent = await stripe.paymentIntents.create({
            amount: amountInCents,
            currency: 'usd',
            description: `YDE Spin The Wheel - Ticket ${ticketNumber}`, // Added payment description
            metadata: {
                name,
                email,
                phone,
                ticketsBought: 1,
                ticketNumber: ticketNumber,
                entryType: 'rolex',
                sourceApp: SOURCE_APP_TAG,
                referrerRefId: referral || null // SAVING REFERRAL TO STRIPE METADATA
            },
        });

        return { clientSecret: paymentIntent.client_secret, ticketNumber };

    } catch (error) {
        console.error('Error creating Stripe PaymentIntent for spin game:', error);
        // Clean up the reserved ticket if payment intent creation fails
        if (ticketNumber) {
            try {
                // If payment creation fails, remove the reserved ticket immediately
                await admin.firestore().collection('rolex_tickets').doc(ticketNumber.toString()).delete();
            } catch (cleanupError) {
                console.error('Failed to clean up reserved ticket:', cleanupError);
            }
        }
        // Return a proper HttpsError to the client
        if (error.code && error.message) {
             throw new functions.https.HttpsError(error.code, error.message);
        } else {
             throw new functions.https.HttpsError('internal', 'Failed to create PaymentIntent.');
        }
    }
});

/**
 * Firebase Callable Function to create a Stripe PaymentIntent for the raffle (Split The Pot).
 * Added sourceApp tag and payment description.
 */
exports.createStripePaymentIntent = functions.https.onCall(async (data, context) => {
    const SOURCE_APP_TAG = 'YDE Split The Pot'; // Added tag

    try {
        const { chargedAmount, baseAmount, ticketsBought, name, email, phone, referral } = data;

        if (!chargedAmount || !baseAmount || !ticketsBought || !name || !email || !phone) {
            throw new functions.https.HttpsError('invalid-argument', 'Missing required fields: chargedAmount, baseAmount, ticketsBought, name, email, or phone.');
        }

        const amountToChargeInCents = Math.round(parseFloat(chargedAmount) * 100);

        const paymentIntent = await stripe.paymentIntents.create({
            amount: amountToChargeInCents,
            currency: 'usd',
            description: `YDE Split The Pot - ${ticketsBought} Tickets`, // Added payment description
            metadata: {
                name,
                email,
                phone,
                ticketsBought,
                baseAmount,
                referrerRefId: referral || '',
                entryType: 'raffle',
                sourceApp: SOURCE_APP_TAG // Added tag to Stripe metadata
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
            sourceApp: SOURCE_APP_TAG, // Added tag to Firestore record
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // The return value is automatically wrapped in a Promise by the onCall function.
        return { clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id };

    } catch (error) {
        console.error('Error creating Stripe PaymentIntent:', error);
        // Properly throw an HttpsError to the client.
        throw new functions.https.HttpsError('internal', 'Failed to create PaymentIntent.');
    }
});

/**
 * NEW: Firebase Callable Function to create a Stripe PaymentIntent for a general donation.
 * Added sourceApp tag and payment description.
 */
exports.createDonationPaymentIntent = functions.https.onCall(async (data, context) => {
    const SOURCE_APP_TAG = 'YDE Donation'; // Added tag

    try {
        const { amount, name, email, phone } = data;

        if (!amount || !name || !email || !phone) {
            throw new functions.https.HttpsError('invalid-argument', 'Missing required fields: amount, name, email, or phone.');
        }

        const amountInCents = Math.round(parseFloat(amount) * 100);

        const paymentIntent = await stripe.paymentIntents.create({
            amount: amountInCents,
            currency: 'usd',
            description: `YDE Donation`, // Added payment description
            metadata: {
                name,
                email,
                phone,
                amount,
                entryType: 'donation',
                sourceApp: SOURCE_APP_TAG // Added tag to Stripe metadata
            },
        });

        await admin.firestore().collection('stripe_donation_payment_intents').doc(paymentIntent.id).set({
            name,
            email,
            phone,
            amount,
            status: 'created',
            sourceApp: SOURCE_APP_TAG, // Added tag to Firestore record
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
 * UPDATED: Ensures referrerRefId is saved when Rolex ticket is marked 'paid'.
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
      console.log('PaymentIntent Succeeded:', paymentIntent.id);

      // Destructure referrerRefId from metadata
      const { name, email, phone, ticketsBought, baseAmount, referrerRefId, ticketNumber, entryType, sourceApp } = paymentIntent.metadata;

      try {
        const db = admin.firestore();

        // Check if the webhook has already been processed for this intent
        const intentDocRef = db.collection('stripe_payment_intents').doc(paymentIntent.id);
        const intentDoc = await intentDocRef.get();
        if (intentDoc.data() && intentDoc.data().webhookProcessed) {
          console.log('PaymentIntent already processed:', paymentIntent.id);
          return res.status(200).send('Webhook event already processed.');
        }

        // Handle different entry types based on metadata
        if (entryType === 'rolex') {
            const rolexTicketRef = db.collection('rolex_tickets').doc(ticketNumber);
            // It is safe to use set or update here. If the ticket was cleaned up by the cron job 
            // before the payment succeeded, this will re-create it with the 'paid' status.
            await rolexTicketRef.set({ 
                status: 'paid',
                paymentIntentId: paymentIntent.id,
                name,
                email,
                phone,
                amountPaid: paymentIntent.amount / 100,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                sourceApp: sourceApp || 'YDE Spin The Wheel (Webhook)',
                referrerRefId: referrerRefId || null // ENSURING REFERRAL IS SAVED ON PAYMENT SUCCESS
            }, { merge: true }); 
            console.log(`Successfully processed Rolex Ticket ${ticketNumber}.`);
        } else if (entryType === 'raffle') {
            const tickets = parseInt(ticketsBought);
            const chargedAmount = paymentIntent.amount / 100;
            const amountForPot = parseFloat(baseAmount);

            let referrerUid = null;
            if (referrerRefId) {
                const referrerQuerySnapshot = await db.collection('referrers')
                    .where('refId', '==', referrerRefId)
                    .limit(1)
                    .get();

                if (!referrerQuerySnapshot.empty) {
                    referrerUid = referrerQuerySnapshot.docs[0].id;
                }
            }

            await db.collection('splitThePotTickets').add({
              name,
              email,
              phone,
              referrerRefId: referrerRefId || null,
              referrerUid,
              amount: chargedAmount,
              ticketsBought: tickets,
              paymentStatus: 'completed',
              paymentIntentId: paymentIntent.id,
              timestamp: admin.firestore.FieldValue.serverTimestamp(),
              entryType: 'stripe',
              sourceApp: sourceApp || 'YDE Split The Pot (Webhook)' // Use tag
            });

            const raffleTotalsRef = db.collection('counters').doc('raffle_totals');
            await raffleTotalsRef.set({
                totalTickets: admin.firestore.FieldValue.increment(tickets),
                totalAmount: admin.firestore.FieldValue.increment(amountForPot)
            }, { merge: true });

            if (referrerUid) {
                const referrerRef = db.collection('referrers').doc(referrerUid);
                await referrerRef.set({
                    totalTickets: admin.firestore.FieldValue.increment(tickets),
                    totalAmount: admin.firestore.FieldValue.increment(amountForPot)
                }, { merge: true });
            }
            console.log(`Successfully processed Split the Pot entry.`);
        } else if (entryType === 'donation') {
            const donationIntentRef = db.collection('stripe_donation_payment_intents').doc(paymentIntent.id);
            await donationIntentRef.update({
                status: 'succeeded',
                amountPaid: paymentIntent.amount / 100,
                webhookProcessed: true,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                sourceApp: sourceApp || 'YDE Donation (Webhook)' // Use tag
            });
            console.log(`Successfully processed donation from ${name}.`);
        }

        // Update the payment intent document in the relevant collection (or a new one for this purpose)
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
      console.log(`Received unhandled event type: ${event.type}`);
      res.status(200).send('Webhook event ignored (uninteresting type).');
    }
});

/**
 * Firebase Callable Function to recalculate the global counters.
 */
exports.recalculateRaffleTotals = functions.https.onCall(async (data, context) => {
    if (!context.auth || !context.auth.token.superAdminReferrer) {
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
                if (typeof entry.Tickets === 'number') {
                    totalTickets += entry.Tickets;
                }
                if (typeof entry.$ === 'number') {
                    totalAmount += entry.$;
                }
            });
        }

        const raffleTotalsRef = db.collection('counters').doc('raffle_totals');
        await raffleTotalsRef.set({
            totalTickets: totalTickets,
            totalAmount: totalAmount
        }, { merge: true });

        console.log(`Recalculated totals: Tickets=${totalTickets}, Amount=$${totalAmount}`);

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
 * Callable function to get dashboard data for a referrer or super admin.
 * REVERTED to use Promise/corsHandler.
 * Added sourceApp to allRaffleEntries.
 * @type {functions.HttpsFunction}
 */
exports.getReferrerDashboardData = functions.https.onCall(async (data, context) => {
    // This function also uses the old pattern. It should be refactored like createStripePaymentIntent.
    // I am leaving it as is to focus on the original problem.
    return new Promise((resolve, reject) => {
        // context.req and context.res are required when using corsHandler
        corsHandler(context.req, context.res, async () => {
            if (!context.auth) {
                return reject(new functions.https.HttpsError('unauthenticated', 'User must be authenticated.'));
            }

            const db = admin.firestore();
            const uid = context.auth.uid;
            const tokenResult = await admin.auth().getUser(uid);
            const isSuperAdmin = !!tokenResult.customClaims.superAdminReferrer;
            const isReferrer = !!tokenResult.customClaims.referrer;

            if (!isSuperAdmin && !isReferrer) {
                return reject(new functions.https.HttpsError('permission-denied', 'User is not a referrer or super admin.'));
            }

            try {
                const userDoc = await db.collection('referrers').doc(uid).get();
                if (!userDoc.exists) {
                    return reject(new functions.https.HttpsError('not-found', 'Referrer data not found.'));
                }
                const userData = userDoc.data();

                if (isSuperAdmin) {
                    const allReferrersSnapshot = await db.collection('referrers').get();
                    const allReferrersSummary = [];
                    for (const doc of allReferrersSnapshot.docs) {
                        const referrerData = doc.data();
                        const ticketsSold = referrerData.totalTickets || 0;
                        const amountRaised = referrerData.totalAmount || 0;
                        allReferrersSummary.push({
                            name: referrerData.name,
                            refId: referrerData.refId,
                            totalTicketsSold: ticketsSold,
                            totalAmountRaised: amountRaised,
                            goal: referrerData.goal || 0
                        });
                    }

                    const allRaffleEntriesSnapshot = await db.collection('splitThePotTickets').orderBy('timestamp', 'desc').get();
                    const allRaffleEntries = allRaffleEntriesSnapshot.docs.map(doc => {
                        const entry = doc.data();
                        return {
                            id: doc.id,
                            name: entry.Name,
                            email: entry.Email,
                            phone: entry.Number,
                            ticketsBought: entry.Tickets,
                            referrerName: entry.referrerName || 'N/A',
                            timestamp: entry.timestamp.toDate().toLocaleString(),
                            amount: entry.$,
                            sourceApp: entry.sourceApp || entry.entryType // Added sourceApp tag
                        };
                    });

                    resolve({
                        isSuperAdminReferrer: true,
                        name: userData.name,
                        allReferrersSummary,
                        allRaffleEntries
                    });
                } else {
                    const totalTicketsSold = userData.totalTickets || 0;
                    const totalAmountRaised = userData.totalAmount || 0;
                    const referralLink = `https://yderaffle.web.app/?ref=${userData.refId}`;

                    const buyerDetailsSnapshot = await db.collection('splitThePotTickets')
                        .where('refUid', '==', uid)
                        .orderBy('timestamp', 'desc')
                        .get();

                    const buyerDetails = buyerDetailsSnapshot.docs.map(doc => {
                        const entry = doc.data();
                        return {
                            id: doc.id,
                            name: entry.Name,
                            ticketsBought: entry.Tickets,
                            timestamp: entry.timestamp.toDate().toLocaleString()
                        };
                    });

                    resolve({
                        isSuperAdminReferrer: false,
                        name: userData.name,
                        totalTicketsSold,
                        totalAmountRaised,
                        goal: userData.goal || 0,
                        referralLink,
                        buyerDetails
                    });
                }
            } catch (error) {
                console.error("Error in getReferrerDashboardData:", error);
                reject(new functions.https.HttpsError('internal', 'An internal error occurred while fetching dashboard data.'));
            }
        });
    });
});

/**
 * Callable function to create a new referrer.
 * REVERTED to use Promise/corsHandler.
 * @type {functions.HttpsFunction}
 */
exports.createReferrer = functions.https.onCall(async (data, context) => {
    // This function also uses the old pattern. It should be refactored like createStripePaymentIntent.
    // I am leaving it as is to focus on the original problem.
    return new Promise((resolve, reject) => {
        // context.req and context.res are required when using corsHandler
        corsHandler(context.req, context.res, async () => {
            if (!context.auth || !context.auth.token.superAdminReferrer) {
                return reject(new functions.https.HttpsError('permission-denied', 'You must be a super admin to create a new referrer.'));
            }
            const { email, password, name, goal } = data;

            if (!email || !password || !name) {
                return reject(new functions.https.HttpsError('invalid-argument', 'Missing required fields.'));
            }

            try {
                const userRecord = await admin.auth().createUser({ email, password, displayName: name });
                const uid = userRecord.uid;

                await admin.auth().setCustomUserClaims(uid, { referrer: true });

                const refId = uid.substring(0, 6);

                await admin.firestore().collection('referrers').doc(uid).set({
                    name,
                    email,
                    refId,
                    goal: goal || 0,
                    totalTickets: 0,
                    totalAmount: 0,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                });

                console.log(`Successfully created new referrer user: ${uid} with refId: ${refId}`);
                resolve({ success: true, message: `Referrer ${name} created successfully.` });
            } catch (error) {
                console.error('Error creating new referrer:', error);
                reject(new functions.https.HttpsError('internal', 'Failed to create referrer.', error.message));
            }
        });
    });
});


/**
 * Callable function to add a manual raffle entry.
 * REVERTED to use Promise/corsHandler.
 * Added sourceApp tag.
 * @type {functions.HttpsFunction}
 */
exports.addManualSale = functions.https.onCall(async (data, context) => {
    const SOURCE_APP_TAG = 'YDE Manual Sale'; // Added tag

    // This function also uses the old pattern. It should be refactored like createStripePaymentIntent.
    // I am leaving it as is to focus on the original problem.
    return new Promise((resolve, reject) => {
        // context.req and context.res are required when using corsHandler
        corsHandler(context.req, context.res, async () => {
            if (!context.auth || (!context.auth.token.superAdminReferrer && !context.auth.token.referrer)) {
                return reject(new functions.https.HttpsError('permission-denied', 'You must be a referrer or super admin to add a manual entry.'));
            }

            const { name, email, phone, ticketsBought, amount, refId } = data;
            if (!name || !ticketsBought || !amount) {
                return reject(new functions.https.HttpsError('invalid-argument', 'Missing required fields.'));
            }

            const db = admin.firestore();
            const tickets = parseInt(ticketsBought, 10);
            const numericAmount = parseFloat(amount);

            let referrerUid = null;
            let referrerName = "N/A";
            if (refId) {
                const referrerQuerySnapshot = await db.collection('referrers')
                    .where('refId', '==', refId)
                    .limit(1)
                    .get();

                if (!referrerQuerySnapshot.empty) {
                    referrerUid = referrerQuerySnapshot.docs[0].id;
                    referrerName = referrerQuerySnapshot.docs[0].data().name;
                }
            } else if (context.auth.token.referrer) {
                referrerUid = context.auth.uid;
                referrerName = context.auth.token.name;
            }

            const newEntry = {
                Name: name,
                Email: email || null,
                Number: phone || null,
                Tickets: tickets,
                $: numericAmount,
                Method: "Manual",
                refId: refId || null,
                refUid: referrerUid || null,
                referrerName: referrerName,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                entryType: "manual",
                sourceApp: SOURCE_APP_TAG // Added tag
            };

            try {
                await db.collection('splitThePotTickets').add(newEntry);
                await db.collection('raffle_entries').add(newEntry);

                const raffleTotalsRef = db.collection('counters').doc('raffle_totals');
                await raffleTotalsRef.set({
                    totalTickets: admin.firestore.FieldValue.increment(tickets),
                    totalAmount: admin.firestore.FieldValue.increment(numericAmount)
                }, { merge: true });

                if (referrerUid) {
                    const referrerRef = db.collection('referrers').doc(referrerUid);
                    await referrerRef.set({
                        totalTickets: admin.firestore.FieldValue.increment(tickets),
                        totalAmount: admin.firestore.FieldValue.increment(numericAmount)
                    }, { merge: true });
                }

                resolve({ success: true, message: "Manual entry added successfully." });
            } catch (error) {
                console.error("Error adding manual sale:", error);
                reject(new functions.https.HttpsError('internal', 'An internal error occurred.', error.message));
            }
        });
    });
});


/**
 * Callable function to update a raffle entry.
 * REVERTED to use Promise/corsHandler.
 * @type {functions.HttpsFunction}
 */
exports.updateRaffleEntry = functions.https.onCall(async (data, context) => {
    // This function also uses the old pattern. It should be refactored like createStripePaymentIntent.
    // I am leaving it as is to focus on the original problem.
    return new Promise((resolve, reject) => {
        // context.req and context.res are required when using corsHandler
        corsHandler(context.req, context.res, async () => {
            if (!context.auth || !context.auth.token.superAdminReferrer) {
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
                const originalTickets = originalData.Tickets;
                const originalAmount = originalData.$;

                const updatedTickets = updatedData.ticketsBought;
                const updatedAmount = updatedData.amount;

                const ticketDiff = updatedTickets - originalTickets;
                const amountDiff = updatedAmount - originalAmount;

                await docRef.update({
                    Name: updatedData.name,
                    Email: updatedData.email,
                    Number: updatedData.phone,
                    Tickets: updatedTickets,
                    $: updatedAmount,
                });

                const raffleTotalsRef = db.collection('counters').doc('raffle_totals');
                await raffleTotalsRef.set({
                    totalTickets: admin.firestore.FieldValue.increment(ticketDiff),
                    totalAmount: admin.firestore.FieldValue.increment(amountDiff)
                }, { merge: true });

                if (originalData.refUid) {
                    const referrerRef = db.collection('referrers').doc(originalData.refUid);
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
 * REVERTED to use Promise/corsHandler.
 * @type {functions.HttpsFunction}
 */
exports.deleteRaffleEntry = functions.https.onCall(async (data, context) => {
    // This function also uses the old pattern. It should be refactored like createStripePaymentIntent.
    // I am leaving it as is to focus on the original problem.
    return new Promise((resolve, reject) => {
        // context.req and context.res are required when using corsHandler
        corsHandler(context.req, context.res, async () => {
            if (!context.auth || !context.auth.token.superAdminReferrer) {
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
                const tickets = entryData.Tickets;
                const amount = entryData.$;
                const referrerUid = entryData.refUid;

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
 * REVERTED to use Promise/corsHandler.
 * Added sourceApp tag.
 * @type {functions.HttpsFunction}
 */
exports.claimSpinTicket = functions.https.onCall(async (data, context) => {
    const SOURCE_APP_TAG = 'YDE Free Spin Claim'; // Added tag

    // This function also uses the old pattern. It should be refactored like createStripePaymentIntent.
    // I am leaving it as is to focus on the original problem.
    return new Promise((resolve, reject) => {
        // context.req and context.res are required when using corsHandler
        corsHandler(context.req, context.res, async () => {
            const { name } = data;
            const TOTAL_TICKETS = 650;

            if (!name) {
                return reject(new functions.https.HttpsError('invalid-argument', 'Missing required field: name.'));
            }

            const db = admin.firestore();
            let ticketNumber;
            let foundUniqueTicket = false;

            // Loop to find a unique ticket number
            for (let i = 0; i < TOTAL_TICKETS * 2; i++) {
                const randomTicket = Math.floor(Math.random() * TOTAL_TICKETS) + 1;
                const ticketRef = db.collection('rolex_tickets').doc(randomTicket.toString());

                try {
                    const doc = await db.runTransaction(async (transaction) => {
                        const docSnapshot = await transaction.get(ticketRef);
                        if (!docSnapshot.exists) {
                            transaction.set(ticketRef, {
                                status: 'claimed',
                                timestamp: admin.firestore.FieldValue.serverTimestamp(), // Added timestamp for consistency
                                name: name,
                                sourceApp: SOURCE_APP_TAG // Added tag
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
