// --- Instructions ---
// 1. Place your downloaded Firebase service account key file in the same directory and name it "serviceAccountKey.json".
// 2. Make sure the CSV file is in the same directory and is named "Copy of YDE Split The Pot 2026 - Sheet1 (1).csv".
// 3. To run this script, open your terminal and type: node import_tickets_and_update_referrers.js

const admin = require('firebase-admin');
const fs = require('fs');
const csv = require('csv-parser');

const serviceAccount = require('./serviceAccountKey.json');
const projectId = serviceAccount.project_id;

const ticketsCollectionPath = 'splitThePotTickets';
const referrersCollectionPath = 'referrers';
const counterDocPath = 'counters/raffle_totals';

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const ticketsRef = db.collection(ticketsCollectionPath);
const counterRef = db.doc(counterDocPath);

const ticketsToImport = [];
const seenTickets = new Set(); // for duplicate prevention
let headersFound = false;
let nameKey, phoneKey, paymentKey, ticketCountKey, amountPaidKey, referrerNameKey;
let referrerLookupMap = new Map(); // Stores { RefID: { uid, name } }
// NEW: Map to track aggregated ticket and amount updates per referrer UID
let referrerUpdates = new Map(); // Stores { uid: { totalTickets: number, totalAmount: number } }


/**
 * Generates the Referrer ID (RefID) based on the format:
 * [First Name] + [Last Name Initial, capitalized] (e.g., Saul Setton -> SaulS)
 * @param {string} fullName The full name of the referrer.
 * @returns {string | null} The generated RefID or null if format is invalid.
 */
const generateRefId = (fullName) => {
    if (!fullName) return null;
    const parts = fullName.trim().split(/\s+/).filter(p => p.length > 0);
    if (parts.length < 2) {
        // Handle single-word names by taking the full word and a placeholder initial if needed
        if (parts.length === 1) return `${parts[0]}A`; // Use 'A' as placeholder initial
        return null;
    }
    const firstName = parts[0];
    const lastName = parts[parts.length - 1];
    return `${firstName}${lastName.charAt(0).toUpperCase()}`;
};

/**
 * Fetches all referrers and creates a lookup map for quick access.
 */
async function loadReferrerLookupMap() {
    console.log('Fetching referrer data from Firestore...');
    const snapshot = await db.collection(referrersCollectionPath).get();
    snapshot.forEach(doc => {
        const data = doc.data();
        if (data.refId) {
            // Store the Firebase document ID (uid) along with the name
            referrerLookupMap.set(data.refId, {
                uid: doc.id,
                name: data.name
            });
        }
    });
    console.log(`Loaded ${referrerLookupMap.size} unique referrers.`);
}

// --- Main Execution ---

