#!/bin/bash
# One-time setup of Cortex on Azure. Run in Azure Cloud Shell (portal.azure.com → >_ → Bash) from a clone of the repo:
#   git clone https://github.com/w6d8g5tgvy-star/cortex && cd cortex && bash infra/setup-azure.sh
# It creates (after asking): resource group, App Service (B1), Cosmos DB, Key Vault and their access rules; the two
# Cortex secrets in Key Vault; and a GitHub deploy identity (OIDC, no stored password) limited to this resource group.
set -euo pipefail
ask() { local q="$1" d="$2" a; read -r -p "$q" a </dev/tty || true; echo "${a:-$d}"; }
RG=$(ask "Resource group [rg-cortex]: " "rg-cortex")
LOC=$(ask "Region [westus2]: " "westus2")
REPO=$(ask "GitHub repository that deploys it [w6d8g5tgvy-star/cortex]: " "w6d8g5tgvy-star/cortex")
SUB_ID=$(az account show --query id -o tsv); SUB_NAME=$(az account show --query name -o tsv); TENANT=$(az account show --query tenantId -o tsv)
ME=$(az ad signed-in-user show --query id -o tsv)
FREE=true
if [ -n "$(az cosmosdb list --query "[?enableFreeTier].name" -o tsv 2>/dev/null)" ]; then
  FREE=false; echo "This subscription already has a free-tier Cosmos DB account: the new one will be serverless (pay per request, usually cents for one person)."
fi
echo
echo "About to create in \"$SUB_NAME\" ($LOC): resource group $RG with App Service plan B1 (about \$13/month),"
echo "a Web App, Cosmos DB (free tier: $FREE), Key Vault, and a GitHub deploy identity for $REPO (Website Contributor on $RG only)."
[ "$(ask "Continue? [y/N] " "n")" = "y" ] || { echo "Nothing created."; exit 0; }

az group create -n "$RG" -l "$LOC" -o none
OUT=$(az deployment group create -g "$RG" -f infra/main.bicep -p infra/main.bicepparam -p cosmosFreeTier=$FREE keyVaultAdminObjectId="$ME" --query properties.outputs -o json)
APP=$(echo "$OUT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["appName"]["value"])')
URL=$(echo "$OUT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["appUrl"]["value"])')
KV=$(echo "$OUT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["keyVaultName"]["value"])')

echo "Adding Cortex's secrets to Key Vault (waiting for access to apply)..."
OWNER_CODE=$(python3 -c 'import secrets;print("CX-"+secrets.token_urlsafe(18))')
CONNECTOR=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')
for i in $(seq 1 30); do
  if az keyvault secret set --vault-name "$KV" -n cortex-owner-setup-code --value "$OWNER_CODE" -o none 2>/dev/null; then break; fi; sleep 10
done
az keyvault secret set --vault-name "$KV" -n cortex-connector-token --value "$CONNECTOR" -o none

echo "Creating the GitHub deploy identity (OIDC)..."
APP_ID=$(az ad app create --display-name "cortex-github-deploy" --query appId -o tsv)
az ad sp create --id "$APP_ID" -o none 2>/dev/null || true
az ad app federated-credential create --id "$APP_ID" --parameters "{\"name\":\"github-main\",\"issuer\":\"https://token.actions.githubusercontent.com\",\"subject\":\"repo:$REPO:ref:refs/heads/main\",\"audiences\":[\"api://AzureADTokenExchange\"]}" -o none 2>/dev/null || true
for i in $(seq 1 12); do
  az role assignment create --assignee "$APP_ID" --role "Website Contributor" --scope "/subscriptions/$SUB_ID/resourceGroups/$RG" -o none 2>/dev/null && break; sleep 10
done
az webapp restart -g "$RG" -n "$APP" -o none

cat <<DONE

Done. Two last steps:

1. In GitHub, open https://github.com/$REPO/settings/variables/actions and add these repository VARIABLES
   (they aren't secrets; GitHub signs in to Azure with a short-lived token):
     AZURE_CLIENT_ID        $APP_ID
     AZURE_TENANT_ID        $TENANT
     AZURE_SUBSCRIPTION_ID  $SUB_ID
     AZURE_WEBAPP_NAME      $APP
   Then run the "Deploy to Azure" workflow (Actions tab → Deploy to Azure → Run workflow).

2. After it deploys, open $URL/pair on your phone and enter this one-time OWNER code:
     $OWNER_CODE
   (It's also in Key Vault as cortex-owner-setup-code. It only works for the first owner.)

Your Cortex: $URL
Remove everything later: az group delete -n $RG  (and delete the app registration "cortex-github-deploy")
DONE
