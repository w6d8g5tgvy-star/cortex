using './main.bicep'

param name = 'cortex'
param cosmosFreeTier = true            // set to false if this subscription already has a free-tier Cosmos DB account
param cosmosServerlessIfNoFreeTier = true
param skuName = 'B1'
param nodeVersion = '22-lts'
param keyVaultAdminObjectId = ''       // filled in by infra/setup-azure.sh (your user's object ID)
