'use strict';

const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const Stripe = require('stripe');
const { Resend } = require('resend');
const Anthropic = require('@anthropic-ai/sdk');
const PDFDocument = require('pdfkit');

// ─── Config ────────────────────────────────────────────────────────────────
const stripe = new Stripe(process.env.STRIPE_SK, { apiVersion: '2024-06-20' });
const resend = new Resend(process.env.RESEND_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

const BASE_URL       = process.env.BASE_URL       || 'https://localrank-bot.onrender.com';
const FROM_EMAIL     = process.env.FROM_EMAIL     || 'service@localrank.de';
const NOTIFY_EMAIL   = process.env.NOTIFY_EMAIL   || 'kutschenreuter1990@gmail.com';
const GOOGLE_KEY     = process.env.GOOGLE_PLACES_KEY;
const ORDERS_FILE    = path.join(__dirname, 'orders.json');
const WEBHOOK_SECRET = process.env.STRIPE_WH;

// ─── Packages ───────────────────────────────────────────────────────────────
const PACKAGES = {
  // Standbein B: Lead-Listen (einmalig)
  starter_25: {
    name: 'Lead-Liste Starter',
    subtitle: '25 qualifizierte Leads',
    priceEur: 14900,
    type: 'leads',
    maxEntries: 25,
    branches: 1,
    mode: 'payment',
  },
  profi_75: {
    name: 'Lead-Liste Profi',
    subtitle: '75 qualifizierte Leads',
    priceEur: 29900,
    type: 'leads',
    maxEntries: 75,
    branches: 3,
    mode: 'payment',
  },
  premium_200: {
    name: 'Lead-Liste Premium',
    subtitle: '200 qualifizierte Leads',
    priceEur: 49900,
    type: 'leads',
    maxEntries: 200,
    branches: 5,
    mode: 'payment',
  },
  // Standbein A: GBP-Optimierung (monatlich)
  gbp_basis: {
    name: 'GBP-Optimierung Basis',
    subtitle: '4 Beiträge/Monat',
    priceEur: 4900,
    type: 'gbp',
    postsPerMonth: 4,
    includesReviews: false,
    includesDescription: false,
    mode: 'subscription',
  },
  gbp_wachstum: {
    name: 'GBP-Optimierung Wachstum',
    subtitle: '8 Beiträge + Bewertungsantworten',
    priceEur: 9900,
    type: 'gbp',
    postsPerMonth: 8,
    includesReviews: true,
    includesDescription: false,
    mode: 'subscription',
  },
  gbp_premium: {
    name: 'GBP-Optimierung Premium',
    subtitle: '12 Beiträge + Bewertungen + Beschreibung',
    priceEur: 17900,
    type: 'gbp',
    postsPerMonth: 12,
    includesReviews: true,
    includesDescription: true,
    mode: 'subscription',
  },
};

// ─── Orders persistence ──────────────────────────────────────────────────────
function loadOrders() {
  try {
    return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveOrder(order) {
  const orders = loadOrders();
  orders.push(order);
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

// ─── Google Places API ───────────────────────────────────────────────────────
function searchPlaces(textQuery, pageToken) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      textQuery,
      ...(pageToken ? { pageToken } : {}),
      maxResultCount: 20,
    });
    const options = {
      hostname: 'places.googleapis.com',
      path: '/v1/places:searchText',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_KEY,
        'X-Goog-FieldMask': [
          'places.displayName',
          'places.formattedAddress',
          'places.nationalPhoneNumber',
          'places.websiteUri',
          'places.rating',
          'places.userRatingCount',
          'places.businessStatus',
          'nextPageToken',
        ].join(','),
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function collectLeads(branches, location, maxTotal) {
  const leads = [];
  const seen = new Set();

  for (const branch of branches) {
    if (leads.length >= maxTotal) break;
    let pageToken = null;
    const query = `${branch} in ${location}`;

    do {
      const result = await searchPlaces(query, pageToken);
      const places = result.places || [];
      for (const p of places) {
        if (leads.length >= maxTotal) break;
        const key = p.formattedAddress || p.displayName?.text;
        if (key && !seen.has(key)) {
          seen.add(key);
          leads.push({
            name: p.displayName?.text || '',
            address: p.formattedAddress || '',
            phone: p.nationalPhoneNumber || '',
            website: p.websiteUri || '',
            rating: p.rating || null,
            reviewCount: p.userRatingCount || 0,
            status: p.businessStatus || 'OPERATIONAL',
          });
        }
      }
      pageToken = result.nextPageToken || null;
      // small delay between paginated calls
      if (pageToken) await new Promise((r) => setTimeout(r, 500));
    } while (pageToken && leads.length < maxTotal);
  }

  return leads;
}

// ─── PDF Generation ──────────────────────────────────────────────────────────
function generateLeadPDF(leads, order, pkg) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ margin: 40, size: 'A4' });

    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    doc
      .fontSize(22)
      .fillColor('#1a3c5e')
      .text('LocalRank — Lead-Liste', { align: 'center' });
    doc.moveDown(0.3);
    doc
      .fontSize(12)
      .fillColor('#555')
      .text(`Paket: ${pkg.name}  |  ${leads.length} Einträge`, { align: 'center' });
    doc.moveDown(0.3);
    doc
      .fontSize(10)
      .fillColor('#888')
      .text(
        `Erstellt am: ${new Date().toLocaleDateString('de-DE')}  |  Bestell-ID: ${order.sessionId}`,
        { align: 'center' }
      );
    doc.moveDown(1);

    // DSGVO note
    doc
      .fontSize(8)
      .fillColor('#999')
      .text(
        'Diese Liste enthält ausschließlich öffentlich zugängliche B2B-Kontaktdaten aus Google Maps (Google Places API). ' +
          'Sie dürfen diese Daten ausschließlich für geschäftliche Kontaktaufnahme nutzen. ' +
          'Ein AVV-Vertrag ist auf Anfrage erhältlich.',
        { lineGap: 2 }
      );
    doc.moveDown(1);

    // Table header
    const cols = { name: 40, address: 190, phone: 370, website: 460 };
    const rowH = 30;
    const tableTop = doc.y;

    doc.rect(35, tableTop, 525, rowH).fill('#1a3c5e');
    doc
      .fillColor('#fff')
      .fontSize(9)
      .text('Firma', cols.name, tableTop + 9)
      .text('Adresse', cols.address, tableTop + 9)
      .text('Telefon', cols.phone, tableTop + 9)
      .text('Website', cols.website, tableTop + 9);

    let y = tableTop + rowH;

    leads.forEach((lead, i) => {
      if (y > 760) {
        doc.addPage();
        y = 40;
      }
      const bg = i % 2 === 0 ? '#f5f8fc' : '#ffffff';
      doc.rect(35, y, 525, rowH).fill(bg);
      doc
        .fillColor('#222')
        .fontSize(8)
        .text(lead.name.substring(0, 32), cols.name, y + 6, { width: 145, lineBreak: false })
        .text(lead.address.substring(0, 45), cols.address, y + 6, { width: 175, lineBreak: false })
        .text(lead.phone.substring(0, 20), cols.phone, y + 6, { width: 85, lineBreak: false })
        .text(
          (lead.website || '').replace(/^https?:\/\//, '').substring(0, 28),
          cols.website,
          y + 6,
          { width: 100, lineBreak: false }
        );

      if (lead.rating) {
        doc
          .fillColor('#f5a623')
          .text(`★ ${lead.rating} (${lead.reviewCount})`, cols.name, y + 17, {
            width: 145,
            lineBreak: false,
          });
      }
      y += rowH;
    });

    // Footer
    doc
      .moveDown(2)
      .fontSize(8)
      .fillColor('#aaa')
      .text('LocalRank · service@localrank.de · Powered by Google Places API', { align: 'center' });

    doc.end();
  });
}

