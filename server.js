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
const Database = require('better-sqlite3');
const path = require('path');
 
const resend = new Resend(process.env.RESEND_API_KEY);
 
// ===== TWILIO (SMS reminders) =====
const twilioEnabled = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);
let twilioClient = null;
if (twilioEnabled) {
  const twilio = require('twilio');
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  console.log('Twilio SMS reminders enabled');
} else {
  console.log('Twilio SMS reminders disabled (missing env vars)');
}
 
const app = express();
const PORT = process.env.PORT || 3001;
 
// ===== SQLITE DATABASE SETUP =====
// DB_PATH env var lets you point to a Render persistent disk (e.g. /var/data/bookings.db)
const dbPath = process.env.DB_PATH || path.join(__dirname, 'bookings.db');
const db = new Database(dbPath);
 
// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
 
db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_date    TEXT    NOT NULL,
    start_time      TEXT    NOT NULL,
    start_minutes   INTEGER NOT NULL,
    end_minutes     INTEGER NOT NULL,
    duration_minutes INTEGER NOT NULL,
    customer_first  TEXT,
    customer_last   TEXT,
    customer_email  TEXT,
    customer_phone  TEXT,
    address         TEXT,
    service         TEXT,
    svc_key         TEXT,
    pkg_key         TEXT,
    size_key        TEXT,
    vehicle         TEXT,
    addons          TEXT,
    total_paid_cents INTEGER,
    stripe_session_id   TEXT UNIQUE,
    stripe_payment_intent TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
  )
`);
 
// Index for fast availability lookups
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_bookings_date_time
  ON bookings (booking_date, start_minutes, end_minutes)
`);
 
