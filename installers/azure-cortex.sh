#!/bin/bash
# Cortex on Azure: run this in Azure Cloud Shell (portal.azure.com → the >_ icon at the top → Bash). Nothing to install.
#   curl -fsSL https://raw.githubusercontent.com/w6d8g5tgvy-star/cortex/main/installers/azure-cortex.sh | bash
# It creates ONE small Ubuntu VM (Standard_B1s, the size included in Azure's free account for 12 months), opens no
# ports except SSH (Tailscale Funnel gives the https address without opening any), then runs the Cortex server
# installer on it. It shows what it will create and asks before creating anything.
set -e
ask() { local q="$1" d="$2" a; read -r -p "$q" a </dev/tty || true; echo "${a:-$d}"; }
command -v az >/dev/null || { echo "Run this in Azure Cloud Shell (portal.azure.com → >_ → Bash)."; exit 1; }
az account show >/dev/null 2>&1 || az login
SUB=$(az account show --query name -o tsv)
RG=$(ask "Resource group name [cortex-rg]: " "cortex-rg")
LOC=$(ask "Region [eastus]: " "eastus")
VM=$(ask "VM name [cortex-cloud]: " "cortex-cloud")
SIZE=$(ask "VM size [Standard_B1s] (free-account size): " "Standard_B1s")
echo
echo "About to create in subscription \"$SUB\":"
echo "  resource group $RG ($LOC), Ubuntu 24.04 VM $VM ($SIZE), 30 GB disk, SSH only."
echo "  Cost: covered by the Azure free account for 12 months if you use a free-account size; otherwise billed by Azure."
echo "  Check https://azure.microsoft.com/pricing/free-services before continuing. Cortex creates nothing else."
[ "$(ask "Create it? [y/N] " "n")" = "y" ] || { echo "Nothing created."; exit 0; }
az group create -n "$RG" -l "$LOC" -o none
az vm create -g "$RG" -n "$VM" --image Ubuntu2404 --size "$SIZE" --os-disk-size-gb 30 \
  --admin-username cortex --generate-ssh-keys --public-ip-sku Standard --nsg-rule SSH -o none
IP=$(az vm show -d -g "$RG" -n "$VM" --query publicIps -o tsv)
echo "VM ready at $IP. Installing Cortex on it (answer its questions below)..."
sleep 20
ssh -t -o StrictHostKeyChecking=accept-new "cortex@$IP" \
  'curl -fsSL https://raw.githubusercontent.com/w6d8g5tgvy-star/cortex/main/installers/install-cortex-server.sh -o /tmp/cx.sh && bash /tmp/cx.sh'
echo
echo "Done. To reconnect later: ssh cortex@$IP (from Cloud Shell)."
echo "To remove everything (stops all Azure charges for it): az group delete -n $RG"
