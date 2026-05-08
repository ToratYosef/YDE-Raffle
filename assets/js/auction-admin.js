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
const updateAuctionOrder = httpsCallable(fns, 'updateAuctionOrderAdmin');
const deleteAuctionOrder = httpsCallable(fns, 'deleteAuctionOrderAdmin');

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
const openAllWheelsBtn = document.getElementById('openAllWheels');

const packages = window.AUCTION_DATA?.auctionPackages || [];
const packageMap = new Map(packages.map((pkg) => [pkg.id, pkg]));

let paidOrders = [];
let editingOrderId = null;

const toMoney = (amount) => `$${Number(amount || 0).toFixed(2)}`;

const escapeHtml = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

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
    const phone = (order.phone || '').trim() || 'No phone';
    const entryLabel = `${name} - ${phone}`;
    for (let i = 0; i < qty; i += 1) names.push(entryLabel);
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

const buildEditForm = (order) => {
  const entries = getOrderEntries(order);

  return `
    <form class="order-edit-form mt-4 rounded-lg border border-yellow-400/40 bg-slate-950/80 p-4" data-order-id="${order.id}">
      <div class="grid md:grid-cols-3 gap-3">
        <label class="text-sm text-slate-300">Full name
          <input name="name" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 p-2 text-white" value="${escapeHtml(order.name || '')}" required>
        </label>
        <label class="text-sm text-slate-300">Email
          <input name="email" type="email" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 p-2 text-white" value="${escapeHtml(order.email || '')}" required>
        </label>
        <label class="text-sm text-slate-300">Phone
          <input name="phone" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 p-2 text-white" value="${escapeHtml(order.phone || '')}" required>
        </label>
      </div>
      <div class="grid sm:grid-cols-2 lg:grid-cols-5 gap-3 mt-3">
        ${packages.map((pkg) => `
          <label class="text-sm text-slate-300">${escapeHtml(pkg.name)}
            <input name="entry-${pkg.id}" type="number" min="0" step="1" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 p-2 text-white" value="${Number(entries[pkg.id] || 0)}">
          </label>
        `).join('')}
      </div>
      <label class="block text-sm text-slate-300 mt-3">Note
        <input name="note" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 p-2 text-white" value="${escapeHtml(order.note || '')}">
      </label>
      <p class="order-edit-error text-red-300 min-h-6 mt-2"></p>
      <div class="flex flex-wrap gap-2 mt-2">
        <button type="submit" class="bg-yellow-400 hover:bg-yellow-500 text-black font-bold px-4 py-2 rounded-lg transition-colors duration-300">Save Changes</button>
        <button type="button" class="cancel-edit-btn border border-slate-600 hover:border-slate-400 text-slate-200 font-semibold px-4 py-2 rounded-lg transition-colors duration-300">Cancel</button>
      </div>
    </form>
  `;
};

const buildOrderCard = (order) => {
  const lineItems = getOrderLineItems(order);
  const compact = lineItems.map((line) => `${escapeHtml(line.name)}: ${Number(line.quantity || 0)}`).join(' | ');
  const isEditing = editingOrderId === order.id;

  return `
    <div class="rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-3" data-order-id="${order.id}">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p class="text-lg font-semibold text-white">${escapeHtml(order.name || 'Unknown')}</p>
          <p class="text-xs text-slate-300 mt-1">${escapeHtml(order.email || '')} ${escapeHtml(order.phone || '')}</p>
        </div>
        <div class="flex flex-wrap items-center justify-end gap-2">
          <span class="text-xs px-2 py-1 rounded-full border border-slate-600 text-slate-300">${escapeHtml(order.source || 'unknown')}</span>
          <button type="button" class="edit-order-btn text-xs bg-sky-500 hover:bg-sky-400 text-white font-bold px-3 py-1.5 rounded-lg transition-colors duration-300" data-order-id="${order.id}">${isEditing ? 'Editing' : 'Edit'}</button>
          <button type="button" class="delete-order-btn text-xs bg-red-600 hover:bg-red-500 text-white font-bold px-3 py-1.5 rounded-lg transition-colors duration-300" data-order-id="${order.id}">Delete</button>
        </div>
      </div>
      <p class="text-sm text-slate-200 mt-2">${compact || 'No entries'}</p>
      <p class="text-sm text-yellow-300 mt-1 font-semibold">${toMoney(getPaidAmount(order))}</p>
      ${isEditing ? buildEditForm(order) : ''}
    </div>
  `;
};

const renderOrders = () => {
  const search = (searchEl.value || '').toLowerCase();
  const filtered = paidOrders.filter((order) => `${order.name || ''} ${order.email || ''} ${order.phone || ''}`.toLowerCase().includes(search));

  ordersInfoEl.textContent = `${filtered.length} of ${paidOrders.length} paid orders shown`;
  ordersEl.innerHTML = filtered.map(buildOrderCard).join('');
};


const getOrderFromButton = (button) => paidOrders.find((order) => order.id === button?.dataset?.orderId);

const setOrderButtonsDisabled = (orderId, disabled) => {
  ordersEl.querySelectorAll(`[data-order-id="${orderId}"] button`).forEach((button) => {
    button.disabled = disabled;
  });
};

