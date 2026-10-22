# Sant ke liye: 22 Oct ke changes, aasaan bhasha mein

Ye file batati hai ki is baar kya badla, WhatsApp par ab kya dikhega, aur aapko (ya team ko) kya karna hai. Technical detail `HANDOVER_22OCT_FIXES.md` mein hai. Code PR: https://github.com/Wayneesolutions/plotra-backend/pull/69

## 1. Pehle kya galat tha, ab kya hoga

| Pehle | Ab |
|---|---|
| Visitor seller bana to har message par owner wala reply aata tha, "hi" aur "plan" par bhi | "hi" par chhota jawab, "plan" par asli plan list, sawaal ka jawab alag |
| Agent ko purane plans dikhte the (Lite 3000, Growth 10000, Unlimited 20000) | Ab wahi plans dikhte hain jo Admin ke Plans tab aur website par hain |
| Seller tag hone ke baad "join" ya "main dealer hoon" kaam nahi karta tha | Ab turant dealer ban sakte hain. "menu" likhne par role kabhi bhi badal sakta hai |
| AI plan ke facts khud bana deta tha ("yearly par koi benefit nahi") | Yearly sawaal par fixed jawab: plans monthly hain, baaki team batayegi |
| Gurmukhi message ka jawab Roman mein aata tha | Jis script mein message, usi mein jawab |

## 2. Naya WhatsApp flow (Plotraa number par)

Pehle message par bot puchta hai: **1 Buyer, 2 Owner, 3 Dealer.** Andaza nahi lagata. Agar koi khud bol de ("main dealer hoon", "plot bechna hai"), to menu nahi aata.

- **Owner:** ek ek sawaal: type, size, location, price, photos (5 tak). Lead har jawab ke saath save hoti hai.
- **Buyer:** budget, area, type, size, phir search. Match na mile to "call" likhne par team call karegi.
- **Dealer:** naam, area, phir request team ko jaati hai. Pehle hi bata diya jaata hai: 7 din free trial, uske baad plan ka payment.
- Beech mein koi sawaal pooche ("plan kya hai?") to jawab milta hai aur wahi sawaal dobara poochha jaata hai.

## 3. Trial ab dikhta hai

- WhatsApp par "plan" ya "trial kab tak" likhne se end date aur din baaki dikhte hain.
- Dashboard ke liye data taiyaar hai (X din baaki). **Banner frontend mein lagana baaki hai.**
- Admin ke dealer list mein trial / paid / expired status aata hai (isko bhi frontend mein dikhana baaki hai).

## 4. Payment (Razorpay)

Dealer plan chunta hai to payment link milta hai. Payment hote hi plan apne aap chalu ho jaata hai, kisi ko approve nahi karna padta. Razorpay account Waynur ke saath share hai, isliye sirf wahi payments maane jaate hain jin par `plotraa` ka marker hai. Waynur ke payments ko ye code chhoota nahi.

Link na bane to purana tareeka chalta hai: QR ya receipt photo, jise admin approve karta hai.

## 5. WhatsApp templates

24 ghante ke baad free text nahi pahunchta, isliye welcome + password link, sub-dealer invite, forgot password, trial reminder/expiry, payment mila, aur lead alert ke liye **7 naye templates** chahiye. Unka exact text `docs/WHATSAPP_TEMPLATES.md` mein hai. Ab har template send ka Meta message id aur error save hota hai, aur Admin mein dekha ja sakta hai.

## 6. Aapko kya karna hai (order mein)

1. PR #69 review karke merge karein.
2. Server par: `git pull && npm ci && npm run migrate`
3. `.env` mein teen Razorpay values daalein: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`. Phir `pm2 restart all --update-env`.
4. Razorpay dashboard mein webhook banayein: `https://<api-host>/api/v1/webhooks/razorpay`, events: `payment_link.paid`, `payment_link.expired`, `payment_link.cancelled`.
5. Meta mein 7 templates banayein aur approve karwayein. Purane 3 templates ke variable count milaiye: support alert 3, call enquiry 3 + 1 button, re-engagement 1.
6. **DB backup lekar** purane converted dealers ke liye pehle dry run: `node scripts/repairConvertedDealers.js`, list theek lage to `--apply`. Isse unka 7 din ka trial shuru hota hai aur "DEALER_UNPAID" error hatta hai.
7. Frontend: dashboard banner + Pay now button, admin mein trial badge, Plans tab mein QR field.

## 7. Phone par ye test zaroor karein

- Naye number se "hi" likhein: menu aana chahiye.
- Owner bankar sab sawaal bharein, phir "hi" aur "plan" likhein: owner wala purana reply nahi aana chahiye.
- Owner ke baad "join" likhein: dealer ka flow shuru hona chahiye.
- Gurmukhi mein "ਪਲਾਨ" likhein: plan list Gurmukhi mein aani chahiye.
- Ek test dealer se plan chunein aur Razorpay se chhoti payment karein: plan chalu hona chahiye aur confirmation aani chahiye.
- Admin mein template sends dekhein: message id aur status dikhna chahiye.

## 8. Jo abhi pakka nahi hua

Laptop par local database, Redis aur nakli WhatsApp server ke saath sab test hua aur pass hua. Lekin asli Meta templates aur asli Razorpay payment abhi nahi chalaye (accounts chahiye). Pehli asli payment ke baad API log mein `[Razorpay]` lines dekhna.

Monthly reminders (day 28 par) abhi bhi sirf free text hain, template nahi.
