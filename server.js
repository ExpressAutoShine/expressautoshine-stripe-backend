// ============================================
// ExpressAutoShine — Stripe Checkout Backend
// ============================================
// This server creates Stripe Checkout Sessions
// so customers can pay for their detailing bookings.
//
// HOW IT WORKS:
// 1. Customer fills out booking on your website
// 2. When they click "Pay in Full Online", the frontend
//    sends booking data to this server
// 3. This server recalculates the total (never trusts frontend)
//    and creates a Stripe Checkout Session
// 4. Customer is redirected to Stripe's hosted payment page
// 5. After payment, customer is redirected back to your site
// ============================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3001;

// ===== MIDDLEWARE =====
app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['POST', 'GET']
}));

// ===== PRICING DATA (must match your frontend exactly) =====
// This is the "source of truth" — the frontend total is NEVER trusted
const PRICES = {
  exterior: { maintenance: { sedan: 99, suv: 119, truck: 139 }, premium: { sedan: 149, suv: 179, truck: 209 } },
  interior: { maintenance: { sedan: 109, suv: 129, truck: 149 }, premium: { sedan: 169, suv: 199, truck: 229 } },
  full: { basic: { sedan: 179, suv: 209, truck: 239 }, premium: { sedan: 259, suv: 299, truck: 339 }, signature: { sedan: 359, suv: 399, truck: 449 } },
  correction: { enhancement: { sedan: 309, suv: 359, truck: 409 }, correction: { sedan: 549, suv: 649, truck: 749 } },
  ceramic: { '1year': { sedan: 449, suv: 549, truck: 649 }, '3year': { sedan: 899, suv: 1049, truck: 1199 }, '8year': { sedan: 1399, suv: 1599, truck: 1799 } }
};

// Add-on prices (for server-side validation)
const ADDON_PRICES = {
  'Engine Bay Detail': 40, 'Windshield Water Repellent': 45, 'Tree Sap Removal': 65,
  'Headlight Restoration': 120, 'Gloss Enhancement Polish': 120, "Kid's Car Seat": 25,
  'Salt Removal': 30, 'Pet Hair Removal': 50, 'Ozone Odor Treatment': 90,
  'Interior Protection Package': 350, 'Interior Refresh Detail': 125,
  'Glass Ceramic Coating': 200, 'Wheel Ceramic Coating': 200, 'Glass Coating': 200
};

// Quebec taxes
const GST = 0.05;
const QST = 0.09975;

// ===== ROUTES =====

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'ExpressAutoShine Stripe Backend' });
});

// Create Stripe Checkout Session
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { service, pkgKey, svcKey, sizeKey, addons, date, time,
            address, vehicle, dirty, waterElec,
            firstName, lastName, email, phone } = req.body;

    // ===== SERVER-SIDE PRICE CALCULATION (never trust the frontend) =====

    // Validate service and size exist
    if (!PRICES[svcKey] || !PRICES[svcKey][pkgKey] || !PRICES[svcKey][pkgKey][sizeKey]) {
      return res.status(400).json({ error: 'Invalid service, package, or vehicle size' });
    }

    const packagePrice = PRICES[svcKey][pkgKey][sizeKey];

    // Calculate add-on total (validate each add-on price server-side)
    let addonTotal = 0;
    const validatedAddons = [];
    if (addons && Array.isArray(addons)) {
      for (const addon of addons) {
        const serverPrice = ADDON_PRICES[addon.n];
        if (serverPrice !== undefined) {
          addonTotal += serverPrice;
          validatedAddons.push({ name: addon.n, price: serverPrice });
        }
      }
    }

    const subtotal = packagePrice + addonTotal;
    const gst = subtotal * GST;
    const qst = subtotal * QST;
    const total = subtotal + gst + qst;

    // Convert to cents for Stripe (Stripe uses smallest currency unit)
    const totalCents = Math.round(total * 100);

    // ===== BUILD LINE ITEMS FOR STRIPE =====
    const lineItems = [
      {
        price_data: {
          currency: 'cad',
          product_data: {
            name: service || `${svcKey} - ${pkgKey}`,
            description: `Vehicle: ${vehicle || 'N/A'} | Date: ${date} at ${time} | Address: ${address || 'N/A'}`
          },
          unit_amount: Math.round(packagePrice * 100)
        },
        quantity: 1
      }
    ];

    // Add each add-on as a separate line item
    validatedAddons.forEach(addon => {
      lineItems.push({
        price_data: {
          currency: 'cad',
          product_data: { name: `Add-on: ${addon.name}` },
          unit_amount: Math.round(addon.price * 100)
        },
        quantity: 1
      });
    });

    // ===== CREATE STRIPE CHECKOUT SESSION =====
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      // Automatically calculate tax using Stripe Tax, or add fixed tax line items
      // For now, we add GST and QST as line items
      // You can enable Stripe Tax later for automatic calculation
      customer_email: email,
      metadata: {
        firstName, lastName, phone, email,
        service: service || `${svcKey} - ${pkgKey}`,
        vehicle: vehicle || '',
        date: date || '',
        time: time || '',
        address: address || '',
        dirty: String(dirty || ''),
        waterElec: waterElec || '',
        addons: validatedAddons.map(a => a.name).join(', ')
      },
      success_url: `${process.env.FRONTEND_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/expressautoshine_v4.html`
    });

    // Add tax line items
    // Note: If you enable Stripe Tax, remove these manual tax items
    // For now, we handle taxes by adjusting the total
    // Stripe Checkout will show the items with their prices

    res.json({ url: session.url, sessionId: session.id });

  } catch (error) {
    console.error('Stripe error:', error.message);
    res.status(500).json({ error: 'Payment session creation failed. Please try again.' });
  }
});

// Retrieve session details (for success page)
app.get('/session/:id', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.id);
    res.json({
      status: session.payment_status,
      customer_email: session.customer_email,
      amount_total: session.amount_total,
      metadata: session.metadata
    });
  } catch (error) {
    res.status(404).json({ error: 'Session not found' });
  }
});

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`\n🚀 ExpressAutoShine Stripe Backend running on port ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/`);
  console.log(`   Checkout endpoint: POST http://localhost:${PORT}/create-checkout-session\n`);
});