// ─── GBP Content via Claude ──────────────────────────────────────────────────
async function generateGBPContent(order, pkg) {
  const businessName = order.metadata?.businessName || 'Ihr Unternehmen';
  const businessType = order.metadata?.businessType || 'lokales Unternehmen';
  const location     = order.metadata?.location || 'Deutschland';

  const postsPrompt = `Du bist ein lokaler SEO-Experte. Erstelle ${pkg.postsPerMonth} Google Business Profile Beiträge für:

Unternehmensname: ${businessName}
Branche: ${businessType}
Standort: ${location}

Anforderungen:
- Jeder Beitrag max. 1500 Zeichen
- Lokale Keywords einbauen (Stadtname + Branche)
- Call-to-Action am Ende
- Abwechslungsreiche Formate: Tipp, Angebot, Neuigkeit, Kundenfokus
- Professionell aber menschlich

Format: Trenne Beiträge mit "---BEITRAG X---"`;

  const postsResponse = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 4000,
    messages: [{ role: 'user', content: postsPrompt }],
  });
  let content = `# GBP-Content für ${businessName}\n\n## ${pkg.postsPerMonth} Google Business Beiträge\n\n`;
  content += postsResponse.content[0].text;

  if (pkg.includesReviews) {
    const reviewPrompt = `Erstelle 10 professionelle Antworten auf Google-Bewertungen für ${businessName} (${businessType}) in ${location}.
Mix aus: 5 positive Bewertungen, 3 neutrale (4 Sterne), 2 kritische (2-3 Sterne).
Jede Antwort max. 300 Zeichen. Trenne mit "---ANTWORT X---"`;

    const reviewResponse = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 2000,
      messages: [{ role: 'user', content: reviewPrompt }],
    });
    content += '\n\n---\n\n## 10 Bewertungsantworten\n\n' + reviewResponse.content[0].text;
  }

  if (pkg.includesDescription) {
    const descPrompt = `Erstelle eine optimierte Google Business Beschreibung für ${businessName} (${businessType}) in ${location}.
Max. 750 Zeichen. Lokale Keywords, USPs, Call-to-Action. SEO-optimiert für lokale Suche.`;

    const descResponse = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 500,
      messages: [{ role: 'user', content: descPrompt }],
    });
    content += '\n\n---\n\n## Optimierte Unternehmensbeschreibung\n\n' + descResponse.content[0].text;
  }

  return content;
}

