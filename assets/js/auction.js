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

const selectedBundles = {};
const bundleWrap = document.getElementById('bundles');
const packageWrap = document.getElementById('packages');
const err = document.getElementById('err');
const selectedBundleLabel = document.getElementById('selectedBundleLabel');
const checkoutBtn = document.getElementById('checkout');
const nameEl = document.getElementById('name');
const emailEl = document.getElementById('email');
const phoneEl = document.getElementById('phone');

const packageThemes = [
  {
    card: 'bg-emerald-950/45 border-emerald-400/35',
    title: 'text-emerald-300',
    value: 'text-emerald-100/90',
    list: 'text-emerald-50'
  },
  {
    card: 'bg-sky-950/45 border-sky-400/35',
    title: 'text-sky-300',
    value: 'text-sky-100/90',
    list: 'text-sky-50'
  },
  {
    card: 'bg-fuchsia-950/35 border-fuchsia-400/35',
    title: 'text-fuchsia-300',
    value: 'text-fuchsia-100/90',
    list: 'text-fuchsia-50'
  },
  {
    card: 'bg-amber-950/45 border-amber-400/35',
    title: 'text-amber-300',
    value: 'text-amber-100/90',
    list: 'text-amber-50'
  }
];

const bundleThemes = [
  'bg-gradient-to-br from-rose-500/20 to-rose-900/25 border-rose-300/40 hover:border-rose-200/90 hover:shadow-[0_0_20px_rgba(244,63,94,0.35)]',
  'bg-gradient-to-br from-blue-500/20 to-blue-900/25 border-blue-300/40 hover:border-blue-200/90 hover:shadow-[0_0_20px_rgba(59,130,246,0.35)]',
  'bg-gradient-to-br from-emerald-500/20 to-emerald-900/25 border-emerald-300/40 hover:border-emerald-200/90 hover:shadow-[0_0_20px_rgba(16,185,129,0.35)]',
  'bg-gradient-to-br from-amber-500/20 to-amber-900/25 border-amber-300/40 hover:border-amber-200/90 hover:shadow-[0_0_20px_rgba(251,191,36,0.4)]'
];

const getBundleTotals = () => {
  return ticketBundles.reduce((acc, bundle) => {
    const qty = Number(selectedBundles[bundle.id] || 0);
    acc.totalTickets += qty * bundle.ticketCount;
    acc.totalAmount += qty * bundle.price;
    return acc;
  }, { totalTickets: 0, totalAmount: 0 });
};

const renderSelectionSummary = () => {
  const { totalTickets, totalAmount } = getBundleTotals();
  if (totalTickets === 0) {
    selectedBundleLabel.textContent = 'No bundle selected';
    selectedBundleLabel.classList.remove('border-yellow-300/60', 'text-yellow-100', 'bg-yellow-500/10');
    return;
  }

  selectedBundleLabel.textContent = `Selected: ${totalTickets} tickets for $${totalAmount}`;
  selectedBundleLabel.classList.add('border-yellow-300/60', 'text-yellow-100', 'bg-yellow-500/10');
};

auctionPackages.forEach((pkg, index) => {
  const theme = packageThemes[index % packageThemes.length];
  const card = document.createElement('div');
  card.className = `rounded-xl p-5 border transition-transform duration-200 hover:-translate-y-0.5 ${theme.card}`;
  card.innerHTML = `
    <div class="flex flex-col md:flex-row md:items-start md:justify-between gap-4 md:gap-6">
      <div class="md:w-64 md:flex-shrink-0">
        <h3 class="font-semibold text-2xl leading-tight ${theme.title}">${pkg.name}</h3>
        <p class="mt-2 text-sm ${theme.value}">Value: ${pkg.value}</p>
      </div>
      <ul class="text-sm space-y-1.5 ${theme.list} md:flex-1 md:border-l md:border-white/15 md:pl-5">
        ${pkg.prizes.map((p) => `<li>• ${p}</li>`).join('')}
      </ul>
    </div>
  `;
  packageWrap.appendChild(card);
});

ticketBundles.forEach((bundle, index) => {
  const theme = bundleThemes[index % bundleThemes.length];
  const card = document.createElement('button');
  card.type = 'button';
  card.className = `bundle border rounded-xl p-4 transition-all duration-200 ${theme}`;
  card.innerHTML = `
    <div class="flex items-center justify-between gap-4">
      <div class="text-left">
        <p class="text-3xl font-bold text-white leading-tight">${bundle.ticketCount}</p>
        <p class="text-sm uppercase tracking-wider text-slate-200">Ticket${bundle.ticketCount > 1 ? 's' : ''}</p>
        <p class="text-2xl font-semibold text-yellow-100 mt-1">$${bundle.price}</p>
      </div>
      <div class="flex items-center gap-2">
        <button type="button" data-action="dec" data-id="${bundle.id}" class="h-9 w-9 rounded-full border border-white/30 text-xl leading-none text-white hover:bg-white/10">-</button>
        <span id="qty-${bundle.id}" class="min-w-8 text-center text-xl font-bold text-white">0</span>
        <button type="button" data-action="inc" data-id="${bundle.id}" class="h-9 w-9 rounded-full border border-white/30 text-xl leading-none text-white hover:bg-white/10">+</button>
      </div>
    </div>
  `;

  const updateBundleCardState = () => {
    const qty = Number(selectedBundles[bundle.id] || 0);
    const qtyEl = document.getElementById(`qty-${bundle.id}`);
    if (qtyEl) qtyEl.textContent = String(qty);
    card.classList.toggle('ring-2', qty > 0);
    card.classList.toggle('ring-yellow-300', qty > 0);
    card.classList.toggle('scale-[1.01]', qty > 0);
  };

  card.addEventListener('click', (event) => {
    const target = event.target.closest('button[data-action]');
    if (!target) return;

    const action = target.dataset.action;
    const current = Number(selectedBundles[bundle.id] || 0);
    if (action === 'inc') {
      selectedBundles[bundle.id] = current + 1;
    } else if (action === 'dec') {
      selectedBundles[bundle.id] = Math.max(0, current - 1);
    }

    updateBundleCardState();
    renderSelectionSummary();
  });

  bundleWrap.appendChild(card);
  updateBundleCardState();
});

renderSelectionSummary();

checkoutBtn.addEventListener('click', async () => {
  err.textContent = '';
  const name = nameEl.value.trim();
  const email = emailEl.value.trim();
  const phone = phoneEl.value.trim();
  const selected = Object.fromEntries(
    Object.entries(selectedBundles).filter(([, qty]) => Number(qty) > 0)
  );
  const { totalTickets } = getBundleTotals();

  if (!name || !email || !phone || totalTickets < 1) {
    err.textContent = 'Please complete all fields and select at least 1 ticket.';
    return;
  }

  checkoutBtn.disabled = true;
  checkoutBtn.textContent = 'Preparing checkout...';
  try {
    const response = await createCheckout({ name, email, phone, bundleSelections: selected });
    if (!response?.data?.url) throw new Error('No checkout URL returned.');
    window.location.href = response.data.url;
  } catch (e) {
    err.textContent = e?.message || 'Checkout failed. Please try again.';
    checkoutBtn.disabled = false;
    checkoutBtn.textContent = 'Proceed to Stripe Checkout';
  }
});
