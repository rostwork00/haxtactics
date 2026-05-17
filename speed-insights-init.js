/**
 * Speed Insights initialization using @vercel/speed-insights package
 * This file imports and initializes Vercel Speed Insights for tracking web vitals
 */
import { injectSpeedInsights } from '/vendor/speed-insights.mjs';

// Initialize Speed Insights
// This will inject the tracking script and start collecting web vitals
injectSpeedInsights({
  debug: false, // Set to true to enable debug logging during development
  // sampleRate: 1, // Send 100% of events (default). Use 0.5 for 50%, etc.
  // beforeSend: (event) => event, // Optional middleware to modify events before sending
});

console.log('[Speed Insights] Initialized via @vercel/speed-insights package');
