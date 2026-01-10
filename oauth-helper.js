// Simple OAuth helper script
// Run: node oauth-helper.js

import { GoogleService } from "./dist/main/services/google.js";
import { readFileSync } from "fs";

async function main() {
  const googleService = new GoogleService();

  try {
    console.log("Getting OAuth URL...");
    const authUrl = await googleService.getAuthUrl();

    console.log("\n=== OAuth Authorization ===");
    console.log("1. Open this URL in your browser:");
    console.log(authUrl);
    console.log("\n2. Authorize the application");
    console.log("3. After authorization, you'll be redirected to a URL");
    console.log("4. Copy the 'code' parameter from the redirect URL");
    console.log("   Example: http://localhost/?code=4/0A...");
    console.log("\n5. Run this command with your code:");
    console.log("   node oauth-helper.js <YOUR_CODE>");
    console.log("\nOr if you already have the code, pass it as an argument:");

    const code = process.argv[2];
    if (code) {
      console.log(`\nProcessing code: ${code.substring(0, 20)}...`);
      const success = await googleService.handleOAuthCallback(code);
      if (success) {
        console.log("✅ OAuth successful! Token saved to token.json");
        console.log("You can now use Google services.");
      } else {
        console.log("❌ OAuth failed");
      }
    }
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

main();
