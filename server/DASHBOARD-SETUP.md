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
5. The editor shows **one** file — usually `worker.js` (sometimes `index.js`) — containing the
   Hello World sample:

   ```js
   export default {
     async fetch(request, env, ctx) {
       return new Response('Hello World!');
     },
   };
   ```

   Click inside it, press **Ctrl+A** (Cmd+A on Mac) and **Delete** so the file is empty.
6. Paste the **entire content** of [`server/worker/worker.paste.js`](worker/worker.paste.js) from
   this repository (GitHub → open the file → *Copy raw file* button). It is the same program as
   `src/index.js`, but written with `//` comments only, so a half-deleted sample cannot break it.

   * Keep the existing file name (`worker.js` is fine) — the name does not matter.
   * Do **not** create a second file: two `export default` blocks in one worker is an error.
   * Do **not** paste `wrangler.toml` anywhere; in the dashboard those settings are the KV
     binding (step 3) and the secret (step 4).
   * After pasting, the **first** line must be `// ====...` and the **last** line must be
     `// END OF FILE`. If you see anything after `// END OF FILE`, delete it — that leftover is
     what causes `Uncaught SyntaxError: Unexpected token '*'`.
   * The editor should show **330 lines** in total.
7. Click **Deploy** (top right). Visiting the URL now may show an error until steps 3 and 4 are
   done — that is expected; `/health` already works.
8. Whenever you add the binding or the secret afterwards, press **Deploy** again so the running
   version picks them up.

At this point the worker page shows its address, something like:

```
https://vehicle-alert.techeditz8.workers.dev
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

Open the **self-check** page in your browser (your address + `/diag`):

```
https://vehicle-alert.techeditz8.workers.dev/diag
```

```json
{"ok":true,"kv":true,"secret":true,"project_id":"call-alert-5fadd","google_auth":"ok",
 "next_step":"Everything is ready - send this worker URL back to the developer."}
```

Any `false` in there tells you which step to redo — `next_step` says it in words.

Note: opening the bare address (without a path) shows `{"ok":false,"error":"not_found"}`.
That is normal — the worker only answers on `/health`, `/diag`, `/status`, `/register`,
`/unregister`, `/ring` and `/cancel`.


Open this in your browser (your own address + `/health`):

```
https://vehicle-alert.techeditz8.workers.dev/health
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

### Updating the worker later

The worker code changes when the app changes. To update: **Workers & Pages -> vehicle-alert ->
Edit code -> Ctrl+A -> Delete -> paste `server/worker/worker.paste.js` -> Deploy.** Bindings and
secrets are kept, so `/diag` should still answer `"ok": true` afterwards.

### After everything is green

1. Upload [`server/website/index.html`](website/index.html) over the call site's `index.html`
   (it already points at your worker). **This is required** - once the app runs in push mode,
   the old page cannot reach a sleeping phone.
2. Install the new APK, add your vehicle, then open
   `https://vehicle-alert.techeditz8.workers.dev/status?plate=YOURPLATE` -
   it must say `"reachable":true`. That proves the phone registered itself.
3. Lock the phone, close the app completely, and call from another device.

Two things that still break push (they are Android limits, not bugs):

* **Force stop.** If the user force-stops the app from Android settings, no push is delivered
  until the app is opened once again.
* **Aggressive battery managers** (Xiaomi, Oppo, Vivo, realme...) may delay pushes. The app's
  Settings screen links to the battery-optimisation page so the user can set it to Unrestricted.

### Don't want to do this at all?

That's fine — the app already works without it. You keep the always-connected mode: calls arrive
reliably, but Android shows a permanent "online" notification and the phone holds a connection in
the background. Everything else (full-screen calls, missed calls, printing) is unaffected.
