# Getting your Worker URL — click-by-click (no command line)

**What you are creating:** a tiny free program on Cloudflare's servers. When somebody scans a
QR code, the call page asks it to "ring plate XYZ", and it sends the Firebase push that wakes
the app. Once it exists, the app no longer needs the permanent "online" notification.

**Cost:** free. Cloudflare's Workers free plan gives 100,000 requests per day and needs no
credit card. Firebase stays on the free Spark plan.

**Time:** about 10 minutes.

---

## Step 1 — Get the secret Firebase key (2 min)

1. Open <https://console.firebase.google.com> → project **call-alert-5fadd**.
2. Click the ⚙️ gear (top left) → **Project settings** → tab **Service accounts**.
3. Click **Generate new private key** → **Generate key**. A `.json` file downloads.
4. Open that file in Notepad / any text editor and keep it open — you will paste its whole
   content in step 4.

> ⚠️ This file **is** secret (unlike `google-services.json`). Never put it in the repo, never
> paste it in chat. It only goes into Cloudflare's secret box.

## Step 2 — Create the Worker (3 min)

1. Sign up / log in at <https://dash.cloudflare.com> (free, no card).
2. Left menu → **Compute (Workers)** → **Workers & Pages** → **Create** → **Start with Hello World**
   → **Get started**.
3. Name it exactly: `vehicle-call-alert-wake` → **Deploy**.
4. Click **Edit code** (or **</> Edit code** on the worker page).
5. Delete everything in the editor and paste the **entire content** of
   [`server/worker/src/index.js`](worker/src/index.js) from this repository
   (GitHub → open the file → *Copy raw file* button).
6. Click **Deploy** (top right).

At this point the worker page shows its address, something like:

```
https://vehicle-call-alert-wake.yourname.workers.dev
```

**That is the Worker URL I need.**

## Step 3 — Add the storage (KV) (2 min)

The worker remembers "plate → phone" in a Cloudflare KV store.

1. Left menu → **Storage & Databases** → **KV** → **Create a namespace**.
2. Namespace name: `TOKENS` → **Add**.
3. Go back to your worker → **Settings** → **Bindings** → **Add binding** → **KV namespace**.
   * Variable name: `TOKENS`  ← must be exactly this
   * KV namespace: pick the `TOKENS` you just created
4. **Deploy / Save**.

## Step 4 — Add the secret key (2 min)

1. Still in the worker → **Settings** → **Variables and Secrets** → **Add**.
2. Type: **Secret**
   * Variable name: `FIREBASE_SERVICE_ACCOUNT`  ← exactly this
   * Value: paste the **whole JSON text** from the file you downloaded in step 1
     (starts with `{ "type": "service_account"`, ends with `}`)
3. **Save / Deploy**.

## Step 5 — Check it works (30 seconds)

Open this in your browser (your own address + `/health`):

```
https://vehicle-call-alert-wake.yourname.workers.dev/health
```

You should see:

```json
{"ok":true,"service":"vehicle-call-alert-wake"}
```

If you see that, you are done — **send me that URL** (without `/health`) and I finish the rest:
put it in the app as the default, give you the final `index.html` for the call site, and push a
new build.

---

### If something goes wrong

| What you see | Meaning / fix |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT secret is missing` | step 4 was not saved, or the name is misspelled |
| `Cannot read properties of undefined (reading 'get')` | the KV binding is missing or not named `TOKENS` (step 3) |
| `not_registered` when calling | correct — nobody has put that plate online in the app yet |
| Page not found on `/health` | the code was not pasted/deployed (step 2.5–2.6) |

### Prefer the command line?

```bash
cd server/worker
npm install
npx wrangler login
npx wrangler kv namespace create TOKENS      # paste the printed id into wrangler.toml
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT
npx wrangler deploy
```

### Don't want to do this at all?

That's fine — the app already works without it. You keep the always-connected mode: calls arrive
reliably, but Android shows a permanent "online" notification and the phone holds a connection in
the background. Everything else (full-screen calls, missed calls, printing) is unaffected.
