// Cortex on Azure: App Service (Linux, B1) + Cosmos DB for NoSQL (free tier, no keys) + Key Vault (RBAC).
// Deploy into a dedicated resource group:
//   az group create -n rg-cortex -l westus2
//   az deployment group create -g rg-cortex -f infra/main.bicep -p infra/main.bicepparam
// Everything is reached with the Web App's managed identity: no database keys or passwords exist.
targetScope = 'resourceGroup'

@description('Azure region (defaults to the resource group\'s).')
param location string = resourceGroup().location

@description('Short name used in resource names.')
@maxLength(10)
param name string = 'cortex'

@description('Use the Cosmos DB free tier (1000 RU/s + 25 GB free). Only ONE account per subscription can have it; set false if it is already used.')
param cosmosFreeTier bool = true

@description('If the free tier is not available: true = serverless (pay per request, usually cents for one person); false = provisioned 400 RU/s.')
param cosmosServerlessIfNoFreeTier bool = true

@description('App Service plan size. B1 is the smallest with Always On.')
param skuName string = 'B1'

@description('Node.js version on App Service.')
param nodeVersion string = '22-lts'

@description('Object ID of the person who manages Key Vault secrets (you). Leave empty to skip.')
param keyVaultAdminObjectId string = ''

var suffix = uniqueString(resourceGroup().id)
var appName = 'app-${name}-${suffix}'
var kvName = take('kv-${name}-${suffix}', 24)
var cosmosName = 'cosmos-${name}-${suffix}'
var serverless = !cosmosFreeTier && cosmosServerlessIfNoFreeTier

// ---------------- App Service ----------------
resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'asp-${name}'
  location: location
  sku: { name: skuName, capacity: 1 }
  kind: 'linux'
  properties: { reserved: true }
}

resource app 'Microsoft.Web/sites@2023-12-01' = {
  name: appName
  location: location
  kind: 'app,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    siteConfig: {
      linuxFxVersion: 'NODE|${nodeVersion}'
      alwaysOn: true
      http20Enabled: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      healthCheckPath: '/healthz'
      appCommandLine: 'node bin/cortex.js serve'
      appSettings: [
        { name: 'CORTEX_STORE', value: 'cosmos' }
        { name: 'COSMOS_ENDPOINT', value: cosmos.properties.documentEndpoint }
        { name: 'COSMOS_DATABASE', value: 'cortex' }
        { name: 'CORTEX_OWNER_SETUP_CODE', value: '@Microsoft.KeyVault(VaultName=${kvName};SecretName=cortex-owner-setup-code)' }
        { name: 'CORTEX_CONNECTOR_TOKEN', value: '@Microsoft.KeyVault(VaultName=${kvName};SecretName=cortex-connector-token)' }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'false' } // no npm install needed: Cortex has no dependencies
        { name: 'WEBSITE_RUN_FROM_PACKAGE', value: '1' }
      ]
    }
  }
}

resource scmBasicAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: app
  name: 'scm'
  properties: { allow: false } // deploys use Entra ID (GitHub OIDC), never publish-profile passwords
}

resource ftpBasicAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: app
  name: 'ftp'
  properties: { allow: false }
}

// ---------------- Cosmos DB (NoSQL) ----------------
resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' = {
  name: cosmosName
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    enableFreeTier: cosmosFreeTier
    disableLocalAuth: true // no keys: only Entra ID (managed identity)
    minimalTlsVersion: 'Tls12'
    consistencyPolicy: { defaultConsistencyLevel: 'Session' }
    locations: [ { locationName: location, failoverPriority: 0, isZoneRedundant: false } ]
    capabilities: serverless ? [ { name: 'EnableServerless' } ] : []
    backupPolicy: { type: 'Continuous', continuousModeProperties: { tier: 'Continuous7Days' } }
  }
}

resource db 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-05-15' = {
  parent: cosmos
  name: 'cortex'
  properties: {
    resource: { id: 'cortex' }
    // free tier: exactly the free 1000 RU/s shared by the database; serverless: no throughput setting
    options: serverless ? {} : { throughput: cosmosFreeTier ? 1000 : 400 }
  }
}

resource vaultContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: db
  name: 'vault'
  properties: {
    resource: {
      id: 'vault'
      partitionKey: { paths: [ '/area' ], kind: 'Hash' }
      indexingPolicy: { indexingMode: 'consistent', includedPaths: [ { path: '/path/?' }, { path: '/area/?' } ], excludedPaths: [ { path: '/*' } ] } // file data isn't indexed: cheaper writes
    }
  }
}

// Web App identity → Cosmos DB Built-in Data Contributor (data-plane role, read/write documents)
resource cosmosDataRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = {
  parent: cosmos
  name: guid(cosmos.id, app.id, 'data-contributor')
  properties: {
    roleDefinitionId: '${cosmos.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'
    principalId: app.identity.principalId
    scope: cosmos.id
  }
}

// ---------------- Key Vault ----------------
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 30
    publicNetworkAccess: 'Enabled'
  }
}

var kvSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'    // Key Vault Secrets User
var kvSecretsOfficer = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7' // Key Vault Secrets Officer

resource appKvRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: kv
  name: guid(kv.id, app.id, kvSecretsUser)
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsUser), principalId: app.identity.principalId, principalType: 'ServicePrincipal' }
}

resource adminKvRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(keyVaultAdminObjectId)) {
  scope: kv
  name: guid(kv.id, keyVaultAdminObjectId, kvSecretsOfficer)
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsOfficer), principalId: keyVaultAdminObjectId, principalType: 'User' }
}

output appName string = app.name
output appUrl string = 'https://${app.properties.defaultHostName}'
output keyVaultName string = kv.name
output cosmosEndpoint string = cosmos.properties.documentEndpoint
output appPrincipalId string = app.identity.principalId
