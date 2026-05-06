import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.9.1/firebase-app.js';
import { getFirestore, collection, getDocs } from 'https://www.gstatic.com/firebasejs/11.9.1/firebase-firestore.js';
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
const db = getFirestore(app);
const fns = getFunctions(app);

const createManual = httpsCallable(fns, 'createManualAuctionOrder');

const statsEl = document.getElementById('stats');
const packageTotalsEl = document.getElementById('packageTotals');
const searchEl = document.getElementById('search');
const ordersInfoEl = document.getElementById('ordersInfo');
const ordersEl = document.getElementById('orders');
const manualFormEl = document.getElementById('manualForm');
const manualErrEl = document.getElementById('manualErr');
const manualSubmitEl = document.getElementById('manualSubmit');
const wheelPackageEl = document.getElementById('wheelPackage');
const wheelInfoEl = document.getElementById('wheelInfo');
const wheelNamesEl = document.getElementById('wheelNames');
const openWheelBtn = document.getElementById('openWheel');

const packages = window.AUCTION_DATA?.auctionPackages || [];
const packageMap = new Map(packages.map((pkg) => [pkg.id, pkg]));

let paidOrders = [];

const toMoney = (amount) => `$${Number(amount || 0).toFixed(2)}`;

const statCard = (label, value) => {
  return `
    <div class="rounded-xl border border-slate-700 bg-slate-900/70 p-3">
      <p class="text-xs uppercase tracking-wider text-slate-400">${label}</p>
      <p class="text-2xl font-semibold text-white mt-1">${value}</p>
    </div>
  `;
};

const getOrderEntries = (order) => {
  if (order.entries && typeof order.entries === 'object') return order.entries;

  const entries = {};
  packages.forEach((pkg) => {
    entries[pkg.id] = Number((order.allocations || {})[pkg.id] || 0);
  });
  return entries;
};

const getOrderLineItems = (order) => {
  if (Array.isArray(order.lineItems) && order.lineItems.length) return order.lineItems;

  const entries = getOrderEntries(order);
  return packages
    .map((pkg) => {
      const quantity = Number(entries[pkg.id] || 0);
      if (quantity <= 0) return null;
      const unitPrice = Number(pkg.price || 0);
      return {
        packageId: pkg.id,
        name: pkg.name,
        quantity,
        unitPrice,
        total: quantity * unitPrice
      };
    })
    .filter(Boolean);
};

const getPaidAmount = (order) => {
  if (Number(order.total) > 0) return Number(order.total);
  if (Number(order.amountPaid) > 0) return Number(order.amountPaid);
  return getOrderLineItems(order).reduce((sum, line) => sum + Number(line.total || 0), 0);
};

const getEntriesForPackage = (packageId) => {
  const names = [];
  paidOrders.forEach((order) => {
    const qty = Number(getOrderEntries(order)[packageId] || 0);
    if (qty <= 0) return;

    const name = (order.name || '').trim() || 'Unknown';
    for (let i = 0; i < qty; i += 1) names.push(name);
  });
  return names;
};

const renderStats = () => {
  const totalOrders = paidOrders.length;
  const totalEntries = paidOrders.reduce((sum, order) => {
    return sum + Object.values(getOrderEntries(order)).reduce((entrySum, qty) => entrySum + Number(qty || 0), 0);
  }, 0);
  const totalRevenue = paidOrders.reduce((sum, order) => sum + getPaidAmount(order), 0);

  statsEl.innerHTML = [
    statCard('Paid Orders', totalOrders),
    statCard('Total Entries', totalEntries),
    statCard('Total Revenue', toMoney(totalRevenue)),
    statCard('Stripe Orders', paidOrders.filter((o) => o.source === 'stripe').length),
    statCard('Manual Orders', paidOrders.filter((o) => o.source === 'manual').length)
  ].join('');
};

const renderPackageTotals = () => {
  packageTotalsEl.innerHTML = packages.map((pkg) => {
    const entries = paidOrders.reduce((sum, order) => sum + Number(getOrderEntries(order)[pkg.id] || 0), 0);
    const revenue = entries * Number(pkg.price || 0);

    return `
      <div class="rounded-xl border border-slate-700 bg-slate-900/70 p-3">
        <div class="flex items-center justify-between gap-3">
          <p class="font-semibold text-white">${pkg.name}</p>
          <span class="text-xs text-slate-300">$${pkg.price}/entry</span>
        </div>
        <p class="text-sm text-slate-300 mt-1">Entries: <span class="text-white font-semibold">${entries}</span></p>
        <p class="text-sm text-slate-300">Revenue: <span class="text-yellow-300 font-semibold">${toMoney(revenue)}</span></p>
      </div>
    `;
  }).join('');
};

const buildOrderCard = (order) => {
  const lineItems = getOrderLineItems(order);
  const compact = lineItems.map((line) => `${line.name}: ${line.quantity}`).join(' | ');

  return `
    <div class="rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-lg font-semibold text-white">${order.name || 'Unknown'}</p>
        <span class="text-xs px-2 py-1 rounded-full border border-slate-600 text-slate-300">${order.source || 'unknown'}</span>
      </div>
      <p class="text-xs text-slate-300 mt-1">${order.email || ''} ${order.phone || ''}</p>
      <p class="text-sm text-slate-200 mt-2">${compact || 'No entries'}</p>
      <p class="text-sm text-yellow-300 mt-1 font-semibold">${toMoney(getPaidAmount(order))}</p>
    </div>
  `;
};