const handleEditSubmit = async (form) => {
  const orderId = form.dataset.orderId;
  const errorEl = form.querySelector('.order-edit-error');
  errorEl.textContent = '';

  const formData = new FormData(form);
  const entries = Object.fromEntries(packages.map((pkg) => {
    const quantity = Math.max(0, Math.floor(Number(formData.get(`entry-${pkg.id}`) || 0)));
    return [pkg.id, quantity];
  }));
  const totalEntries = Object.values(entries).reduce((sum, qty) => sum + Number(qty || 0), 0);

  if (totalEntries < 1) {
    errorEl.textContent = 'Order must include at least one entry.';
    return;
  }

  const customer = {
    name: String(formData.get('name') || '').trim(),
    email: String(formData.get('email') || '').trim(),
    phone: String(formData.get('phone') || '').trim()
  };

  if (!customer.name || !customer.email || !customer.phone) {
    errorEl.textContent = 'Please enter name, email, and phone.';
    return;
  }

  setOrderButtonsDisabled(orderId, true);
  try {
    await updateAuctionOrder({
      orderId,
      customer,
      entries,
      note: String(formData.get('note') || '').trim()
    });
    editingOrderId = null;
    await load();
  } catch (error) {
    errorEl.textContent = error?.message || 'Failed to update order.';
    setOrderButtonsDisabled(orderId, false);
  }
};

ordersEl.addEventListener('click', async (event) => {
  const editButton = event.target.closest('.edit-order-btn');
  const deleteButton = event.target.closest('.delete-order-btn');
  const cancelButton = event.target.closest('.cancel-edit-btn');

  if (editButton) {
    editingOrderId = editingOrderId === editButton.dataset.orderId ? null : editButton.dataset.orderId;
    renderOrders();
    return;
  }

  if (cancelButton) {
    editingOrderId = null;
    renderOrders();
    return;
  }

  if (!deleteButton) return;

  const order = getOrderFromButton(deleteButton);
  if (!order) return;

  const label = `${order.name || 'Unknown'} (${toMoney(getPaidAmount(order))})`;
  if (!confirm(`Delete auction order for ${label}? This cannot be undone.`)) return;

  setOrderButtonsDisabled(order.id, true);
  try {
    await deleteAuctionOrder({ orderId: order.id });
    if (editingOrderId === order.id) editingOrderId = null;
    await load();
  } catch (error) {
    alert(error?.message || 'Failed to delete order.');
    setOrderButtonsDisabled(order.id, false);
  }
});

ordersEl.addEventListener('submit', (event) => {
  const form = event.target.closest('.order-edit-form');
  if (!form) return;

  event.preventDefault();
  handleEditSubmit(form);
});

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
    <div class="md:col-span-3 grid sm:grid-cols-2 lg:grid-cols-5 gap-3 rounded-lg border border-slate-700 bg-slate-950/60 p-3">
      ${packages.map((pkg) => `
        <label class="text-sm text-slate-300">${escapeHtml(pkg.name)} ($${Number(pkg.price || 0)}/entry)
          <input id="mquantity-${pkg.id}" data-manual-package-id="${pkg.id}" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 p-2 text-white" type="number" min="0" step="1" placeholder="0">
        </label>
      `).join('')}
    </div>
    <input id="mnote" class="w-full rounded-lg border border-slate-700 bg-slate-950 p-2 md:col-span-3" placeholder="Note (optional)">
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
  if (!names.length) {
    alert('No paid entries yet for this package.');
    return;
  }

  const wheelUrl = buildWheelUrl(pkg, names);
  const opened = window.open(wheelUrl, '_blank', 'noopener');
  if (!opened) {
    window.location.href = wheelUrl;
  }
});

openAllWheelsBtn.addEventListener('click', () => {
  let openedCount = 0;

  packages.forEach((pkg) => {
    const names = getEntriesForPackage(pkg.id);
    if (!names.length) return;

    const wheelUrl = buildWheelUrl(pkg, names);
    const opened = window.open(wheelUrl, '_blank', 'noopener');
    if (opened) openedCount += 1;
  });

  if (openedCount > 0) return;

  const firstPackageWithEntries = packages.find((pkg) => getEntriesForPackage(pkg.id).length);
  if (!firstPackageWithEntries) {
    alert('No paid entries yet for any package.');
    return;
  }

  const fallbackUrl = buildWheelUrl(firstPackageWithEntries, getEntriesForPackage(firstPackageWithEntries.id));
  window.location.href = fallbackUrl;
});

manualSubmitEl.addEventListener('click', async () => {
  manualErrEl.textContent = '';

  const name = document.getElementById('mname').value.trim();
  const email = document.getElementById('memail').value.trim();
  const phone = document.getElementById('mphone').value.trim();
  const note = document.getElementById('mnote').value.trim();
  const entries = Object.fromEntries(packages.map((pkg) => {
    const input = document.getElementById(`mquantity-${pkg.id}`);
    const quantity = Math.max(0, Math.floor(Number(input?.value || 0)));
    return [pkg.id, quantity];
  }));
  const lineItems = packages
    .map((pkg) => {
      const quantity = Number(entries[pkg.id] || 0);
      if (quantity <= 0) return null;
      const unitPrice = Number(pkg.price || 0);
      return {
        packageId: pkg.id,
        name: pkg.name,
        quantity,
        unitPrice,
        total: unitPrice * quantity
      };
    })
    .filter(Boolean);
  const total = lineItems.reduce((sum, line) => sum + Number(line.total || 0), 0);

  if (!name || !email || !phone || lineItems.length < 1) {
    manualErrEl.textContent = 'Please enter name, email, phone, and at least one package quantity.';
    return;
  }

  manualSubmitEl.disabled = true;
  manualSubmitEl.textContent = 'Creating...';
  try {
    await createManual({
      customer: { name, email, phone },
      entries,
      lineItems,
      total,
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
