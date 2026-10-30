import { RateLimitStore } from "./rate-limit-store";
import { config } from "./config";

/**
 * Shared Rate Limit Monitor
 *
 * This monitor reads rate limit data from a shared store,
 * allowing it to display real-time rate limit information
 * across all DuckAI processes.
 */
export class SharedRateLimitMonitor {
  private rateLimitStore: RateLimitStore;
  private monitoringInterval?: NodeJS.Timeout;

  constructor() {
    this.rateLimitStore = new RateLimitStore();
  }

  /**
   * Clean old timestamps outside the sliding window
   */
  private cleanOldTimestamps(timestamps: number[]): number[] {
    const now = Date.now();
    const cutoff = now - config.windowSizeMs;
    return timestamps.filter((timestamp) => timestamp > cutoff);
  }

  /**
   * Get current rate limit status from shared store
   */
  getCurrentStatus() {
    const stored = this.rateLimitStore.read();

    if (!stored) {
      // No data available, return default state
      return {
        requestsInCurrentWindow: 0,
        maxRequestsPerMinute: config.maxRequestsPerMinute,
        timeUntilWindowReset: config.windowSizeMs,
        isCurrentlyLimited: false,
        recommendedWaitTime: 0,
        utilizationPercentage: 0,
        timeUntilWindowResetMinutes: 1,
        recommendedWaitTimeSeconds: 0,
        dataSource: "default" as const,
        lastUpdated: null,
      };
    }

    const now = Date.now();
    let requestsInWindow: number;
    let timeUntilReset: number;

    // Handle both old and new formats
    if (stored.requestTimestamps) {
      // New sliding window format
      const cleanTimestamps = this.cleanOldTimestamps(stored.requestTimestamps);
      requestsInWindow = cleanTimestamps.length;

      // For sliding window, calculate when the oldest request will expire
      const oldestTimestamp = cleanTimestamps[0];
      timeUntilReset = oldestTimestamp
        ? Math.max(0, oldestTimestamp + config.windowSizeMs - now)
        : 0;
    } else {
      // Old fixed window format (backward compatibility)
      const windowElapsed = now - (stored.windowStart || 0);
      requestsInWindow = stored.requestCount || 0;
      timeUntilReset = config.windowSizeMs - windowElapsed;

      if (windowElapsed >= config.windowSizeMs) {
        requestsInWindow = 0;
        timeUntilReset = config.windowSizeMs;
      }
    }

    // Calculate recommended wait time
    const timeSinceLastRequest = now - stored.lastRequestTime;
    const recommendedWait = Math.max(
      0,
      config.minRequestIntervalMs - timeSinceLastRequest
    );

    const utilizationPercentage =
      (requestsInWindow / config.maxRequestsPerMinute) * 100;

    return {
      requestsInCurrentWindow: requestsInWindow,
      maxRequestsPerMinute: config.maxRequestsPerMinute,
      timeUntilWindowReset: Math.max(0, timeUntilReset),
      isCurrentlyLimited: stored.isLimited,
      recommendedWaitTime: recommendedWait,
      utilizationPercentage,
      timeUntilWindowResetMinutes: Math.ceil(
        Math.max(0, timeUntilReset) / 60000
      ),
      recommendedWaitTimeSeconds: Math.ceil(recommendedWait / 1000),
      dataSource: "shared" as const,
      lastUpdated: new Date(stored.lastUpdated).toISOString(),
      processId: stored.processId,
      windowType: stored.requestTimestamps ? "sliding" : "fixed",
    };
  }

