module.exports = {
  apps: [
    { name: 'api',                 script: 'src/server.js' },
    { name: 'worker-geo',          script: 'src/workers/geoEnrichmentWorker.js' },
    { name: 'worker-landmark',     script: 'src/workers/landmarkWorker.js' },
    { name: 'worker-vocallm',      script: 'src/workers/vocallmWorker.js' },
    { name: 'worker-whatsapp',     script: 'src/workers/whatsappOutboundWorker.js' },
    { name: 'worker-intake',       script: 'src/workers/agentIntakeWorker.js' },
    { name: 'worker-localintel',   script: 'src/workers/localIntelligenceWorker.js' },
    { name: 'worker-builderdd',    script: 'src/workers/builderDueDiligenceWorker.js' },
    { name: 'worker-wayneRing',    script: 'src/workers/wayneRingCallSyncWorker.js' },
    { name: 'worker-agentSignup',  script: 'src/workers/agentSignupWorker.js' },
  ]
}