// ─── Email delivery ──────────────────────────────────────────────────────────
async function sendLeadListEmail(order, pkg, pdfBuffer) {
  const subject = `✅ Ihre ${pkg.name} ist fertig — LocalRank`;
  const html = `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
  <div style="background:#1a3c5e;padding:24px;border-radius:8px 8px 0 0">
    <h1 style="color:#fff;margin:0;font-size:22px">🗺️ LocalRank</h1>
  </div>
  <div style="background:#f9f9f9;padding:32px;border-radius:0 0 8px 8px">
    <h2 style="color:#1a3c5e">Ihre Lead-Liste ist fertig!</h2>
    <p>Vielen Dank für Ihre Bestellung. Im Anhang finden Sie Ihre <strong>${pkg.name}</strong>
    mit bis zu <strong>${pkg.maxEntries} qualifizierten Leads</strong>.</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0">
      <tr><td style="padding:8px;color:#666">Paket</td><td style="padding:8px;font-weight:bold">${pkg.name}</td></tr>
      <tr style="background:#eee"><td style="padding:8px;color:#666">Preis</td><td style="padding:8px">${(pkg.priceEur / 100).toFixed(2)} €</td></tr>
      <tr><td style="padding:8px;color:#666">Bestell-ID</td><td style="padding:8px;font-size:12px">${order.sessionId}</td></tr>
    </table>
    <p style="color:#666;font-size:12px">
      <strong>Hinweis:</strong> Diese Lead-Liste enthält ausschließlich öffentlich zugängliche B2B-Daten
      aus Google Maps. Bitte nutzen Sie die Daten DSGVO-konform für geschäftliche Kontaktaufnahme.
    </p>
    <p>Bei Fragen: <a href="mailto:${FROM_EMAIL}">${FROM_EMAIL}</a></p>
  </div>
</div>`;

  await resend.emails.send({
    from: FROM_EMAIL,
    to: order.customerEmail,
    subject,
    html,
    attachments: [{ filename: `localrank-leads-${Date.now()}.pdf`, content: pdfBuffer.toString('base64') }],
  });

  await resend.emails.send({
    from: FROM_EMAIL,
    to: NOTIFY_EMAIL,
    subject: `[LocalRank] Neue Bestellung: ${pkg.name} — ${order.customerEmail}`,
    html: `<p>Neue Lead-Listen-Bestellung:<br>Paket: ${pkg.name}<br>Kunde: ${order.customerEmail}<br>Session: ${order.sessionId}</p>`,
  });
}