async function runImport() {
    await loadReferrerLookupMap();

    // NOTE: The filename in the ReadStream is hardcoded, ensure it matches your file name.
    fs.createReadStream('Copy of YDE Split The Pot 2026 - Sheet1 (1).csv')
      .pipe(csv())
      .on('headers', (headers) => {
        // Find the correct column names using a more robust search
        nameKey = headers.find(h => h.includes('Name') && !h.includes('Referrer'));
        phoneKey = headers.find(h => h.includes('Phone Number'));
        paymentKey = headers.find(h => h.includes('Payment Method'));
        ticketCountKey = headers.find(h => h.includes('Number Of') && h.includes('Tickets Purchased'));
        amountPaidKey = headers.find(h => h.includes('Amount Paid'));
        // Find Referrer Name Column
        referrerNameKey = headers.find(h => h.includes('Referrer') && h.includes('Name')); 
        if (!referrerNameKey) {
            referrerNameKey = headers.find(h => h.includes('Reference'));
            if (referrerNameKey) console.warn(`Using column "${referrerNameKey}" for referrer name.`);
        }
        
        headersFound = true;
      })
      .on('data', (row) => {
        if (!headersFound) return;
        
        // Extract required base values
        const name = row[nameKey] ? row[nameKey].trim() : ''; 
        let phone = row[phoneKey] ? row[phoneKey].trim() : 'Unknown';
        const ticketCount = parseInt(row[ticketCountKey], 10);
        
        // Clean and parse amount
        const rawAmount = row[amountPaidKey] || '0';
        const amountPaid = parseFloat(rawAmount.replace(/[$,]/g, '').trim()); // Clean dollar signs and commas
        const paymentMethod = row[paymentKey] ? row[paymentKey].trim() : 'Unknown';
        
        // Extract and process referral information
        let referrerUid = null;
        let referrerName = null;
        let referrerRefId = null;

        const rawReferrerName = referrerNameKey && row[referrerNameKey] ? row[referrerNameKey].trim() : '';

        if (rawReferrerName) {
            // 1. Generate the expected RefID from the referrer's full name
            const generatedRefId = generateRefId(rawReferrerName);

            if (generatedRefId) {
                // 2. Look up the corresponding UID and Name
                const referrerData = referrerLookupMap.get(generatedRefId);

                if (referrerData) {
                    // 3. Match found! Assign values to ticket entry
                    referrerRefId = generatedRefId;
                    referrerUid = referrerData.uid; // This is the Document ID we need for updating
                    referrerName = referrerData.name;
                    console.log(`Match: ${rawReferrerName} -> ${referrerRefId} (UID: ${referrerUid})`);
                } else {
                    console.warn(`No referrer found in Firestore for generated RefID: ${generatedRefId} (from Name: ${rawReferrerName}).`);
                }
            } else {
                // Try to check if the raw name itself is a RefID (e.g., if RefID was manually entered)
                const referrerData = referrerLookupMap.get(rawReferrerName);
                if (referrerData) {
                     referrerRefId = rawReferrerName;
                     referrerUid = referrerData.uid;
                     referrerName = referrerData.name;
                     console.log(`Match (Direct RefID): ${rawReferrerName} (UID: ${referrerUid})`);
                } else {
                    console.warn(`Skipping referral lookup: Could not generate RefID or find direct match for name: ${rawReferrerName}`);
                }
            }
        }


        if (name && !isNaN(ticketCount) && amountPaid > 0) {
          const ticket = {
            fullName: name, 
            phoneNumber: phone,
            paymentMethod: paymentMethod,
            ticketCount: ticketCount,
            amountPaid: amountPaid,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            referrerRefId: referrerRefId, 
            referrerUid: referrerUid, 
            referrerName: referrerName,
            entryType: 'imported',
            sourceApp: 'YDE Historical Import'
          };

          // Create a unique key for deduplication
          const key = `${name}|${ticket.phoneNumber}|${ticket.ticketCount}|${ticket.amountPaid}|${ticket.referrerRefId}`;

          if (!seenTickets.has(key)) {
            seenTickets.add(key);
            console.log(`Adding: Name: ${ticket.fullName}, Ref: ${referrerRefId || 'None'}, Tickets: ${ticket.ticketCount}, Amount: $${ticket.amountPaid}`);
            ticketsToImport.push(ticket);
            
            // --- NEW LOGIC: AGGREGATE REFERRER TOTALS ---
            if (ticket.referrerUid) {
                const uid = ticket.referrerUid;
                // Initialize or get current totals for this referrer
                const currentTotals = referrerUpdates.get(uid) || { totalTickets: 0, totalAmount: 0 };
                
                currentTotals.totalTickets += ticket.ticketCount;
                currentTotals.totalAmount += ticket.amountPaid;
                
                referrerUpdates.set(uid, currentTotals);
            }

          } else {
            console.warn(`Skipping duplicate ticket for ${name}, Ref: ${referrerRefId || 'None'}`);
          }

        } else {
          console.warn(`Skipping row: Missing or invalid primary data. Name: ${name}, Tickets: ${row[ticketCountKey]}, Amount: ${row[amountPaidKey]}`);
        }
      })
      .on('end', async () => {
        console.log('CSV file successfully processed. Importing tickets...');
        
        // Check if the counter document exists and create it if not
        const counterDoc = await counterRef.get();
        if (!counterDoc.exists) {
          console.log("Creating raffle_totals counter document.");
          await counterRef.set({ totalTickets: 0, totalAmount: 0 });
        }

        let totalNewTickets = 0;
        let totalNewAmount = 0;
        const batch = db.batch();
        
        // 1. Add new tickets to the batch
        for (const ticket of ticketsToImport) {
          const newDocRef = ticketsRef.doc();
          batch.set(newDocRef, ticket);
          totalNewTickets += ticket.ticketCount;
          totalNewAmount += ticket.amountPaid;
        }

        // 2. Add global counter update to the batch
        batch.update(counterRef, {
          totalTickets: admin.firestore.FieldValue.increment(totalNewTickets),
          totalAmount: admin.firestore.FieldValue.increment(totalNewAmount)
        });

        // 3. NEW LOGIC: Add individual referrer updates to the batch
        console.log(`Preparing to update stats for ${referrerUpdates.size} referrers...`);
        for (const [uid, totals] of referrerUpdates.entries()) {
            const referrerDocRef = db.collection(referrersCollectionPath).doc(uid);
            batch.update(referrerDocRef, {
                totalTickets: admin.firestore.FieldValue.increment(totals.totalTickets),
                totalAmount: admin.firestore.FieldValue.increment(totals.totalAmount)
            });
            console.log(`\t- Referrer ${uid} (Tickets: ${totals.totalTickets}, Amount: $${totals.totalAmount.toFixed(2)}) added to batch.`);
        }


        try {
          await batch.commit();
          console.log('--- Import Complete ---');
          console.log('All tickets, amounts, and referrer stats have been successfully imported and updated in a single batch operation.');
          console.log(`Total of ${totalNewTickets} new tickets added.`);
          console.log(`Total of $${totalNewAmount.toFixed(2)} added to the pot.`);
          console.log(`Updated statistics for ${referrerUpdates.size} unique referrers.`);

        } catch (error) {
          console.error('FATAL ERROR: Failed to commit Firestore batch:', error);
        }
      });
}

runImport().catch(console.error);