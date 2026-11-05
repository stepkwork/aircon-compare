# Deploying to Cloudflare Workers + D1

The Worker serves the static site from `public/`, serves `/` as `aircon.html`,
and exposes the comparison-data API. D1 stores admin edits; the admin password
and signing secret are Cloudflare Worker secrets, not frontend code.

## One-time setup

1. In Cloudflare, create a D1 database named `aircon-compare`.
2. Copy its database ID into `database_id` in `wrangler.jsonc`.
3. In the repository root, run the schema and first deploy:

   ```sh
   npx wrangler login
   npx wrangler d1 execute aircon-compare --remote --file=cloudflare/schema.sql
   npx wrangler deploy
   ```

4. Add the secrets to the deployed Worker:

   ```sh
   npx wrangler secret put ADMIN_PASSWORD
   npx wrangler secret put SESSION_SECRET
   ```

   Use a strong, unique admin password. The previous admin password was embedded
   in the public frontend, so do not reuse it. For `SESSION_SECRET`, generate a
   separate random value with at least 32 bytes of entropy. Enter each value
   only at the Wrangler prompt; do not put secrets in Git or `wrangler.jsonc`.

5. Deploy once more so the Worker picks up the secrets:

   ```sh
   npx wrangler deploy
   ```

## GitHub auto-deploy

The included `.github/workflows/deploy-cloudflare.yml` deploys on pushes to
`main`. Add these GitHub repository secrets under **Settings → Secrets and
variables → Actions**:

- `CLOUDFLARE_API_TOKEN`: a Cloudflare API token with Account permissions for
  Workers Scripts: Edit and D1: Edit (plus Account Settings: Read if required
  by your account's token setup).
- `CLOUDFLARE_ACCOUNT_ID`: your Cloudflare account ID.

After creating D1, keep its database ID in `wrangler.jsonc`; that ID is not a
secret. Run the schema command once for each new environment/database.
The admin dashboard's English-to-Chinese translation for selling points and
additional features uses the Cloudflare Workers AI binding configured in
`wrangler.jsonc` and the `@cf/meta/m2m100-1.2b` translation model. Requests are sent only
when an admin clicks **Translate from English** and count toward the Cloudflare
account's Workers AI usage.
Once deployed, attach your existing domain to the Worker in Cloudflare if you
want the site on that domain instead of the default `workers.dev` address. If
the domain is currently attached to a Pages project, remove it there before
assigning that same hostname to the Worker.

## What persists

The first successful admin save writes the brand descriptions, model catalog,
and specifications to D1. Use the site's Admin panel to add, edit, or delete
brands and series, and to update model specifications. Later visits load those
saved changes from D1. Changes made to the built-in catalog in
`public/aircon.html` do not overwrite existing D1 data.