async function sendGBPContentEmail(order, pkg, content) {
  const subject = `✅ Ihr GBP-Content für diesen Monat — LocalRank`;
  const html = `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
  <div style="background:#1a3c5e;padding:24px;border-radius:8px 8px 0 0">
    <h1 style="color:#fff;margin:0;font-size:22px">🗺️ LocalRank</h1>
  </div>
  <div style="background:#f9f9f9;padding:32px;border-radius:0 0 8px 8px">
    <h2 style="color:#1a3c5e">Ihr Google Business Content ist fertig!</h2>
    <p>Ihr monatlicher GBP-Content für <strong>${pkg.name}</strong> ist im Anhang.</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0">
      <tr><td style="padding:8px;color:#666">Paket</td><td style="padding:8px;font-weight:bold">${pkg.name}</td></tr>
      <tr style="background:#eee"><td style="padding:8px;color:#666">Beiträge/Monat</td><td style="padding:8px">${pkg.postsPerMonth}</td></tr>
      ${pkg.includesReviews ? '<tr><td style="padding:8px;color:#666">Bewertungsantworten</td><td style="padding:8px">✅ enthalten</td></tr>' : ''}
      ${pkg.includesDescription ? '<tr style="background:#eee"><td style="padding:8px;color:#666">Unternehmensbeschreibung</td><td style="padding:8px">✅ optimiert</td></tr>' : ''}
    </table>
    <p>Kopieren Sie die Beiträge direkt in Ihr Google Business Profil.
    Wir empfehlen, 1-2 Beiträge pro Woche zu veröffentlichen.</p>
    <p>Bei Fragen: <a href="mailto:${FROM_EMAIL}">${FROM_EMAIL}</a></p>
  </div>
</div>`;

  const contentBuffer = Buffer.from(content, 'utf8');
  await resend.emails.send({
    from: FROM_EMAIL,
    to: order.customerEmail,
    subject,
    html,
    attachments: [{ filename: `gbp-content-${Date.now()}.txt`, content: contentBuffer.toString('base64') }],
  });

  await resend.emails.send({
    from: FROM_EMAIL,
    to: NOTIFY_EMAIL,
    subject: `[LocalRank] GBP-Abo aktiv: ${pkg.name} — ${order.customerEmail}`,
    html: `<p>GBP-Abo gestartet:<br>Paket: ${pkg.name}<br>Kunde: ${order.customerEmail}<br>Session: ${order.sessionId}</p>`,
  });
}

// ─── Order processing ─────────────────────────────────────────────────────────
async function processOrder(order) {
  const pkg = PACKAGES[order.packageKey];
  if (!pkg) {
    console.error('Unknown package key:', order.packageKey);
    return;
  }

  try {
    if (pkg.type === 'leads') {
      console.log(`[LocalRank] Collecting ${pkg.maxEntries} leads for order ${order.sessionId}`);
      const branchList = order.metadata?.branches
        ? order.metadata.branches.split(',').map((b) => b.trim())
        : ['lokales Unternehmen'];
      const location = order.metadata?.location || 'Deutschland';

      const leads = await collectLeads(branchList, location, pkg.maxEntries);
      console.log(`[LocalRank] Collected ${leads.length} leads`);

      const pdfBuffer = await generateLeadPDF(leads, order, pkg);
      await sendLeadListEmail(order, pkg, pdfBuffer);
      console.log(`[LocalRank] Lead PDF sent to ${order.customerEmail}`);
    } else if (pkg.type === 'gbp') {
      console.log(`[LocalRank] Generating GBP content for order ${order.sessionId}`);
      const content = await generateGBPContent(order, pkg);
      await sendGBPContentEmail(order, pkg, content);
      console.log(`[LocalRank] GBP content sent to ${order.customerEmail}`);
    }
  } catch (err) {
    console.error(`[LocalRank] processOrder error for ${order.sessionId}:`, err);
    // Notify admin of failure
    await resend.emails.send({
      from: FROM_EMAIL,
      to: NOTIFY_EMAIL,
      subject: `[LocalRank] ⚠️ Verarbeitung fehlgeschlagen: ${order.sessionId}`,
      html: `<p>Fehler bei Bestellung ${order.sessionId}:<br>${err.message}</p>`,
    }).catch(() => {});
  }
}

