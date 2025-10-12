// --- Start of duplicate.js (Requires Node 16+ for readline/promises) ---

const admin = require('firebase-admin');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');

// 1. Specify the path to your service account key
// ASSUMPTION: This file is in the same directory as this script.
const serviceAccount = require('./serviceAccountKey.json');

// 2. Initialize the Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const firestore = admin.firestore();

// --- Configuration ---
const COLLECTION_ID = 'rolex_entries';
const SOURCE_DOC_ID = 'p01M44xNQXCAvOrShVh0';
// --- End Configuration ---


async function duplicateAndCustomizeDocument() {
  const sourceRef = firestore.collection(COLLECTION_ID).doc(SOURCE_DOC_ID);
  const rl = readline.createInterface({ input, output });

  try {
    const doc = await sourceRef.get();

    if (!doc.exists) {
      console.error(`Error: Document not found at ${COLLECTION_ID}/${SOURCE_DOC_ID}`);
      return;
    }

    let dataToDuplicate = doc.data();

    console.log(`\n--- Duplicating Document: ${SOURCE_DOC_ID} ---`);
    console.log(`Original Name: ${dataToDuplicate.name}`);
    
    // 1. Ask for New Name
    const newName = await rl.question('Enter the NEW Customer Name (e.g., "Daniel Khafif"): ');
    dataToDuplicate.name = newName.trim();
    
    // 2. Ask for New Phone Number
    const newPhone = await rl.question('Enter the NEW Phone Number: ');
    dataToDuplicate.phoneNumber = newPhone.trim();

    // 3. Ask for New Email
    const newEmail = await rl.question('Enter the NEW Email Address (optional, press Enter to skip): ');
    // Assuming the field is named 'email', set it only if a value was provided
    if (newEmail.trim()) {
        dataToDuplicate.email = newEmail.trim();
    } else {
        // If you want to remove the field if the user skips, use:
        // delete dataToDuplicate.email;
    }
    
    // --- Custom logic for setting the first name ---
    // Assuming you want the first name in the duplicated ticket to be the new name
    // and the original 'name' field in your data contains the customer's full name.
    
    // NOTE: If you have other custom fields (like 'ticket_count', 'status', etc.), 
    // you can prompt for those here as well!

    // Create a new document reference with a new auto-generated ID
    const newDocRef = firestore.collection(COLLECTION_ID).doc();

    // Write the modified data to the new document
    await newDocRef.set(dataToDuplicate);

    console.log(`\n✅ Success! Document duplicated and customized.`);
    console.log(`Original Document: ${SOURCE_DOC_ID}`);
    console.log(`New Document ID:   ${newDocRef.id}`);
    console.log(`New Name:          ${dataToDuplicate.name}`);
    console.log(`New Phone:         ${dataToDuplicate.phoneNumber}`);

  } catch (error) {
    console.error('\nAn error occurred during duplication:', error);
  } finally {
    rl.close();
  }
}

duplicateAndCustomizeDocument();
// --- End of duplicate.js ---