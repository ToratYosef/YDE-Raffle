import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.9.1/firebase-app.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/11.9.1/firebase-functions.js';

const firebaseConfig = {
  apiKey: 'AIzaSyAT539nr_s2OxHPTAmkxwMpaWt-FiDTgQs',
  authDomain: 'yderaffle.firebaseapp.com',
  projectId: 'yderaffle',
  storageBucket: 'yderaffle.firebasestorage.app',
  messagingSenderId: '967768309102',
  appId: '1:967768309102:web:c89d61a747e8cb941f557f'
};

const app = initializeApp(firebaseConfig);
const createCheckout = httpsCallable(getFunctions(app), 'createAuctionCheckoutSession');
const { ticketBundles, auctionPackages } = window.AUCTION_DATA;

let selectedBundle = null;
const bundleWrap = document.getElementById('bundles');
const packageWrap = document.getElementById('packages');
const err = document.getElementById('err');
const selectedBundleLabel = document.getElementById('selectedBundleLabel');
const checkoutBtn = document.getElementById('checkout');
const nameEl = document.getElementById('name');
const emailEl = document.getElementById('email');
const phoneEl = document.getElementById('phone');

auctionPackages.forEach((pkg) => {
  const card = document.createElement('div');
  card.className = 'bg-slate-900 border border-slate-700 rounded-xl p-4';
  card.innerHTML = `<h3 class="text-yellow-400 font-semibold text-xl">${pkg.name}</h3><p class="text-slate-300 mb-2">Value: ${pkg.value}</p><ul class="text-slate-200 text-sm space-y-1">${pkg.prizes.map((p) => `<li>• ${p}</li>`).join('')}</ul>`;
  packageWrap.appendChild(card);
});

ticketBundles.forEach((bundle) => {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'bundle cursor-pointer bg-slate-900 border border-slate-700 rounded-xl p-4 text-left hover:border-yellow-400';
  card.innerHTML = `<p class="text-xl font-bold text-yellow-300">${bundle.ticketCount} Ticket${bundle.ticketCount > 1 ? 's' : ''}</p><p class="text-slate-200">$${bundle.price}</p>`;
  card.addEventListener('click', () => {
    selectedBundle = bundle;
    document.querySelectorAll('.bundle').forEach((el) => el.classList.remove('ring-2', 'ring-yellow-400'));
    card.classList.add('ring-2', 'ring-yellow-400');
    selectedBundleLabel.textContent = `Selected: ${bundle.ticketCount} tickets for $${bundle.price}`;
  });
  bundleWrap.appendChild(card);
});

checkoutBtn.addEventListener('click', async () => {
  err.textContent = '';
  const name = nameEl.value.trim();
  const email = emailEl.value.trim();
  const phone = phoneEl.value.trim();

  if (!name || !email || !phone || !selectedBundle) {
    err.textContent = 'Please complete all fields and select a bundle.';
    return;
  }

  checkoutBtn.disabled = true;
  checkoutBtn.textContent = 'Preparing checkout...';
  try {
    const response = await createCheckout({ name, email, phone, ticketBundleId: selectedBundle.id });
    if (!response?.data?.url) throw new Error('No checkout URL returned.');
    window.location.href = response.data.url;
  } catch (e) {
    err.textContent = e?.message || 'Checkout failed. Please try again.';
    checkoutBtn.disabled = false;
    checkoutBtn.textContent = 'Proceed to Stripe Checkout';
  }
});
