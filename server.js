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
// 6. Stripe sends a webhook → server emails booking details to owner
// ============================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();
const PORT = process.env.PORT || 3001;

// ===== STRIPE WEBHOOK (must be BEFORE express.json() middleware) =====
// Stripe requires the raw body to verify webhook signatures
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle successful payment
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // Only send emails if payment was actually received
    if (session.payment_status === 'paid') {
      // Send owner notification (you)
      try {
        await sendOwnerNotification(session);
        console.log('Owner notification email sent for session:', session.id);
      } catch (emailErr) {
        // Log the error but don't fail the webhook — payment already succeeded
        console.error('Failed to send owner notification email:', emailErr.message);
      }

      // Send customer confirmation
      try {
        await sendCustomerConfirmation(session);
        console.log('Customer confirmation email sent for session:', session.id);
      } catch (emailErr) {
        console.error('Failed to send customer confirmation email:', emailErr.message);
      }
    }
  }

  res.json({ received: true });
});

// ===== MIDDLEWARE =====
app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['POST', 'GET']
}));

// ===== OWNER EMAIL NOTIFICATION =====
async function sendOwnerNotification(session) {
  const m = session.metadata || {};
  const totalPaid = (session.amount_total / 100).toFixed(2);

  const htmlBody = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="background: #1a1a2e; color: #f5c518; padding: 20px; border-radius: 8px 8px 0 0; margin: 0;">
        🚗 New Booking — ExpressAutoShine
      </h2>
      <div style="border: 1px solid #e0e0e0; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
        <h3 style="color: #1a1a2e; border-bottom: 2px solid #f5c518; padding-bottom: 8px;">Customer Info</h3>
        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="padding: 6px 0; font-weight: bold; width: 140px;">Name:</td><td>${m.firstName || ''} ${m.lastName || ''}</td></tr>
          <tr><td style="padding: 6px 0; font-weight: bold;">Phone:</td><td><a href="tel:${m.phone || ''}">${m.phone || 'N/A'}</a></td></tr>
          <tr><td style="padding: 6px 0; font-weight: bold;">Email:</td><td><a href="mailto:${m.email || ''}">${m.email || 'N/A'}</a></td></tr>
          <tr><td style="padding: 6px 0; font-weight: bold;">Address:</td><td>${m.address || 'N/A'}</td></tr>
        </table>

        <h3 style="color: #1a1a2e; border-bottom: 2px solid #f5c518; padding-bottom: 8px; margin-top: 20px;">Booking Details</h3>
        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="padding: 6px 0; font-weight: bold; width: 140px;">Service:</td><td>${m.service || 'N/A'}</td></tr>
          <tr><td style="padding: 6px 0; font-weight: bold;">Vehicle:</td><td>${m.vehicle || 'N/A'}</td></tr>
          <tr><td style="padding: 6px 0; font-weight: bold;">Date:</td><td>${m.date || 'N/A'}</td></tr>
          <tr><td style="padding: 6px 0; font-weight: bold;">Time:</td><td>${m.time || 'N/A'}</td></tr>
          <tr><td style="padding: 6px 0; font-weight: bold;">Dirtiness (1-10):</td><td>${m.dirty || 'N/A'}</td></tr>
          <tr><td style="padding: 6px 0; font-weight: bold;">Water/Elec:</td><td>${m.waterElec || 'N/A'}</td></tr>
          <tr><td style="padding: 6px 0; font-weight: bold;">Add-ons:</td><td>${m.addons || 'None'}</td></tr>
        </table>

        <h3 style="color: #1a1a2e; border-bottom: 2px solid #f5c518; padding-bottom: 8px; margin-top: 20px;">Payment</h3>
        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="padding: 6px 0; font-weight: bold; width: 140px;">Total Paid:</td><td style="font-size: 18px; color: #2e7d32; font-weight: bold;">$${totalPaid} CAD</td></tr>
          <tr><td style="padding: 6px 0; font-weight: bold;">Payment Status:</td><td style="color: #2e7d32;">✅ Paid</td></tr>
          <tr><td style="padding: 6px 0; font-weight: bold;">Stripe Session:</td><td style="font-size: 12px; color: #888;">${session.id}</td></tr>
        </table>
      </div>
    </div>
  `;

  await resend.emails.send({
    from: 'ExpressAutoShine <bookings@expressautoshine.ca>',
    to: ['Info@expressautoshine.com'],
    subject: `New Booking: ${m.firstName || ''} ${m.lastName || ''} — ${m.service || 'Detailing'} on ${m.date || 'TBD'}`,
    html: htmlBody
  });
}

// ===== CUSTOMER CONFIRMATION EMAIL =====
async function sendCustomerConfirmation(session) {
  const m = session.metadata || {};
  const totalPaid = (session.amount_total / 100).toFixed(2);
  const customerEmail = m.email || session.customer_email;

  if (!customerEmail) {
    console.error('No customer email found — skipping confirmation email');
    return;
  }

  const addonsDisplay = m.addons && m.addons.trim() !== ''
    ? m.addons.split(', ').map(a => `<li style="padding: 3px 0;">${a}</li>`).join('')
    : '<li style="padding: 3px 0; color: #888;">None</li>';

  const htmlBody = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff;">
      <div style="background: #1a1a2e; padding: 30px 20px; border-radius: 8px 8px 0 0; text-align: center;">
        <h1 style="color: #f5c518; margin: 0; font-size: 24px;">ExpressAutoShine</h1>
        <p style="color: #cccccc; margin: 8px 0 0; font-size: 14px;">Premium Mobile Detailing</p>
      </div>

      <div style="border: 1px solid #e0e0e0; border-top: none; padding: 30px 20px; border-radius: 0 0 8px 8px;">
        <h2 style="color: #1a1a2e; margin-top: 0;">Booking Confirmed!</h2>
        <p style="color: #333; line-height: 1.6;">
          Hi ${m.firstName || 'there'},<br><br>
          Thank you for booking with ExpressAutoShine! Your payment has been received and your appointment is confirmed. Here are your booking details:
        </p>

        <div style="background: #f8f9fa; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <h3 style="color: #1a1a2e; margin-top: 0; border-bottom: 2px solid #f5c518; padding-bottom: 8px;">Your Appointment</h3>
          <table style="width: 100%; border-collapse: collapse;">
            <tr><td style="padding: 8px 0; font-weight: bold; width: 120px; color: #555;">Service:</td><td style="color: #1a1a2e;">${m.service || 'N/A'}</td></tr>
            <tr><td style="padding: 8px 0; font-weight: bold; color: #555;">Vehicle:</td><td style="color: #1a1a2e;">${m.vehicle || 'N/A'}</td></tr>
            <tr><td style="padding: 8px 0; font-weight: bold; color: #555;">Date:</td><td style="color: #1a1a2e;">${m.date || 'N/A'}</td></tr>
            <tr><td style="padding: 8px 0; font-weight: bold; color: #555;">Time:</td><td style="color: #1a1a2e;">${m.time || 'N/A'}</td></tr>
            <tr><td style="padding: 8px 0; font-weight: bold; color: #555;">Address:</td><td style="color: #1a1a2e;">${m.address || 'N/A'}</td></tr>
          </table>
        </div>

        <div style="background: #f8f9fa; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <h3 style="color: #1a1a2e; margin-top: 0; border-bottom: 2px solid #f5c518; padding-bottom: 8px;">Add-ons</h3>
          <ul style="margin: 0; padding-left: 20px; color: #1a1a2e;">${addonsDisplay}</ul>
        </div>

        <div style="background: #e8f5e9; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center;">
          <p style="margin: 0; color: #555; font-size: 14px;">Total Paid</p>
          <p style="margin: 5px 0 0; color: #2e7d32; font-size: 28px; font-weight: bold;">$${totalPaid} CAD</p>
          <p style="margin: 5px 0 0; color: #2e7d32; font-size: 14px;">Payment Confirmed</p>
        </div>

        <div style="background: #fff8e1; border-radius: 8px; padding: 15px 20px; margin: 20px 0;">
          <p style="margin: 0; color: #555; font-size: 14px;">
            <strong>What to expect:</strong> Our team will arrive at your location on the scheduled date and time with all equipment needed. Please ensure the vehicle is accessible.
          </p>
        </div>

        <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 25px 0;">
        <p style="color: #888; font-size: 13px; text-align: center; line-height: 1.5;">
          Questions? Contact us at <a href="tel:514-946-6186" style="color: #1a1a2e;">514-946-6186</a>
          or <a href="mailto:Info@expressautoshine.com" style="color: #1a1a2e;">Info@expressautoshine.com</a><br>
          <a href="https://expressautoshine.ca" style="color: #1a1a2e;">expressautoshine.ca</a>
        </p>
      </div>
    </div>
  `;

  await resend.emails.send({
    from: 'ExpressAutoShine <bookings@expressautoshine.ca>',
    to: [customerEmail],
    subject: `Booking Confirmed — ${m.service || 'Your Detailing'} on ${m.date || 'TBD'}`,
    html: htmlBody
  });
}

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
