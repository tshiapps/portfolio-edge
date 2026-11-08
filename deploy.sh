#!/bin/zsh
# First-time setup + deploy for tonyshi.photos. Same credentials as friends-vpn-portal's ./cf:
# CF_TONYSHIPHOTOS_API_TOKEN + CF_TONYSHIPHOTOS_ACCOUNT_ID from ~/.zshrc. Never wrangler's saved login.
source ~/.zshrc 2>/dev/null
set -e
cd "${0:A:h}"

if [[ -z "$CF_TONYSHIPHOTOS_API_TOKEN" || -z "$CF_TONYSHIPHOTOS_ACCOUNT_ID" ]]; then
  echo "Set CF_TONYSHIPHOTOS_API_TOKEN and CF_TONYSHIPHOTOS_ACCOUNT_ID in ~/.zshrc first." >&2
  exit 1
fi
export CLOUDFLARE_API_TOKEN="$CF_TONYSHIPHOTOS_API_TOKEN"
export CLOUDFLARE_ACCOUNT_ID="$CF_TONYSHIPHOTOS_ACCOUNT_ID"
W=(npx wrangler)
step() { print -P "\n%B== $*%b"; }

step "Account check (must be the tonyshi.photos account: $CLOUDFLARE_ACCOUNT_ID)"
$W whoami

step "D1 database"
DB_ID="$($W d1 list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s).find(x=>x.name==="tonyshi-photos");process.stdout.write(d?d.uuid:"")})')"
if [[ -z "$DB_ID" ]]; then
  $W d1 create tonyshi-photos
  DB_ID="$($W d1 list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(JSON.parse(s).find(x=>x.name==="tonyshi-photos").uuid)})')"
fi
echo "database_id = $DB_ID"
sed -i '' -E "s/^database_id = \"[^\"]*\"/database_id = \"$DB_ID\"/" wrangler.toml

step "R2 bucket"
if $W r2 bucket list 2>/dev/null | grep -qE '(^|[[:space:]])tonyshi-photos$'; then echo "exists"; else $W r2 bucket create tonyshi-photos; fi

step "Schema migrations"
$W d1 migrations apply tonyshi-photos --remote

step "Deploy Worker (tonyshi.photos + www)"
$W deploy

step "Secrets"
EXISTING="$($W secret list --format json 2>/dev/null || echo '[]')"
if [[ "$EXISTING" == *'"ENCRYPTION_KEY"'* ]]; then
  echo "ENCRYPTION_KEY already set — leaving it (changing it would orphan saved Flickr tokens)"
else
  openssl rand -hex 32 | $W secret put ENCRYPTION_KEY
fi
if [[ "$EXISTING" == *'"ADMIN_PASSWORD"'* ]]; then
  echo "ADMIN_PASSWORD already set"
else
  read -rs "PW?Choose an admin password (user is 'admin'): "; echo
  print -rn -- "$PW" | $W secret put ADMIN_PASSWORD
fi

step "Done"
cat <<MSG
Admin:            https://tonyshi.photos/admin/   (user: admin)
Flickr callback:  https://tonyshi.photos/admin/flickr/callback   <- set this on your Flickr app
Next deploys:     npm run deploy
MSG