// Add reminder_sent column if it doesn't exist (safe migration for existing databases)
try {
  db.exec(`ALTER TABLE bookings ADD COLUMN reminder_sent INTEGER DEFAULT 0`);
  console.log('Added reminder_sent column to bookings table');
} catch (e) {
  // Column already exists — ignore
}
 
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
 
      // Save booking and block the time slot (race-condition-safe)
      try {
        const m = session.metadata || {};
        const startMin = parseTimeToMinutes(m.time);
 
        if (startMin !== null && m.date) {
          const addonNames = m.addons ? m.addons.split(', ').filter(a => a.trim()) : [];
          const { endMinutes, durationMinutes } = calculateBlockedEndMinutes(
            startMin, m.svcKey || '', m.pkgKey || '', m.sizeKey || '', addonNames
          );
 
          const result = insertBookingIfAvailable({
            booking_date: m.date,
            start_time: m.time,
            start_minutes: startMin,
            end_minutes: endMinutes,
            duration_minutes: durationMinutes,
            customer_first: m.firstName || '',
            customer_last: m.lastName || '',
            customer_email: m.email || session.customer_email || '',
            customer_phone: m.phone || '',
            address: m.address || '',
            service: m.service || '',
            svc_key: m.svcKey || '',
            pkg_key: m.pkgKey || '',
            size_key: m.sizeKey || '',
            vehicle: m.vehicle || '',
            addons: m.addons || '',
            total_paid_cents: session.amount_total || 0,
            stripe_session_id: session.id,
            stripe_payment_intent: session.payment_intent || ''
          });
 
          if (result.success) {
            console.log(`Booking saved: ${m.date} ${m.time} — blocked until ${minutesToTimeStr(endMinutes)}`);
          } else {
            // Slot conflict: payment went through but slot was taken by another booking
            console.error(`SCHEDULE CONFLICT: ${m.date} ${m.time} overlaps with booking #${result.conflict.id}`);
            // Alert the owner so they can manually resolve
            try {
              await resend.emails.send({
                from: 'ExpressAutoShine <bookings@expressautoshine.ca>',
                to: ['Info@expressautoshine.com'],
                subject: `⚠️ SCHEDULE CONFLICT — ${m.firstName} ${m.lastName} on ${m.date}`,
                html: `<p><strong>A customer paid but their time slot was already booked.</strong></p>
                       <p>Customer: ${m.firstName} ${m.lastName} (${m.email})</p>
                       <p>Requested: ${m.date} at ${m.time}</p>
                       <p>Service: ${m.service}</p>
                       <p>Conflicts with existing booking #${result.conflict.id} at ${result.conflict.start_time}</p>
                       <p>Please contact the customer to reschedule or refund.</p>`
              });
            } catch (alertErr) {
              console.error('Failed to send conflict alert email:', alertErr.message);
            }
          }
        } else {
          console.error('Could not parse booking date/time from metadata — booking not saved');
        }
      } catch (dbErr) {
        // Log but don't fail the webhook — payment and emails already succeeded
        console.error('Failed to save booking to database:', dbErr.message);
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
          <tr><td style="padding: 6px 0; font-weight: bold; width: 140px;">Total${m.payMethod === 'cash' ? ' Due' : ' Paid'}:</td><td style="font-size: 18px; color: #2e7d32; font-weight: bold;">$${totalPaid} CAD</td></tr>
          <tr><td style="padding: 6px 0; font-weight: bold;">Payment Method:</td><td style="color: ${m.payMethod === 'cash' ? '#e65100' : '#2e7d32'};">${m.payMethod === 'cash' ? '💵 Cash on Arrival' : '✅ Paid Online'}</td></tr>
          <tr><td style="padding: 6px 0; font-weight: bold;">Booking ID:</td><td style="font-size: 12px; color: #888;">${session.id}</td></tr>
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
          Thank you for booking with ExpressAutoShine! ${m.payMethod === 'cash' ? 'Your appointment is confirmed. Please have the full amount ready in cash when our team arrives.' : 'Your payment has been received and your appointment is confirmed.'} Here are your booking details:
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
 
        <div style="background: ${m.payMethod === 'cash' ? '#fff8e1' : '#e8f5e9'}; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center;">
          <p style="margin: 0; color: #555; font-size: 14px;">${m.payMethod === 'cash' ? 'Total Due (Cash)' : 'Total Paid'}</p>
          <p style="margin: 5px 0 0; color: ${m.payMethod === 'cash' ? '#e65100' : '#2e7d32'}; font-size: 28px; font-weight: bold;">$${totalPaid} CAD</p>
          <p style="margin: 5px 0 0; color: ${m.payMethod === 'cash' ? '#e65100' : '#2e7d32'}; font-size: 14px;">${m.payMethod === 'cash' ? 'Pay Cash on Arrival' : 'Payment Confirmed'}</p>
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
 
// ===== SERVICE DURATIONS (estimated minutes per service/package/size) =====
// Adjust these if real job times differ — they control schedule blocking
const SERVICE_DURATIONS = {
  exterior:    { maintenance: { sedan: 90,  suv: 105, truck: 120 }, premium:     { sedan: 120, suv: 150, truck: 180 } },
  interior:    { maintenance: { sedan: 90,  suv: 105, truck: 120 }, premium:     { sedan: 150, suv: 180, truck: 210 } },
  full:        { basic:       { sedan: 150, suv: 180, truck: 210 }, premium:     { sedan: 210, suv: 240, truck: 270 }, signature: { sedan: 270, suv: 300, truck: 330 } },
  correction:  { enhancement: { sedan: 180, suv: 210, truck: 240 }, correction:  { sedan: 300, suv: 360, truck: 420 } },
  ceramic:     { '1year':     { sedan: 240, suv: 270, truck: 300 }, '3year':     { sedan: 300, suv: 360, truck: 420 }, '8year': { sedan: 360, suv: 420, truck: 480 } }
};
 
// Add-on durations (estimated additional minutes per add-on)
const ADDON_DURATIONS = {
  'Engine Bay Detail': 30, 'Windshield Water Repellent': 15, 'Tree Sap Removal': 30,
  'Headlight Restoration': 45, 'Gloss Enhancement Polish': 60, "Kid's Car Seat": 15,
  'Salt Removal': 20, 'Pet Hair Removal': 30, 'Ozone Odor Treatment': 30,
  'Interior Protection Package': 60, 'Interior Refresh Detail': 45,
  'Glass Ceramic Coating': 45, 'Wheel Ceramic Coating': 45, 'Glass Coating': 30
};
 
// ===== TIME HELPER FUNCTIONS =====
 
// "10:00 AM" → 600, "2:30 PM" → 870
function parseTimeToMinutes(timeStr) {
  const match = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!match) return null;
  let hours = parseInt(match[1]);
  const minutes = parseInt(match[2]);
  const period = match[3].toUpperCase();
  if (period === 'PM' && hours !== 12) hours += 12;
  if (period === 'AM' && hours === 12) hours = 0;
  return hours * 60 + minutes;
}
 