  /**
   * Print current rate limit status to console
   */
  printStatus(clearConsole: boolean = false) {
    if (clearConsole) {
      // Clear console for cleaner monitoring display
      console.clear();
    }

    const status = this.getCurrentStatus();

    const windowTypeIcon =
      (status as any).windowType === "sliding" ? "🔄" : "⏰";
    const windowTypeText =
      (status as any).windowType === "sliding"
        ? "Sliding Window"
        : "Fixed Window";

    console.log(`\n🔍 DuckAI Rate Limit Status (${windowTypeText}):`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(
      `📊 Requests in current window: ${status.requestsInCurrentWindow}/${status.maxRequestsPerMinute}`
    );
    console.log(`📈 Utilization: ${status.utilizationPercentage.toFixed(1)}%`);

    if ((status as any).windowType === "sliding") {
      console.log(
        `${windowTypeIcon} Next request expires in: ${status.timeUntilWindowResetMinutes} minutes`
      );
    } else {
      console.log(
        `${windowTypeIcon} Window resets in: ${status.timeUntilWindowResetMinutes} minutes`
      );
    }

    console.log(
      `🚦 Currently limited: ${status.isCurrentlyLimited ? "❌ Yes" : "✅ No"}`
    );

    if (status.recommendedWaitTimeSeconds > 0) {
      console.log(
        `⏳ Recommended wait: ${status.recommendedWaitTimeSeconds} seconds`
      );
    }

    // Data source info
    if (status.dataSource === "shared" && status.lastUpdated) {
      const updateTime = new Date(status.lastUpdated).toLocaleTimeString();
      console.log(`📡 Data from: Process ${status.processId} at ${updateTime}`);
    } else {
      console.log(`📡 Data source: ${status.dataSource} (no active processes)`);
    }

    // Visual progress bar
    const barLength = 20;
    const filledLength = Math.round(
      (status.utilizationPercentage / 100) * barLength
    );
    const bar = "█".repeat(filledLength) + "░".repeat(barLength - filledLength);
    console.log(
      `📊 Usage: [${bar}] ${status.utilizationPercentage.toFixed(1)}%`
    );
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  }

  /**
   * Print compact rate limit status for server console
   */
  printCompactStatus() {
    const status = this.getCurrentStatus();
    const windowType = (status as any).windowType === "sliding" ? "🔄" : "⏰";
    const limitIcon = status.isCurrentlyLimited ? "❌" : "✅";

    console.log(
      `${windowType} Rate Limit: ${status.requestsInCurrentWindow}/${status.maxRequestsPerMinute} (${status.utilizationPercentage.toFixed(1)}%) ${limitIcon}`
    );
  }

  /**
   * Start continuous monitoring (prints status every interval)
   */
  startMonitoring(intervalSeconds: number = 30) {
    console.log(
      `🔄 Starting shared rate limit monitoring (every ${intervalSeconds}s)...`
    );
    console.log(`📁 Store location: ${this.rateLimitStore.getStorePath()}`);
    this.printStatus();

    this.monitoringInterval = setInterval(() => {
      this.printStatus(true); // Clear console for each update
    }, intervalSeconds * 1000);
  }

  /**
   * Stop continuous monitoring
   */
  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
      console.log("⏹️  Shared rate limit monitoring stopped.");
    }
  }

  /**
   * Get recommendations for optimal usage
   */
  getRecommendations() {
    const status = this.getCurrentStatus();
    const recommendations: string[] = [];

    if (status.dataSource === "default") {
      recommendations.push(
        "ℹ️  No active DuckAI processes detected. Start making API calls to see real data."
      );
    }

    if (status.utilizationPercentage > 80) {
      recommendations.push(
        "⚠️  High utilization detected. Consider implementing request queuing."
      );
    }

    if (status.recommendedWaitTimeSeconds > 0) {
      recommendations.push(
        `⏳ Wait ${status.recommendedWaitTimeSeconds}s before next request.`
      );
    }

    if (status.isCurrentlyLimited) {
      recommendations.push(
        "🚫 Currently rate limited. Wait for window reset or implement exponential backoff."
      );
    }

    if (status.utilizationPercentage < 50 && status.dataSource === "shared") {
      recommendations.push(
        "✅ Good utilization level. You can safely increase request frequency."
      );
    }

    recommendations.push(
      "💡 Consider implementing request batching for better efficiency."
    );
    recommendations.push("🔄 Use exponential backoff for retry logic.");
    recommendations.push("📊 Monitor rate limits continuously in production.");

    return recommendations;
  }

  /**
   * Print recommendations
   */
  printRecommendations() {
    const recommendations = this.getRecommendations();

    console.log("\n💡 Rate Limit Recommendations:");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    recommendations.forEach((rec) => console.log(rec));
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  }

  /**
   * Clear the shared rate limit store
   */
  clearStore() {
    this.rateLimitStore.clear();
    console.log("🗑️  Shared rate limit store cleared.");
  }

  /**
   * Get store information
   */
  getStoreInfo() {
    const stored = this.rateLimitStore.read();
    return {
      storePath: this.rateLimitStore.getStorePath(),
      hasData: !!stored,
      data: stored,
    };
  }
}

// CLI usage for shared monitoring
const isDirectRun =
  typeof require !== "undefined" &&
  typeof module !== "undefined" &&
  require.main === module;

if (isDirectRun) {
  const monitor = new SharedRateLimitMonitor();

  // Parse command line arguments
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "status":
      monitor.printStatus();
      monitor.printRecommendations();
      break;

    case "monitor":
      const interval = parseInt(args[1]) || 30;
      monitor.startMonitoring(interval);

      // Stop monitoring on Ctrl+C
      process.on("SIGINT", () => {
        monitor.stopMonitoring();
        process.exit(0);
      });
      break;

    case "clear":
      monitor.clearStore();
      break;

    case "info":
      const info = monitor.getStoreInfo();
      console.log("📁 Store Information:");
      console.log(`   Path: ${info.storePath}`);
      console.log(`   Has Data: ${info.hasData}`);
      if (info.data) {
        console.log(
          `   Last Updated: ${new Date(info.data.lastUpdated).toLocaleString()}`
        );
        console.log(`   Process ID: ${info.data.processId}`);
        console.log(`   Requests: ${info.data.requestCount}`);
      }
      break;

    default:
      console.log("🔍 DuckAI Shared Rate Limit Monitor");
      console.log("");
      console.log("This monitor reads rate limit data from a shared store,");
      console.log("showing real-time information across all DuckAI processes.");
      console.log("");
      console.log("Usage:");
      console.log(
        "  bun run src/shared-rate-limit-monitor.ts status                    # Show current status"
      );
      console.log(
        "  bun run src/shared-rate-limit-monitor.ts monitor [interval]       # Start monitoring (default: 30s)"
      );
      console.log(
        "  bun run src/shared-rate-limit-monitor.ts clear                     # Clear stored data"
      );
      console.log(
        "  bun run src/shared-rate-limit-monitor.ts info                      # Show store info"
      );
      console.log("");
      console.log("Examples:");
      console.log("  bun run src/shared-rate-limit-monitor.ts status");
      console.log("  bun run src/shared-rate-limit-monitor.ts monitor 10");
      console.log("  bun run src/shared-rate-limit-monitor.ts clear");
      break;
  }
}