// ─── Express App ─────────────────────────────────────────────────────────────
const app = express();

app.get('/health', (req, res) => {
  const orders = loadOrders();
  res.json({ status: 'ok', service: 'localrank', orders: orders.length });
});

// Checkout session creation
app.post('/create-checkout', express.json(), async (req, res) => {
  const { packageKey, customerEmail, location, branches, businessName, businessType } = req.body;
  const pkg = PACKAGES[packageKey];
  if (!pkg) return res.status(400).json({ error: 'Unbekanntes Paket' });

  try {
    const sessionParams = {
      payment_method_types: ['card'],
      customer_email: customerEmail,
      metadata: { packageKey, location: location || '', branches: branches || '', businessName: businessName || '', businessType: businessType || '' },
      success_url: `${BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/cancel`,
    };

    if (pkg.mode === 'payment') {
      sessionParams.mode = 'payment';
      sessionParams.line_items = [{
        price_data: {
          currency: 'eur',
          product_data: { name: pkg.name, description: pkg.subtitle },
          unit_amount: pkg.priceEur,
        },
        quantity: 1,
      }];
    } else {
      sessionParams.mode = 'subscription';
      sessionParams.line_items = [{
        price_data: {
          currency: 'eur',
          product_data: { name: pkg.name, description: pkg.subtitle },
          unit_amount: pkg.priceEur,
          recurring: { interval: 'month' },
        },
        quantity: 1,
      }];
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url });
  } catch (err) {
    console.error('[LocalRank] create-checkout error:', err);
    res.status(500).json({ error: 'Checkout konnte nicht erstellt werden' });
  }
});

// Stripe webhook
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], WEBHOOK_SECRET);
  } catch (err) {
    console.error('[LocalRank] Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const order = {
      sessionId: session.id,
      packageKey: session.metadata?.packageKey,
      customerEmail: session.customer_email,
      amountTotal: session.amount_total,
      currency: session.currency,
      metadata: session.metadata,
      createdAt: new Date().toISOString(),
      mode: session.mode,
    };
    saveOrder(order);
    console.log(`[LocalRank] New order: ${order.packageKey} — ${order.customerEmail}`);
    processOrder(order); // async, don't await
  }

  res.json({ received: true });
});

// Success & cancel pages
app.get('/success', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><title>Bestellung erfolgreich — LocalRank</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0f4f8}
.box{background:#fff;padding:48px;border-radius:12px;text-align:center;max-width:480px;box-shadow:0 4px 24px rgba(0,0,0,.1)}
h1{color:#1a3c5e}p{color:#555;line-height:1.6}.check{font-size:64px}</style></head>
<body><div class="box">
<div class="check">✅</div>
<h1>Vielen Dank!</h1>
<p>Ihre Bestellung wurde erfolgreich aufgenommen.<br>
Sie erhalten Ihr Ergebnis in wenigen Minuten per E-Mail.</p>
<p style="font-size:13px;color:#999">Bei Fragen: service@localrank.de</p>
</div></body></html>`);
});

app.get('/cancel', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><title>Bestellung abgebrochen — LocalRank</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0f4f8}
.box{background:#fff;padding:48px;border-radius:12px;text-align:center;max-width:480px;box-shadow:0 4px 24px rgba(0,0,0,.1)}
h1{color:#1a3c5e}p{color:#555;line-height:1.6}.icon{font-size:64px}</style></head>
<body><div class="box">
<div class="icon">↩️</div>
<h1>Bestellung abgebrochen</h1>
<p>Kein Problem — Ihre Bestellung wurde nicht abgeschlossen und Sie wurden nicht belastet.</p>
<p><a href="javascript:history.back()" style="color:#1a3c5e">← Zurück zur Übersicht</a></p>
</div></body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🗺️  LOCALRANK running on port ${PORT}\n`));
