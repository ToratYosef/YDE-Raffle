// --- Instructions ---
// 1. Place your downloaded Firebase service account key file in the same directory and name it "serviceAccountKey.json".
// 2. Make sure the CSV file is in the same directory and is named "YDE Split The Pot 2026.xlsx - Sheet1.csv".
// 3. To run this script, open your terminal and type: node import_all_tickets.js

const admin = require('firebase-admin');
const fs = require('fs');
const csv = require('csv-parser');

const serviceAccount = require('./serviceAccountKey.json');
const projectId = serviceAccount.project_id;

const ticketsCollectionPath = 'splitThePotTickets';
const counterDocPath = 'counters/raffle_totals';

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const ticketsRef = db.collection(ticketsCollectionPath);
const counterRef = db.doc(counterDocPath);

const tickets = [];
const seenTickets = new Set(); // for duplicate prevention
let headersFound = false;
let nameKey, phoneKey, paymentKey, ticketCountKey, amountPaidKey;

fs.createReadStream('Copy of YDE Split The Pot 2026 - Sheet1 (1).csv')
  .pipe(csv())
  .on('headers', (headers) => {
    // Find the correct column names using a more robust search
    nameKey = headers.find(h => h.includes('Name'));
    phoneKey = headers.find(h => h.includes('Phone Number'));
    paymentKey = headers.find(h => h.includes('Payment Method'));
    ticketCountKey = headers.find(h => h.includes('Number Of') && h.includes('Tickets Purchased'));
    amountPaidKey = headers.find(h => h.includes('Amount Paid'));
    headersFound = true;
  })
  .on('data', (row) => {
    if (!headersFound) return;
    
    // Extract values
    const name = row[nameKey] ? row[nameKey].trim() : '';
    let phone = row[phoneKey] ? row[phoneKey].trim() : '';
    const ticketCount = parseInt(row[ticketCountKey], 10);
    const amountPaid = parseFloat(row[amountPaidKey].replace('$', '').replace(',', ''));
    const paymentMethod = row[paymentKey] ? row[paymentKey].trim() : 'Unknown';

    // Default phone to "Unknown" if missing/empty
    if (!phone) {
      phone = 'Unknown';
    }

    if (name && !isNaN(ticketCount) && !isNaN(amountPaid)) {
      const ticket = {
        firstName: name,
        phoneNumber: phone,
        paymentMethod: paymentMethod,
        ticketCount: ticketCount,
        amountPaid: amountPaid,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      };

      // Create a unique key for deduplication
      const key = `${ticket.firstName}|${ticket.phoneNumber}|${ticket.ticketCount}|${ticket.amountPaid}`;

      if (!seenTickets.has(key)) {
        seenTickets.add(key);
        tickets.push(ticket);
        console.log(`Adding: Name: ${ticket.firstName}, Phone: ${ticket.phoneNumber}, Tickets: ${ticket.ticketCount}, Amount: $${ticket.amountPaid}`);
      } else {
        console.warn(`Skipping duplicate ticket for ${ticket.firstName}, Phone: ${ticket.phoneNumber}, Tickets: ${ticket.ticketCount}, Amount: $${ticket.amountPaid}`);
      }

    } else {
      console.warn(`Skipping row: Missing or invalid data. Name: ${name}, Tickets: ${row[ticketCountKey]}, Amount: ${row[amountPaidKey]}`);
    }
  })
  .on('end', async () => {
    console.log('CSV file successfully processed. Importing tickets...');
    
    // Check if the counter document exists and create it if not
    const counterDoc = await counterRef.get();
    if (!counterDoc.exists) {
      await counterRef.set({ totalTickets: 0, totalAmount: 0 });
    }

    let totalNewTickets = 0;
    let totalNewAmount = 0;
    const batch = db.batch();
    
    for (const ticket of tickets) {
      const newDocRef = ticketsRef.doc();
      batch.set(newDocRef, ticket);
      totalNewTickets += ticket.ticketCount;
      totalNewAmount += ticket.amountPaid;
    }

    // Atomically increment the total ticket and amount counters
    batch.update(counterRef, {
      totalTickets: admin.firestore.FieldValue.increment(totalNewTickets),
      totalAmount: admin.firestore.FieldValue.increment(totalNewAmount)
    });

    try {
      await batch.commit();
      console.log('All tickets and amounts have been successfully imported to Firestore.');
      console.log(`Total of ${totalNewTickets} new tickets added.`);
      console.log(`Total of $${totalNewAmount} added to the pot.`);
    } catch (error) {
      console.error('Error importing tickets:', error);
    }
  });
