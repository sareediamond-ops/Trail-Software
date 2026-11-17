# Trail

Jewelry custody tracker. Every piece (one SKU = one physical piece) is always in exactly one state,
and every move between states is one desk entry confirmed by the other person's PIN.

- `public/` is the app (plain HTML, CSS and JavaScript, no build step).
- `supabase/schema.sql` is the whole database: tables, rules and the functions the app calls.
- `netlify/functions/admin-users.mjs` creates logins and resets passwords for admins.

## One-time setup

### 1. Supabase

1. Open the project, go to **SQL Editor**, paste the whole of `supabase/schema.sql`, and run it once.
2. Go to **Authentication** and turn off new user sign-ups. Accounts are created only from inside Trail.
3. Go to **Authentication, Users, Add user**. Create your own login (email and password) and tick
   auto-confirm. This login becomes the first admin.
4. Go to **Project Settings, API Keys** and copy the **secret** key (it starts with `sb_secret_`).
   Never put this key in the code, in chat or in GitHub.

### 2. Netlify

1. Import this repository as a new site. Leave the build command empty. The publish folder (`public`)
   and the functions folder are read from `netlify.toml`.
2. Under **Site configuration, Environment variables**, add `SUPABASE_SERVICE_KEY` with the secret key
   from step 1.4.
3. Trigger a new deploy so the function picks up the variable.

### 3. First login

1. Open the site and sign in with the login from step 1.3.
2. Trail shows "First-time setup". Enter your name. You are now the first admin. This works only once.
3. Under **Admin, Lists**, add the two factories.
4. Under **Admin, People & PINs**, add everyone who handles jewelry. Each person types their own PIN.
5. Under **Admin, Accounts**, create the other admin and staff logins.

## What is built

| Area | Status |
| --- | --- |
| Logins, staff and admin roles, account management | Built |
| People with PINs, factories, purposes | Built |
| New SKU with photo | Built |
| Incoming, outgoing, return, shipment handover | Built |
| Tracking ID (admin only) | Built |
| Morning locker check, end-of-day tally, send to locker | Built |
| Red cards, resolved by admins only | Built |
| Log viewer and full export | Built |
| Admin edit or delete of an entry, corrections | Database ready, screen not built yet |
| Desk handover tally during the day | Database ready, screen not built yet |

## Backups

The free Supabase plan has no backups. Use **Admin, Export** once a week and keep the file safe.