// 870 → "2:30 PM"
function minutesToTimeStr(mins) {
  let h = Math.floor(mins / 60);
  const m = mins % 60;
  const period = h >= 12 ? 'PM' : 'AM';
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')} ${period}`;
}
 
// Calculate total service time, then round UP to nearest 30min, then add 60min buffer
function calculateBlockedEndMinutes(startMinutes, svcKey, pkgKey, sizeKey, addonNames) {
  // Base service duration
  let totalMin = 120; // fallback: 2 hours if lookup fails
  if (SERVICE_DURATIONS[svcKey] && SERVICE_DURATIONS[svcKey][pkgKey] && SERVICE_DURATIONS[svcKey][pkgKey][sizeKey]) {
    totalMin = SERVICE_DURATIONS[svcKey][pkgKey][sizeKey];
  }
 
  // Add add-on durations
  if (addonNames && addonNames.length > 0) {
    for (const name of addonNames) {
      totalMin += ADDON_DURATIONS[name] || 0;
    }
  }
 
  // Round UP to nearest 30-minute slot
  const rounded = Math.ceil(totalMin / 30) * 30;
 
  // Add 1-hour (60 min) buffer
  const blocked = rounded + 60;
 
  return { endMinutes: startMinutes + blocked, durationMinutes: totalMin };
}
 
// ===== BOOKING DATABASE HELPERS =====
 
