import { createClerkClient } from "@clerk/backend";

if (!process.env.CLERK_SECRET_KEY) {
  console.error("❌ CLERK_SECRET_KEY is required");
  process.exit(1);
}

export const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});