const renderOrders = () => {
  const search = (searchEl.value || '').toLowerCase();
  const filtered = paidOrders.filter((order) => `${order.name || ''} ${order.email || ''} ${order.phone || ''}`.toLowerCase().includes(search));

  ordersInfoEl.textContent = `${filtered.length} of ${paidOrders.length} paid orders shown`;
  ordersEl.innerHTML = filtered.map(buildOrderCard).join('');
};

const renderWheelPackages = () => {
  wheelPackageEl.innerHTML = packages.map((pkg) => `<option value="${pkg.id}">${pkg.number}. ${pkg.name}</option>`).join('');
};

const renderWheelPreview = () => {
  const packageId = wheelPackageEl.value;
  const pkg = packageMap.get(packageId);
  if (!packageId || !pkg) {
    wheelInfoEl.textContent = 'Select a package to preview wheel entries.';
    wheelNamesEl.textContent = '';
    return;
  }

  const names = getEntriesForPackage(packageId);
  wheelInfoEl.textContent = `${pkg.name}: ${names.length} total entries (${new Set(names).size} unique names)`;
  wheelNamesEl.textContent = names.length ? names.join(', ') : 'No paid entries yet for this package.';
};

const buildWheelUrl = (pkg, names) => {
  const logoUrl = 'https://raw.githubusercontent.com/ToratYosef/ToratYosef..github.io/refs/heads/main/assets/logos.jpeg';
  const params = new URLSearchParams({
    entries: names.join(','),
    title: `${pkg.name} - YDE Auction`,
    centerImage: logoUrl
  });
  return `https://wheelofnames.com/view?${params.toString()}`;
};

const renderManualForm = () => {
  manualFormEl.innerHTML = `
    <input id="mname" class="w-full rounded-lg border border-slate-700 bg-slate-950 p-2" placeholder="Full name">
    <input id="memail" class="w-full rounded-lg border border-slate-700 bg-slate-950 p-2" placeholder="Email">
    <input id="mphone" class="w-full rounded-lg border border-slate-700 bg-slate-950 p-2" placeholder="Phone">
    <label class="text-sm text-slate-300">Package
      <select id="mpackage" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 p-2 text-white">
        ${packages.map((pkg) => `<option value="${pkg.id}">${pkg.name} ($${pkg.price}/entry)</option>`).join('')}
      </select>
    </label>
    <input id="mquantity" class="w-full rounded-lg border border-slate-700 bg-slate-950 p-2" type="number" min="1" step="1" placeholder="Quantity">
    <input id="mnote" class="w-full rounded-lg border border-slate-700 bg-slate-950 p-2" placeholder="Note (optional)">
  `;
};

const load = async () => {
  const snap = await getDocs(collection(db, 'auctionOrders'));
  paidOrders = snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((order) => order.status === 'paid');

  paidOrders.sort((a, b) => {
    const aTime = Number(a.paidAt?.seconds || a.createdAt?.seconds || 0);
    const bTime = Number(b.paidAt?.seconds || b.createdAt?.seconds || 0);
    return bTime - aTime;
  });

  renderStats();
  renderPackageTotals();
  renderOrders();
  renderWheelPreview();
};

searchEl.addEventListener('input', renderOrders);
wheelPackageEl.addEventListener('change', renderWheelPreview);

openWheelBtn.addEventListener('click', () => {
  const packageId = wheelPackageEl.value;
  const pkg = packageMap.get(packageId);
  if (!packageId || !pkg) return;

  const names = getEntriesForPackage(packageId);
  if (!names.length) return;

  window.open(buildWheelUrl(pkg, names), '_blank', 'noopener');
});

manualSubmitEl.addEventListener('click', async () => {
  manualErrEl.textContent = '';

  const name = document.getElementById('mname').value.trim();
  const email = document.getElementById('memail').value.trim();
  const phone = document.getElementById('mphone').value.trim();
  const packageId = document.getElementById('mpackage').value;
  const quantity = Math.max(0, Math.floor(Number(document.getElementById('mquantity').value || 0)));
  const note = document.getElementById('mnote').value.trim();
  const pkg = packageMap.get(packageId);

  if (!name || !email || !phone || !pkg || quantity < 1) {
    manualErrEl.textContent = 'Please enter name, email, phone, package, and quantity.';
    return;
  }

  const entries = Object.fromEntries(packages.map((candidate) => [candidate.id, candidate.id === packageId ? quantity : 0]));
  const lineItems = [{
    packageId,
    name: pkg.name,
    quantity,
    unitPrice: Number(pkg.price),
    total: Number(pkg.price) * quantity
  }];

  manualSubmitEl.disabled = true;
  manualSubmitEl.textContent = 'Creating...';
  try {
    await createManual({
      customer: { name, email, phone },
      entries,
      lineItems,
      total: lineItems[0].total,
      note
    });

    manualFormEl.querySelectorAll('input').forEach((input) => {
      input.value = '';
    });

    await load();
  } catch (error) {
    manualErrEl.textContent = error?.message || 'Failed to create manual entry.';
  } finally {
    manualSubmitEl.disabled = false;
    manualSubmitEl.textContent = 'Create Manual Entry';
  }
});

renderManualForm();
renderWheelPackages();
load().catch((error) => {
  ordersInfoEl.textContent = error?.message || 'Failed to load auction orders.';
});