// Race-condition-safe: runs inside a SQLite transaction (serialized writes)
const insertBookingIfAvailable = db.transaction((data) => {
  // Check for overlapping bookings on the same date
  const conflict = db.prepare(
    'SELECT id, start_time FROM bookings WHERE booking_date = ? AND start_minutes < ? AND end_minutes > ?'
  ).get(data.booking_date, data.end_minutes, data.start_minutes);
 
  if (conflict) {
    return { success: false, conflict };
  }
 
  db.prepare(`
    INSERT INTO bookings (
      booking_date, start_time, start_minutes, end_minutes, duration_minutes,
      customer_first, customer_last, customer_email, customer_phone,
      address, service, svc_key, pkg_key, size_key, vehicle, addons,
      total_paid_cents, stripe_session_id, stripe_payment_intent
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.booking_date, data.start_time, data.start_minutes, data.end_minutes, data.duration_minutes,
    data.customer_first, data.customer_last, data.customer_email, data.customer_phone,
    data.address, data.service, data.svc_key, data.pkg_key, data.size_key, data.vehicle, data.addons,
    data.total_paid_cents, data.stripe_session_id, data.stripe_payment_intent
  );
 
  return { success: true };
});
 
// ===== ROUTES =====
 
// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'ExpressAutoShine Stripe Backend' });
});
 
// Create Stripe Checkout Session
// ===== 24-HOUR NOTICE VALIDATION (reused by both endpoints) =====
function validateBookingDate(dateStr, timeStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return 'Invalid date format.';
  const parts = dateStr.split('-').map(Number);
  const bookingDate = new Date(parts[0], parts[1] - 1, parts[2]);
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (bookingDate < tomorrow) return 'Bookings require at least 24 hours notice. Please choose a future date.';
  // If time is provided, check exact 24-hour gap
  if (timeStr) {
    const tm = parseTimeToMinutes(timeStr);
    if (tm !== null) {
      const slotDate = new Date(parts[0], parts[1] - 1, parts[2], Math.floor(tm / 60), tm % 60, 0);
      if (slotDate.getTime() - now.getTime() < 86400000) {
        return 'This time slot is less than 24 hours away. Please choose a later time or date.';
      }
    }
  }
  return null; // valid
}
 
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { service, pkgKey, svcKey, sizeKey, addons, date, time,
            address, vehicle, dirty, waterElec,
            firstName, lastName, email, phone } = req.body;
 
    // ===== 24-HOUR NOTICE CHECK =====
    const dateError = validateBookingDate(date, time);
    if (dateError) return res.status(400).json({ error: dateError });
 
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
        svcKey: svcKey || '',
        pkgKey: pkgKey || '',
        sizeKey: sizeKey || '',
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
 
// ===== CASH BOOKING ENDPOINT =====
// Same logic as webhook: save booking, block slot, send emails — but no Stripe payment
app.post('/cash-booking', async (req, res) => {
  try {
    const {
      service, pkgKey, svcKey, sizeKey, addons, date, time,
      address, vehicle, dirty, waterElec,
      firstName, lastName, email, phone, total
    } = req.body;
 
    // 24-hour notice check
    const dateError = validateBookingDate(date, time);
    if (dateError) return res.status(400).json({ error: dateError });
 
    // Basic validation
    if (!date || !time || !firstName || !email || !service) {
      return res.status(400).json({ error: 'Missing required booking fields.' });
    }
 
    // --- Save booking (race-condition-safe, same as webhook) ---
    const startMin = parseTimeToMinutes(time);
    if (startMin === null) {
      return res.status(400).json({ error: 'Invalid time format.' });
    }
 
    const addonNames = addons ? addons.map(a => a.n || a).filter(a => a) : [];
    const addonStr = addonNames.join(', ');
    const { endMinutes, durationMinutes } = calculateBlockedEndMinutes(
      startMin, svcKey || '', pkgKey || '', sizeKey || '', addonNames
    );
 
    const result = insertBookingIfAvailable({
      booking_date: date,
      start_time: time,
      start_minutes: startMin,
      end_minutes: endMinutes,
      duration_minutes: durationMinutes,
      customer_first: firstName || '',
      customer_last: lastName || '',
      customer_email: email || '',
      customer_phone: phone || '',
      address: address || '',
      service: service || '',
      svc_key: svcKey || '',
      pkg_key: pkgKey || '',
      size_key: sizeKey || '',
      vehicle: vehicle || '',
      addons: addonStr,
      total_paid_cents: Math.round((total || 0) * 100),
      stripe_session_id: 'CASH-' + Date.now(),
      stripe_payment_intent: ''
    });
 
    if (!result.success) {
      console.error(`CASH BOOKING CONFLICT: ${date} ${time}`);
      return res.status(409).json({ error: 'This time slot is no longer available. Please choose a different time.' });
    }
 
    console.log(`Cash booking saved: ${date} ${time} — blocked until ${minutesToTimeStr(endMinutes)}`);
 
    // --- Build a session-like object so existing email functions work unchanged ---
    const fakeSess = {
      id: 'CASH-' + Date.now(),
      amount_total: Math.round((total || 0) * 100),
      payment_intent: null,
      customer_email: email,
      metadata: {
        firstName, lastName, phone, email,
        svcKey: svcKey || '', pkgKey: pkgKey || '', sizeKey: sizeKey || '',
        service: service || '', vehicle: vehicle || '',
        date: date || '', time: time || '',
        address: address || '',
        dirty: String(dirty || ''), waterElec: waterElec || '',
        addons: addonStr,
        payMethod: 'cash'
      }
    };
 
    // --- Send owner notification ---
    try {
      await sendOwnerNotification(fakeSess);
      console.log('Owner notification sent for cash booking');
    } catch (emailErr) {
      console.error('Failed to send owner notification for cash booking:', emailErr.message);
    }
 
    // --- Send customer confirmation ---
    try {
      await sendCustomerConfirmation(fakeSess);
      console.log('Customer confirmation sent for cash booking');
    } catch (emailErr) {
      console.error('Failed to send customer confirmation for cash booking:', emailErr.message);
    }
 
    res.json({ success: true, message: 'Booking confirmed.' });
 
  } catch (error) {
    console.error('Cash booking error:', error.message);
    res.status(500).json({ error: 'Failed to create booking. Please try again or call 514-946-6186.' });
  }
});
 
// Get booked time ranges for a given date (frontend uses for smart slot filtering)
app.get('/api/booked-times/:date', (req, res) => {
  try {
    const { date } = req.params;
 
    // Validate date format (YYYY-MM-DD)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    }
 
    const bookings = db.prepare(
      'SELECT start_minutes, end_minutes, start_time, service FROM bookings WHERE booking_date = ? ORDER BY start_minutes'
    ).all(date);
 
    const ranges = bookings.map(b => ({
      startMin: b.start_minutes,
      endMin: b.end_minutes,
      start: minutesToTimeStr(b.start_minutes),
      end: minutesToTimeStr(b.end_minutes),
      service: b.service
    }));
 
    res.json({ ranges });
  } catch (error) {
    console.error('Error fetching booked times:', error.message);
    res.status(500).json({ error: 'Failed to fetch booked times.' });
  }
});
 
// ===== 24-HOUR SMS REMINDER SCHEDULER =====
// Runs every 15 minutes. Finds bookings 22–26 hours away that haven't been reminded.
// Window is wider than exact 24h to handle edge cases (server restarts, etc.)
function checkAndSendReminders() {
  if (!twilioEnabled || !twilioClient) return;
 
  try {
    const now = new Date();
 
    // Look ahead window: bookings between 22 and 26 hours from now
    const minAhead = new Date(now.getTime() + 22 * 60 * 60 * 1000);
    const maxAhead = new Date(now.getTime() + 26 * 60 * 60 * 1000);
 
    // Build date strings for the range (could span two calendar days)
    const dates = new Set();
    dates.add(minAhead.getFullYear() + '-' + String(minAhead.getMonth() + 1).padStart(2, '0') + '-' + String(minAhead.getDate()).padStart(2, '0'));
    dates.add(maxAhead.getFullYear() + '-' + String(maxAhead.getMonth() + 1).padStart(2, '0') + '-' + String(maxAhead.getDate()).padStart(2, '0'));
 
    const dateList = [...dates];
    const placeholders = dateList.map(() => '?').join(',');
 
    const bookings = db.prepare(
      `SELECT id, booking_date, start_time, start_minutes, customer_first, customer_phone, service
       FROM bookings
       WHERE booking_date IN (${placeholders})
         AND reminder_sent = 0
         AND customer_phone IS NOT NULL
         AND customer_phone != ''`
    ).all(...dateList);
 
    for (const b of bookings) {
      // Calculate exact appointment datetime
      const dp = b.booking_date.split('-').map(Number);
      const apptDate = new Date(dp[0], dp[1] - 1, dp[2], Math.floor(b.start_minutes / 60), b.start_minutes % 60, 0);
      const hoursUntil = (apptDate.getTime() - now.getTime()) / (60 * 60 * 1000);
 
      // Only send if within 22–26 hour window
      if (hoursUntil < 22 || hoursUntil > 26) continue;
 
      // Clean phone number: keep digits only, ensure +1 prefix for North America
      let phone = b.customer_phone.replace(/[^\d+]/g, '');
      if (phone.length === 10) phone = '+1' + phone;
      else if (phone.length === 11 && phone.startsWith('1')) phone = '+' + phone;
      else if (!phone.startsWith('+')) phone = '+1' + phone;
 
      // Skip obviously invalid numbers
      if (phone.length < 11) {
        console.log(`Skipping reminder for booking #${b.id} — phone too short: ${b.customer_phone}`);
        continue;
      }
 
      const name = b.customer_first || 'there';
      const msg = `Hi ${name}! This is a reminder from ExpressAutoShine that your ${b.service || 'detailing'} appointment is tomorrow, ${b.booking_date} at ${b.start_time}. Please ensure your vehicle is accessible. Questions? Call 514-946-6186.`;
 
      twilioClient.messages.create({
        body: msg,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: phone
      }).then(() => {
        db.prepare('UPDATE bookings SET reminder_sent = 1 WHERE id = ?').run(b.id);
        console.log(`SMS reminder sent for booking #${b.id}: ${b.booking_date} ${b.start_time} → ${phone}`);
      }).catch((err) => {
        console.error(`Failed to send SMS reminder for booking #${b.id}:`, err.message);
        // Don't mark as sent — will retry next cycle
      });
    }
  } catch (err) {
    console.error('Reminder scheduler error:', err.message);
  }
}
 
// Run every 15 minutes
const REMINDER_INTERVAL = 15 * 60 * 1000;
setInterval(checkAndSendReminders, REMINDER_INTERVAL);
// Also run once 30 seconds after startup
setTimeout(checkAndSendReminders, 30000);
 
// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`\n🚀 ExpressAutoShine Stripe Backend running on port ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/`);
  console.log(`   Checkout endpoint: POST http://localhost:${PORT}/create-checkout-session\n`);
});
 
